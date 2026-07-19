# Monad RND deployment and verification

## Supported baseline

This repository has been verified only against **Monad Testnet, chain ID
`10143`** (`0x279f`). The supported public deployment artifact is
`public/contracts/PlatformRandomness.json`.

The artifact currently publishes this exact `PlatformRandomness` runtime hash:

```text
0x9b6bf6ae53e215ac89420c58ede612b423963c8876e5bfdf8df8b6db59d1c4ce
```

That value is the `runtimeBytecodeHash` exported by the current build. Read it
from the checked-out JSON again during every release; do not copy it from an
old manifest or deployment.

The current review is an internal repository review, not an external audit.
Mainnet adoption is outside this verified baseline and needs fresh
network/RPC/EIP-2935 verification, a reproducible build for the intended
network, an updated threat model, and an appropriate independent security
review. Do not carry Testnet endpoints, chain assumptions, runtime hashes, or
security conclusions into mainnet by default.

## Before deployment

Complete these steps with a second reviewer before a signer is asked to
broadcast anything:

1. Pin the full source commit that will be deployed and start from a clean
   checkout. Do not deploy from an unrecorded local edit.
2. Run the Solidity tests, regenerate the public artifact with
   `npm run contracts:export`, and confirm that regeneration creates no
   unexpected source or artifact change.
3. Read `compilerVersion`, `bytecode`, `runtimeBytecode`, and
   `runtimeBytecodeHash` from the newly generated
   `public/contracts/PlatformRandomness.json`.
4. Approve the nonzero owner or multisig, `platformName`, `requestPrice`, and
   `maxPending`. `requestPrice` is in wei and must fit `uint96`.
   `maxPending == 0` rejects every Tx1.
5. Decide which application address will be recorded as the requester. If a
   wrapper sends Tx1, that wrapper—not the player's EOA—is the requester and
   must forward requester-window Tx2.
6. Check the deployment RPC with `eth_chainId`, a `finalized` block read,
   `debug_getRawHeader`, and an EIP-2935 historical-hash lookup. Fund the
   deployment signer with its own Testnet MON.
7. Dry-run or simulate the deployment and record the expected constructor
   arguments, gas limit, signer, and signer nonce in the change ticket.
8. Prepare a blank deployment manifest. The address is only a candidate until
   chain, code, approval, ownership, settings, source, and a canary have each
   passed their separate checks.

Never place a private key, seed phrase, RPC credential, or explorer API token
in this repository, a command history shared with others, or the deployment
manifest.

## Choose direct deployment or Factory

| Path | Choose it when | Important consequence |
| --- | --- | --- |
| Direct deployment | The team wants the shortest path from the published artifact to one isolated platform instance. | The constructor receives the approved owner explicitly, and no Factory address has to be trusted. |
| Factory deployment | The team has reviewed and operates its own `RandomnessFactory`, or repeatedly deploys instances through a controlled Factory workflow. | `deployPlatform` makes its caller the new platform owner. The Factory address, code, caller, event, and resulting platform must all be verified. |

Direct deployment is the simplest path for the current release because the
public JSON artifact contains the ABI and creation bytecode for
`PlatformRandomness`.

Factory deployment is optional. There is no canonical Factory that an
integrator must use. The current public JSON artifact covers
`PlatformRandomness` only; until a Factory artifact is published, a team using
Factory must build `RandomnessFactory` from the pinned source and independently
verify its source and runtime code.

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
    approvedOwner,
    "Example platform",
    0n,       // requestPrice in wei
    1_000n,   // maxPending chosen from tested operating capacity
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
ticket. After inclusion, wait until the receipt block is covered by the RPC's
`finalized` block tag. Record the transaction, block, and candidate contract
address; do not yet publish it as the approved address.

## Factory deployment

Use this path only after the Factory itself has passed a source and bytecode
review:

1. Build `contracts/src/RandomnessFactory.sol` from the pinned commit with the
   recorded compiler and build profile.
2. Deploy that build with the repository's optional
   `contracts/script/Deploy.s.sol`, or an equivalently reviewed deployment
   process. The repository script reads `DEPLOYER_PRIVATE_KEY` from the local
   process environment and deploys only the ownerless Factory.
3. Verify the Factory's chain, deployment transaction, runtime code, and
   published explorer source before using it.
4. From the account that must become the platform owner, call
   `deployPlatform(platformName, requestPrice, maxPending)`.
