# Monad RNG contract integration

Monad RNG is an MIT-licensed, zero-protocol-fee public good. Each integrating
platform deploys its own `PlatformRandomness` instance, chooses its own request
price and capacity policy, and names the address that receives its request
revenue.

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

V1 is deliberately ownerless and non-upgradeable. The constructor writes
`revenueRecipient`, `platformName`, `requestPrice`, and `maxPending` once.
There is no owner, administrator, pause, proxy, upgrade, ownership transfer, or
configuration setter. A deployment key pays gas but receives no special
authority. A wrong value or a future protocol change requires a new V2
contract address.

“Free” means the platform may set `requestPrice` to `0`. It does **not** mean
gasless: the sender of every deployment, Tx1, Tx2, expiry, and revenue sweep
pays Monad network gas unless the integrating platform separately sponsors
that sender. This repository has no treasury, relayer, keeper reward, server
wallet, gas reimbursement, or subsidy.

## 1. Choose an isolated deployment path

There are two supported paths:

1. **Direct deployment:** deploy the creation bytecode in
   `public/contracts/PlatformRandomness.json` with these constructor arguments:
   `(revenueRecipient, platformName, requestPrice, maxPending)`.
2. **Ownerless factory:** deploy `RandomnessFactory`, then call
   `deployPlatform(revenueRecipient, platformName, requestPrice, maxPending)`.
   The factory is nonpayable, collects no MON through normal calls, grants the
   caller no special rights, and has no owner, treasury, fee, configuration, or
   upgrade path. Do not send MON to its address: forced or prefunded MON has no
   withdrawal path.
   Discover deployments from its `PlatformDeployed` event.

The factory is optional. A frontend can deploy `PlatformRandomness` directly
and therefore does not depend on one canonical factory address.

The optional Foundry script deploys the ownerless Factory and one free,
uncapped public V1 canary:

```bash
DEPLOYER_ADDRESS="0xYourDeploymentAddress" \
EXPECTED_CHAIN_ID="10143" \
forge script \
  contracts/script/Deploy.s.sol:Deploy \
  --rpc-url https://testnet-rpc.monad.xyz \
  --sender "0xYourDeploymentAddress" \
  --keystore "/absolute/path/to/encrypted-keystore" \
  --broadcast
```

`DEPLOYER_ADDRESS` is public. Foundry asks for the encrypted keystore password
without putting a raw private key in the repository or command. Never commit a
keystore, password, private key, or seed phrase. The signer supplies its own
MON and pays deployment gas. The canary uses that address as its fixed revenue
recipient, but its request price is zero. After deployment the account cannot
alter or control the platform or Factory. `EXPECTED_CHAIN_ID` makes the script
revert before broadcasting if the RPC is connected to another chain.

Before deploying, verify all four permanent values:

- `revenueRecipient` must be the exact intended address and must be able to
  receive native MON;
- `platformName` is a permanent on-chain identity label;
- `requestPrice` is the exact wei amount every Tx1 must pay; and
- `maxPending == 0` means unlimited, while any positive value is a fixed local
  cap.

The configuration is stored in ordinary contract storage during construction
so independently deployed instances share the same runtime bytecode. Runtime
hash equality therefore proves the code, **not** the four values. Read and pin
each value at the approved address. V1 also exposes `VERSION() == 1` and
`CONFIGURATION_LOCKED() == true` as explicit integration assertions.

## 2. Bind the economic action before requesting randomness

For a demo, an account can call:

```solidity
uint256 requestId = platform.requestRandomness{value: platform.requestPrice()}();
```

For a gacha or prize with economic value, a platform wrapper should perform all
of the following in the same Tx1:

1. validate the player's eligibility;
2. take or irrevocably lock payment;
3. reserve the exact inventory or prize rule;
4. call `requestRandomness`;
5. store exactly one returned `requestId` against that entry;
6. forbid cancellation, replacement, and retry based on the later result.

