# Monad RNG deployment and verification

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

## Supported baseline

At the start of the staged deployment process, only Monad Testnet, chain ID
`10143` (`0x279f`), is the validated baseline. Mainnet must remain blocked
until the exact release passes every Testnet test and canary in this guide.
After that, repeat the complete procedure against Monad Mainnet, chain ID
`143` (`0x8f`); never copy a Testnet address, RPC URL, receipt, or manifest
field into the Mainnet record.

The supported public deployment artifact is
`public/contracts/PlatformRandomness.json`. It publishes the current build's
`runtimeBytecodeHash`. Always read that value from the checked-out artifact
during the release; do not paste a hash from this guide, an earlier commit, or
another deployment.

The current review is an internal repository review, not an external audit.
Mainnet promotion needs fresh network, RPC, `debug_getRawHeader`, and EIP-2935
verification, a reproducible build, an updated threat model, and an
independent security review appropriate to the value at risk. A successful
Testnet transaction is a gate, not proof that Mainnet infrastructure works.

## Before deployment

Complete these steps with a second reviewer before a signer is asked to
broadcast anything:

1. Pin the full source commit that will be deployed and start from a clean
   checkout. Do not deploy from an unrecorded local edit.
2. Use the official Monad Foundry fork, record its full version and commit,
   and confirm `foundry.toml` enables the Solidity optimizer with 200 runs.
   This release uses Solidity `0.8.24`.
3. Run the Solidity tests, regenerate the public artifacts with
   `npm run contracts:export`, and confirm that regeneration creates no
   unexpected source or artifact change.
4. Read `compilerVersion`, `bytecode`, `runtimeBytecode`, and
   `runtimeBytecodeHash` from the newly generated
   `public/contracts/PlatformRandomness.json`.
5. Approve the nonzero `revenueRecipient`, `platformName`, `requestPrice`, and
   `maxPending`. `requestPrice` is in wei and must fit `uint96`.
   `maxPending == 0` means unlimited; a positive value is a permanent cap.
   Confirm that the revenue recipient can receive native MON.
6. Decide which application address will be recorded as the requester. If a
   wrapper sends Tx1, that wrapper—not the player's EOA—is the requester and
   must forward requester-window Tx2.
7. Check the deployment and application RPC paths with `eth_chainId`, a
   `finalized` block read, `debug_getRawHeader`, and an EIP-2935
   historical-hash lookup. Fund the deployment signer with MON for the selected
   network.
8. Dry-run or simulate the deployment and record the expected constructor
   arguments, gas limit, signer, and signer nonce in the change ticket.
9. Prepare a blank deployment manifest. The address is only a candidate until
   chain, code, approved address, fixed configuration, source, and a canary
   have each passed their separate checks.

V1 has no owner, admin, pause, proxy, upgrade, or setter functions. The
deployment signer only pays and broadcasts the transaction; it gains no
post-deployment authority. Every configuration value is permanent. A mistake
is a rejected deployment, not an admin repair.

Never place a private key, seed phrase, RPC credential, or explorer API token
in this repository, a command history shared with others, or the deployment
manifest.

## Choose direct deployment or Factory

| Path | Choose it when | Important consequence |
| --- | --- | --- |
| Direct deployment | The team wants the shortest path from the published artifact to one isolated platform instance. | The constructor receives the fixed revenue recipient and configuration explicitly; no Factory address has to be trusted. |
| Factory deployment | The team has reviewed its `RandomnessFactory`, or repeatedly deploys instances through a controlled Factory workflow. | `deployPlatform` receives the fixed recipient and configuration explicitly. Neither the Factory nor its caller controls the resulting platform. |

Direct deployment is the simplest path for the current release because the
public JSON artifact contains the ABI and creation bytecode for
`PlatformRandomness`.

Factory deployment is optional. There is no canonical Factory that an
integrator must use. The repository publishes
`public/contracts/RandomnessFactory.json` as well as the platform artifact.
A team using Factory must still pin the release, verify the Factory source and
runtime code, and verify every child platform's fixed configuration.

## Direct deployment