5. Decode `PlatformDeployed` from the confirmed receipt. Check the emitting
   Factory, `platform`, `platformOwner`, name, price, and cap. Never guess the
   new address from a counter or an unconfirmed simulation.
6. Confirm that `platformOwner` equals the intended owner and that the platform
   address contains the published `PlatformRandomness` runtime code.
7. Apply every remaining manifest, approval, source-verification, and canary
   step in this guide to the new platform instance.

The Factory retains no ownership of the instance. A call from the wrong account
therefore creates an instance with the wrong owner; do not approve that
instance merely because its runtime hash is correct.

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
owner: "0x2222222222222222222222222222222222222222"
platformName: "Example platform"
requestPriceWei: "0"
maxPending: "1000"
requestsPaused: false
runtimeHash: "0x9b6bf6ae53e215ac89420c58ede612b423963c8876e5bfdf8df8b6db59d1c4ce"
sourceCommit: "<full 40-character commit used for deployment>"
compilerVersion: "0.8.24+commit.e11b9ed9"
optimizerProfile: "disabled; runs metadata value 200"
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
   artifact. For this build, the required runtime hash is
   `0x9b6bf6ae53e215ac89420c58ede612b423963c8876e5bfdf8df8b6db59d1c4ce`.
6. Repeat the read through an independently configured healthy RPC. Both
   endpoints must report the same finalized chain, address, and runtime code.
7. Save the raw `eth_chainId`, deployment receipt, `eth_getCode`, calculated
   hash, artifact hash, endpoint identities, and reviewer decision as
   deployment evidence.

A matching runtime hash proves that the address runs the same deployed code as
this artifact. It does **not** prove that the address is the instance approved
for the product, that it was deployed on the intended chain, or that its owner
and storage settings are correct.

## Verify approved address, owner, and settings

Use the candidate address directly, not an address copied from a UI, event
index, chat message, or DNS name:

1. Compare the candidate `platformAddress` with the governance/change-ticket
   address. Only after this check may the same value be written as
   `approvedAddress` and placed in application configuration.
2. Read `owner()` and compare it byte-for-byte with the approved owner or
   multisig. For Factory deployment, also compare it with
   `PlatformDeployed.platformOwner`.
3. Read `platformName()`, `requestPrice()`, `maxPending()`, and
   `requestsPaused()`. Compare each value with the manifest in its native unit;
   do not compare a rounded wallet display.
4. Read `protocolFee()` and require `0`. For a new unused instance, also
   investigate any unexpected `pendingCount()` or `nextRequestId()`.
5. Have a second reviewer repeat the address and read-only calls from the
   approved application configuration.
6. Sign the approval record only when address, owner, settings, code, source,
   and chain all agree.

Runtime equality cannot distinguish two separately deployed
`PlatformRandomness` instances. An attacker or an accidental deployment can
have the correct code but a different address, owner, price, cap, balance, and
request history. Code verification and approved-address verification are
therefore separate release gates.

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

1. Re-read chain ID, approved address, owner, `requestPrice`, `maxPending`, and
   pause state immediately before Tx1.
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

## Go live or discard the deployment

Go live only after every item below is true:

- the manifest pins chain ID `10143`, candidate address, approved address,
  deployment evidence, source commit, compiler profile, and verification URL;
- chain and runtime code match through two healthy RPCs;
- approved address, owner, name, price, cap, and pause state were independently
  read and approved;
- explorer source and the reproducible local build agree;
- the intended direct or wrapper Tx1 + Tx2 canary reached finalized success;
- funded requester-window, permissionless rescue, RPC failover, monitoring,
  expiry, and customer-support owners are assigned; and
- the product's value ceiling accepts the documented non-VRF security boundary
  and the level of security review is appropriate.

Discard the deployment for product use if it is on the wrong chain, has the
wrong or unverifiable code, differs from the approved address, has an
uncontrolled or unintended owner, has an incorrect immutable product identity,
cannot reproduce its source verification, lacks a compatible RPC path, or
fails the canary. A mutable price, cap, or pause-state correction may be made
only by the approved owner before launch, followed by the full setting review
again; if the change or its authority is in doubt, discard and redeploy.

“Discard” means: block new product requests, remove the address from every
allowlist and application configuration, mark its manifest rejected, preserve
all evidence, resolve any existing requests and funds under an incident plan,
and deploy a new candidate. Do not silently reuse an instance because its
runtime hash happens to match.