> **Wrapper requester warning:** at `PlatformRandomness`, `msg.sender` is the
> wrapper, so the wrapper—not the player EOA—is stored as the requester. The
> player EOA cannot directly call requester-window Tx2. The wrapper must expose
> a forwarding function that calls `finalizeRandomness` and must keep its own
> `requestId → player/entry` mapping. Without that forwarding path, direct
> permissionless platform finalization by another address is delayed until
> `R+104`.

Do not let a player create many free request IDs and redeem only a favorable
one. `requestId` is included in the seed, so multiple requests produce multiple
outcomes even when their target blocks are identical. A positive `maxPending`
limits local pending-state growth but is not Sybil protection. A free attacker
can fill a finite cap and hold its slots until finalization or expiry.
`maxPending == 0` removes the contract cap and requires rate, eligibility, and
economic controls in the integrating application.

Tx1 requires the exact deployment-fixed request price. All of that payment
stays in the platform instance until `withdrawRevenue()` is called.
`protocolFee()` permanently returns `0`.

`withdrawRevenue()` is permissionless for liveness, but the caller cannot
choose an amount or destination: every successful call sends the entire
balance to the deployment-fixed `revenueRecipient`. The caller pays its own
gas and receives no protocol reward. If the recipient is wrong or rejects
native MON, V1 cannot repair the address or recover those funds.

### Reading the request ID

The transaction receipt contains:

```solidity
event RandomnessRequested(
    uint256 indexed requestId,
    address indexed requester,
    uint256 requestBlock,
    uint256 firstTargetBlock,
    uint256 secondTargetBlock,
    uint256 thirdTargetBlock,
    uint256 pricePaid
);
```

Decode this event rather than guessing the ID. Counters start at `1` separately
inside every platform instance.

## 3. Wait for the fixed target blocks

Tx1 fixes three targets:

| Target | Block |
| --- | --- |
| First | `requestBlock + 8` |
| Second | `requestBlock + 24` |
| Third | `requestBlock + 40` |

Requester finalization opens at `thirdTargetBlock + 2`. The result is already
mathematically fixed after the three target headers exist; waiting longer does
not change it.

## 4. Fetch the three canonical raw headers