The following short Viem example uses the ABI and **creation bytecode** from the
published artifact. It assumes the team has already created a Testnet
`publicClient`, a secured `walletClient`, and the intended signer `account`.
Adjust the import path for the deployment program.

```ts
import type { Hex } from "viem";
import { monadTestnet } from "viem/chains";
import artifact from "../public/contracts/PlatformRandomness.json" with {
  type: "json",
};

function assertHex(value: string, label: string): asserts value is Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${label} must be non-empty, even-length 0x-prefixed hex`);
  }
}

assertHex(artifact.bytecode, "PlatformRandomness creation bytecode");
const creationBytecode = artifact.bytecode;

const [publicChainId, walletChainId] = await Promise.all([
  publicClient.getChainId(),
  walletClient.getChainId(),
]);
if (
  publicChainId !== monadTestnet.id ||
  walletChainId !== monadTestnet.id
) {
  throw new Error(
    `Wrong chain: expected ${monadTestnet.id}, ` +
      `public RPC reported ${publicChainId}, wallet reported ${walletChainId}`,
  );
}

const deploymentTransaction = await walletClient.deployContract({
  account,
  chain: monadTestnet,
  abi: artifact.abi,
  bytecode: creationBytecode,
  args: [
    approvedRevenueRecipient,
    "Example platform",
    0n,       // requestPrice in wei
    1_000n,   // fixed cap; use 0n only for intentionally unlimited mode
  ],
});

const receipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentTransaction,
});
if (receipt.status !== "success" || receipt.contractAddress === null) {
  throw new Error("PlatformRandomness deployment did not succeed");
}