For each target, call Monad RPC `debug_getRawHeader` with the block number as
an RPC hex quantity:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "debug_getRawHeader",
  "params": ["0xTARGET_BLOCK"]
}
```

The result is the RLP-encoded header bytes. Fetch all three headers. The
contract hashes each submitted header, compares it with Monad's canonical
block hash, parses the encoded block number, and extracts its authenticated
`mixHash`. A dishonest RPC cannot make a forged header pass these checks, but
an RPC must support `debug_getRawHeader` and remain available.

## 5. Submit Tx2 and permanently store the seed

Call:

```solidity
bytes32 result = platform.finalizeRandomness(
    requestId,
    firstRawHeader,
    secondRawHeader,
    thirdRawHeader
);
```

Timing rules are:

- from `thirdTargetBlock + 2` through `thirdTargetBlock + 63`, only the
  original `requester` may call Tx2;
- from `thirdTargetBlock + 64`, anyone may call Tx2;
- a rescue caller cannot redirect, replace, or regenerate the result; the
  request remains assigned to its original requester.

“Anyone may call” is not automation. A contract cannot wake itself up. A
platform that promises guaranteed completion must operate or sponsor its own
frontend, bot, keeper, or rescuer and pay those transaction costs itself. This
protocol pays no rescue reward or gas.

No always-on server is required by the contract: a browser, command-line
script, serverless job, community caller, or keeper can submit Tx2. Removing a
server removes an infrastructure dependency, not the liveness obligation. At
least one funded caller still has to act before proof expiry.

Successful Tx2 stores the seed once in platform contract state and decrements
that platform's pending count. A duplicate Tx2 is rejected. Once stored, the
result no longer depends on the block-history proof window and can be read
without a time limit:

```solidity
PlatformRandomness.Request memory request = platform.getRequest(requestId);
bytes32 permanentSeed = request.result;
```

## 6. Use bounded draws without modulo bias

For a result in `[0, upperBound)`, call:

```solidity
uint256 zeroBased = platform.draw(requestId, upperBound);
```

`draw` uses deterministic, domain-separated rejection sampling. Do not replace
it with `uint256(seed) % upperBound`. For a user-facing number from 1 through
100, call `draw(requestId, 100)` and display the returned value plus one.

The same request ID and bound always return the same result.

## 7. Release an abandoned slot after proof expiry

EIP-2935 exposes an 8,191-block historical-hash window. For a pending request:

- the **last** block where Tx2 may still authenticate all three headers is
  `firstTargetBlock + 8,191`;
- at exactly that block, finalization is still allowed;
- beginning at `firstTargetBlock + 8,192`, the oldest proof is unavailable and
  anyone may call `expireRequest(requestId)`.

Expiry permanently marks the request as expired and releases one local pending
slot. It creates no random result, gives no refund, pays no caller reward, and
moves no protocol funds. Expired requests cannot later be finalized.

## 8. Understand platform-local attack isolation

Every `PlatformRandomness` address has separate:

- request IDs and request storage;
- `pendingCount` and `maxPending`;
- fixed name, price, and revenue recipient; and
- request-payment balance.

Therefore, Tx1 spam that fills platform A's cap does not fill platform B's cap,
change B's counter, or touch B's funds. There is no global request queue or
O(n) loop. However, transactions against one instance still share
`nextRequestId` and `pendingCount`, so canonical execution orders those writes
and high same-instance load must be benchmarked. Monad-wide congestion and
gas-price competition are shared chain properties and cannot be isolated by an
application contract.

V1 cannot pause new Tx1 calls or increase a full cap. Stop product intake in
the application, keep finalizing or expiring every open V1 request, and route
future requests to a reviewed V2 address if configuration must change.

## 9. Migrate safely to V2

V1 has no in-place upgrade or migration hook. A V2 release is a new contract
with a new address and its own request counter and storage:

1. stop creating new product actions against V1 in every frontend, wrapper,
   allowlist, and worker;
2. preserve the V1 address and keep operating Tx2, rescue, reads, and expiry
   for every existing V1 request;
3. deploy and independently verify V2, including all constructor values,
   runtime code, RPC support, and a full Tx1 + Tx2 canary;
4. switch only new product actions to the approved V2 address; and
5. keep each business record pinned to its original chain, contract address,
   and request ID forever.

Finalized V1 results remain permanent at V1. They are not copied to V2.
Pending requests and contract balances also do not move automatically. A
misconfigured revenue recipient can leave V1 revenue permanently inaccessible.

## 10. Security boundary: authenticated entropy, not a VRF

The final seed is:

```solidity
keccak256(
    abi.encode(
        "MONAD_PUBLIC_RANDOMNESS_V1",
        block.chainid,
        address(platform),
        requestId,
        requester,
        mixHash1,
        mixHash2,
        mixHash3
    )
)
```

Chain ID, platform address, request ID, and requester prevent cross-chain,
cross-platform, cross-request, and cross-user replay. Three separated proposer
entropy fields reduce dependence on one block.

This construction is **not a cryptographic VRF** and is not perfectly
unbiasable. A scheduled proposer can know its own entropy and may choose to
skip or withhold a proposal. Adding more block fields does not completely
remove last-proposer bias. Use this contract for low- and moderate-value
applications whose threat model accepts that residual cost-based bias. For
prizes valuable enough to justify proposer manipulation, use a threshold
randomness system or an external VRF instead.

## Release files

- `public/contracts/PlatformRandomness.json`: deterministic ABI and exact
  creation bytecode from the Forge build artifact.
- `public/contracts/RandomnessFactory.json`: ownerless Factory ABI, creation
  bytecode, runtime bytecode, and runtime hash.
- `public/contracts/PlatformRandomness.sol`: platform source.
- `public/contracts/RandomnessFactory.sol`: Factory source.
- `public/contracts/MonadHeaderReader.sol`: required header-parser source.

Regenerate them from the exact checked-out source with:

```bash
npm run contracts:export
```