console.log({
  deploymentTransaction,
  deploymentBlock: receipt.blockNumber,
  platformAddress: receipt.contractAddress,
});
```

The two `getChainId` calls check the actual public and wallet transports
immediately before signing. Supplying `chain: monadTestnet` also binds the
deployment action to Monad Testnet so Viem rejects a wallet on another chain.
The complete assertion helper validates the JSON string and narrows it to
Viem's `Hex` type before `deployContract`.

Before signing, compare all four constructor arguments with the approved change
ticket. Confirm that the fixed recipient is not merely the deployment wallet
unless that is the explicit revenue policy. After inclusion, wait until the
receipt block is covered by the RPC's `finalized` block tag. Record the
transaction, block, and candidate contract address; do not yet publish it as
the approved address.

## Factory deployment

Use this path only after the Factory itself has passed a source and bytecode
review:

1. Build `contracts/src/RandomnessFactory.sol` from the pinned commit with the
   recorded compiler and build profile.
2. Deploy that build with the repository's optional
   `contracts/script/Deploy.s.sol`, or an equivalently reviewed deployment
   process. The repository script reads only the public `DEPLOYER_ADDRESS`;
   requires an explicit `EXPECTED_CHAIN_ID`, and refuses a mismatched RPC.
   Supply signing authority through Foundry's encrypted `--keystore` flow,
   never a committed or command-line raw private key. The script deploys both
   the ownerless Factory and, through that Factory's `deployPlatform` function,
   a free, uncapped `"Monad RNG Public V1"` canary. Record and verify both
   addresses and decode the canary's `PlatformDeployed` event so the live
   release also proves the Factory creation path.
3. Verify the Factory's chain, deployment transaction, runtime code, and
   published explorer source before using it.
4. For an additional platform instance, call
   `deployPlatform(revenueRecipient, platformName, requestPrice, maxPending)`.
5. Decode `PlatformDeployed` from the confirmed receipt. Check the emitting
   Factory, `platform`, `revenueRecipient`, name, price, and cap. Never guess
   the new address from a counter or an unconfirmed simulation.
6. Confirm that the event recipient and every on-chain value equal the
   approved constructor configuration and that the platform address contains
   the published `PlatformRandomness` runtime code.
7. Apply every remaining manifest, approval, source-verification, and canary
   step in this guide to the new platform instance.

The Factory and caller retain no ownership or admin power. A wrong caller does
not gain control, but any deployment with wrong explicit arguments is still
permanently wrong. Do not approve it merely because its runtime hash is
correct.

## Create the deployment manifest

Create one immutable, reviewed deployment manifest per candidate instance.
Replace every placeholder with evidence from the finalized deployment and the
exact release build:

```yaml
networkName: "Monad Testnet"
chainId: 10143
platformAddress: "0x1111111111111111111111111111111111111111"
approvedAddress: "0x1111111111111111111111111111111111111111"
deploymentTransaction: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
deploymentBlock: 12345678
revenueRecipient: "0x2222222222222222222222222222222222222222"
platformName: "Example platform"
requestPriceWei: "0"
maxPending: "1000"
configurationMutable: false
runtimeHash: "<runtimeBytecodeHash from the release artifact>"
sourceCommit: "<full 40-character commit used for deployment>"
compilerVersion: "0.8.24+commit.e11b9ed9"
optimizerProfile: "enabled; runs 200"
verificationUrl: "https://testnet.monadscan.com/address/0x1111111111111111111111111111111111111111#code"
```

`platformAddress` is what the deployment produced. `approvedAddress` is what
the application, governance record, allowlist, and operators are authorized to
use after independent review. They must be identical before launch, but keeping
both fields records two different facts.

Store the review identity and approval timestamp next to the manifest. Preserve
superseded manifests rather than rewriting history, and mark rejected
deployments explicitly as rejected.

## Verify chain and bytecode

Verify the network and executable code independently:

1. Ask the same endpoint used by the application for `eth_chainId`. It must
   return `0x279f`, which is decimal chain ID `10143`.
2. Wait until the deployment receipt's block is included in the endpoint's
   `finalized` block.
3. Call `eth_getCode` for the candidate platform address at `finalized`.
   Reject `0x`, an RPC error, or code read from a different address.
4. Keccak-256 hash the returned runtime bytes exactly as returned after hex
   decoding. Do not hash the JSON quotes and do not use standardized SHA3-256.
5. Compare the result with `runtimeBytecodeHash` in the checked-out public
   artifact for the exact release commit.
6. Repeat the read through an independently configured healthy RPC. Both
   endpoints must report the same finalized chain, address, and runtime code.
7. Save the raw `eth_chainId`, deployment receipt, `eth_getCode`, calculated
   hash, artifact hash, endpoint identities, and reviewer decision as
   deployment evidence.

A matching runtime hash proves that the address runs the same deployed code as
this artifact. It does **not** prove that the address is approved for the
product, that it was deployed on the intended chain, or that its constructor
configuration is correct. V1 intentionally writes its configuration into
normal storage, so instances with different name, price, cap, and recipient
still have identical runtime bytecode.

## Verify approved address and frozen settings

Use the candidate address directly, not an address copied from a UI, event
index, chat message, or DNS name:

1. Compare the candidate `platformAddress` with the governance/change-ticket
   address. Only after this check may the same value be written as
   `approvedAddress` and placed in application configuration.
2. Read `revenueRecipient()` and compare it byte-for-byte with the approved
   recipient. For Factory deployment, also compare it with the
   `PlatformDeployed` event.
3. Read `platformName()`, `requestPrice()`, and `maxPending()`. Compare each
   value with the manifest in its native unit; do not compare a rounded wallet
   display. Confirm that zero cap was intentionally approved as unlimited.
4. Read `VERSION()` and require `1`, read `CONFIGURATION_LOCKED()` and require
   `true`, and read `protocolFee()` and require `0`. For a new unused instance,
   also investigate any unexpected `pendingCount()` or `nextRequestId()`.
5. Compare the published ABI and source to confirm that there is no owner,
   admin, pause, proxy, upgrade, recipient change, price setter, or cap setter.
6. Have a second reviewer repeat the address and read-only calls from the
   approved application configuration.
7. Sign the approval record only when address, frozen settings, code, source,
   and chain all agree.

Runtime equality cannot distinguish two separately deployed
`PlatformRandomness` instances. An attacker or an accidental deployment can
have the correct code but a different address, recipient, name, price, cap,
balance, and request history. Code verification, configuration verification,
and approved-address verification are therefore separate release gates.

## Run the two-RPC read-only attestation

After both deployment receipts are finalized, run the repository's automated
check. It sends no transaction, loads no private key, and writes no file. It
uses the lower of the two endpoints' finalized heights as one common audit
block, then verifies the canonical block hash, exact Platform and Factory
runtime bytes and hashes, permanent getters, V1 versions, zero protocol fee,
deployment signer, successful receipts, and the exact `PlatformDeployed`
event.

First run `npm run contracts:export` from the pinned release commit so both
public artifacts exist. Then provide public evidence only:

```bash
MONAD_NETWORK=testnet \
MONAD_EXPECTED_CHAIN_ID=10143 \
MONAD_RPC_URL_PRIMARY=https://testnet-rpc.monad.xyz \
MONAD_RPC_URL_SECONDARY=https://rpc-testnet.monadinfra.com \
MONAD_FACTORY_ADDRESS=0x... \
MONAD_PLATFORM_ADDRESS=0x... \
MONAD_EXPECTED_DEPLOYER=0x... \
MONAD_EXPECTED_REVENUE_RECIPIENT=0x... \
MONAD_EXPECTED_PLATFORM_NAME="Monad RNG Public V1" \
MONAD_EXPECTED_REQUEST_PRICE_WEI=0 \
MONAD_EXPECTED_MAX_PENDING=0 \
MONAD_FACTORY_DEPLOYMENT_TX_HASH=0x... \
MONAD_PLATFORM_DEPLOYMENT_TX_HASH=0x... \
npm run deployment:attest
```

For mainnet, change `MONAD_NETWORK` to `mainnet`, set the expected chain ID to
`143`, and use two independently operated mainnet RPCs. Optional
`MONAD_PLATFORM_ARTIFACT` and `MONAD_FACTORY_ARTIFACT` paths are resolved from
the repository root; by default the script uses the two JSON files under
`public/contracts/`. Never add a private key, mnemonic, keystore password, or
credential-bearing RPC URL to a deployment manifest. The report identifies
the endpoints only as `RPC A` and `RPC B`, so an RPC credential is not printed.

Treat a failure as a rejected deployment until the disagreement is explained.
Do not edit the expected values merely to make an unexpected deployment pass.

## Verify source on an explorer

Publish and verify the source for the platform address on the selected Monad
Testnet explorer:

1. Use the exact `PlatformRandomness.sol` and `MonadHeaderReader.sol` from the
   pinned source commit.
2. Select compiler `0.8.24+commit.e11b9ed9`, the recorded optimizer profile,
   and the build's EVM/compiler settings. Encode the exact direct-deployment
   constructor arguments when the explorer requires them.
3. Confirm that the explorer marks the candidate address's source as verified
   and shows the expected constructor, ABI, and address.
4. Open the verification URL independently and compare its displayed bytecode
   with the already checked on-chain runtime hash.
5. Save the permanent verification URL in the manifest.
6. If a Factory was used, verify the Factory source separately and link both
   addresses and both deployment transactions in the evidence.

Explorer verification improves transparency; it does not replace local
reproducible-build, runtime-hash, approved-address, or storage-setting checks.

## Run a canary Tx1 + Tx2

Use a low-value Testnet action on the exact candidate address:

1. Re-read chain ID, approved address, `revenueRecipient`, `platformName`,
   `requestPrice`, and `maxPending` immediately before Tx1.
2. Create one identifiable canary business record and submit Tx1 with the exact
   current `requestPrice`. If production will use a wrapper, run the canary
   through that wrapper.
3. Decode `RandomnessRequested` from the finalized Tx1 receipt. Verify the
   emitting platform, `requestId`, requester, request block `R`, target blocks
   `R+8`, `R+24`, and `R+40`, and price paid. For wrapper mode, the recorded
   requester must be the wrapper.
4. At or after `R+42`, retrieve all three canonical raw headers with a
   health-checked RPC's `debug_getRawHeader`. Preserve their exact RLP bytes
   and submit requester-window Tx2.
5. Wait until Tx2 is finalized. Require the `RandomnessFinalized` event result
   to equal `getRequest(requestId).result`, the stored result, exactly. Also
   verify the expected requester, finalizer, `finalized == true`, and
   `expired == false`. `bytes32(0)` is a valid cryptographic output, so never
   use a nonzero check as proof of finalization.
6. Call `draw(requestId, upperBound)` twice with the same valid bound and
   require the same in-range result. Do not use raw modulo in the product.
7. Confirm the application's journal, monitoring, settlement idempotency, RPC
   failover, and support view all point to this one request.
8. Preserve the canary Tx1, Tx2, events, raw headers, finalized observations,
   and result with the deployment evidence.

Before production value is enabled, separately rehearse the `R+104`
permissionless rescue path and the pre-approved expiry/customer policy on a
disposable Testnet request.

### Reproducible four-case Testnet rehearsal

The repository includes `npm run e2e:testnet -- <command>` only for the
canonical free canary created by `Deploy.s.sol`. It is deliberately hard-locked
to chain ID `10143`; it cannot be redirected to Mainnet. Initialization
requires the exact name `Monad RNG Public V1`, price `0`, cap `0`, and
`revenueRecipient == requester`. It also never accepts a raw private key,
mnemonic, or password value. Node performs public RPC checks, while Foundry
`cast` alone decrypts an encrypted keystore from a password-file **path**.

The tool creates a local `work/e2e/monad-testnet-v1.json` journal. The journal
contains only public addresses, blocks, transaction hashes, events, config,
and results, and `work/` is gitignored. Before every broadcast it first saves
an intent with the observed `nextRequestId` and exact sender nonce, then passes
that nonce to `cast`. The receipt event remains authoritative if another
address obtains an earlier request ID. The tool saves the transaction hash
immediately after broadcast. If the process stops between those steps, it
fails closed instead of guessing that a retry is safe.

Prepare two different funded Testnet addresses: the deployer/requester and the
rescuer. The requester must be the fixed recipient used by `Deploy.s.sol`.
Keep each encrypted keystore and password file outside the repository with
permissions `600`. Then set:

```bash
export MONAD_E2E_CONTRACT="<candidate PlatformRandomness address>"
export MONAD_E2E_REQUESTER_ADDRESS="<requester address>"
export MONAD_E2E_RESCUER_ADDRESS="<different rescuer address>"
export MONAD_E2E_REQUESTER_KEYSTORE="<absolute encrypted-keystore path>"
export MONAD_E2E_REQUESTER_PASSWORD_FILE="<absolute 600-mode password-file path>"
export MONAD_E2E_RESCUER_KEYSTORE="<absolute encrypted-keystore path>"
export MONAD_E2E_RESCUER_PASSWORD_FILE="<absolute 600-mode password-file path>"
```

Do not type a password into an environment variable. On macOS, a password
already held in Keychain can be placed into a temporary private file without
printing it. Keep shell tracing disabled, run `umask 077`, redirect
`security find-generic-password -w ...` into `mktemp`, and delete the file with
a shell `trap` as soon as the rehearsal ends.

Put the reviewed official Monad Foundry directory first in `PATH`, and record
`cast --version` before any live command. Use a fresh
`MONAD_E2E_STATE` path for every deployment; an existing journal intentionally
rejects a different contract or role pair.

Run the read-only initialization first:

```bash
npm run e2e:testnet -- init
npm run e2e:testnet -- status
```

Initialization requires exact runtime-bytecode equality with the exported
artifact and re-reads `VERSION == 1`, `CONFIGURATION_LOCKED == true`,
`protocolFee == 0`, recipient, name, price, and cap from a finalized block.
Every later invocation rechecks that frozen configuration.

Create one disposable Tx1 for each independent case:

```bash
npm run e2e:testnet -- request requester
npm run e2e:testnet -- request rescue
npm run e2e:testnet -- request historical
npm run e2e:testnet -- request expiry
```

Then call `status` and act only when its finalized block output says a case is
ready:

```bash
npm run e2e:testnet -- act requester
npm run e2e:testnet -- act rescue
npm run e2e:testnet -- act historical
npm run e2e:testnet -- act expiry
```

The cases are block-defined, never clock-defined:

| Case | Required finalized block | Signer and proof |
| --- | --- | --- |
| `requester` | `R+42` through `R+103` | The original requester submits Tx2 while the caller restriction is still active. The receipt must be included before `R+104`. |
| `rescue` | `R+104` or later | The different rescuer submits Tx2, proving the permissionless boundary. |
| `historical` | `R+297` or later | All three targets are at least 257 blocks old. The helper separately matches all three EIP-2935 history hashes before Tx2. |
| `expiry` | `R+8200` or later | The different rescuer calls `expireRequest`; no random result is expected. |

For every successful Tx2 the tool validates the finalized receipt, exact event
emitter and arguments, independently derives the seed from the three
authenticated `mixHash` values, compares it with permanent storage, and calls
`draw(requestId, 100)` twice for deterministic in-range output. It refuses to
start Tx2 inside the final 64 proof blocks. For expiry it verifies the event,
`expired == true`, `finalized == false`, and an empty finalizer.

Run only one command at a time, and do not use either signer concurrently from
another process. If `status` reports an intent without a transaction hash,
recover the sender nonce and transaction manually; never delete the journal or
blindly resend merely to make the test continue.

Use a dedicated, undisclosed canary until all four cases finish. After `R+104`,
any third party may legitimately finalize the `historical` or `expiry` request
before the planned action; that proves permissionless behavior but invalidates
that isolated rehearsal and requires a fresh deployment/request.

## Go live or discard the deployment

Go live only after every item below is true:

- the manifest pins chain ID `10143`, candidate address, approved address,
  deployment evidence, source commit, compiler profile, and verification URL;
- chain and runtime code match through two healthy RPCs;
- approved address, recipient, name, price, cap, and ownerless immutable
  interface were independently read and approved;
- explorer source and the reproducible local build agree;
- the intended direct or wrapper Tx1 + Tx2 canary reached finalized success;
- funded requester-window, permissionless rescue, RPC failover, monitoring,
  expiry, and customer-support owners are assigned; and
- the product's value ceiling accepts the documented non-VRF security boundary
  and the level of security review is appropriate.

Discard the deployment for product use if it is on the wrong chain, has the
wrong or unverifiable code, differs from the approved address, has an
incorrect recipient, name, price, or cap, exposes unexpected authority, cannot
reproduce its source verification, lacks a compatible raw-header RPC path, or
fails the canary. No field can be corrected in place. Reject it and deploy a
new candidate address.

“Discard” means: block new product requests, remove the address from every
allowlist and application configuration, mark its manifest rejected, preserve
all evidence, resolve any existing requests and funds under an incident plan,
and deploy a new candidate. Do not silently reuse an instance because its
runtime hash happens to match.

## Promote Testnet V1 to Mainnet V1

Mainnet is a separate release gate:

1. require the exact Testnet build to pass unit, fuzz, invariant, deployment,
   Tx1, Tx2, permanent-read, rescue, expiry, and revenue-withdrawal tests;
2. freeze the release commit and artifact; a source change restarts Testnet;
3. create a separate Mainnet manifest using chain ID `143`;
4. probe the selected Mainnet RPC for `eth_chainId`, `finalized`,
   `debug_getRawHeader`, EIP-2935 history, rate limits, and browser CORS if
   applicable;
5. estimate the actual deployment transaction, verify the signer address and
   nonce, and fund it only with the required operational margin;
6. deploy, wait for finalized inclusion, verify source, runtime code, approved
   address, and all frozen storage fields; and
7. run a minimal-value Mainnet Tx1 + Tx2 canary before routing product traffic.

The dedicated deployment wallet has no authority after broadcasting. Keep its
private key out of the repository and deployment manifest; publishing the
wallet address and finalized transactions is sufficient evidence.

## Replace V1 with V2

There is no proxy or in-place upgrade. If a defect or product change requires
V2, stop new V1 intake in applications and wrappers, deploy and verify a new
address, and switch only new business actions to V2. Continue operating Tx2,
rescue, reads, and expiry for every V1 request. V1 results, pending requests,
and balances stay at V1; they are not migrated automatically.
