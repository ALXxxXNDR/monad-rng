# Monad RND contract integration

Monad RND is an MIT-licensed, zero-protocol-fee public good. Each integrating
platform deploys its own `PlatformRandomness` instance, chooses its own request
price, and owns all revenue held by that instance.

“Free” means the platform may set `requestPrice` to `0`. It does **not** mean
gasless: the sender of every deployment, Tx1, Tx2, expiry, and administration
transaction pays Monad network gas unless the integrating platform separately
sponsors that sender. This repository has no treasury, relayer, keeper reward,
server wallet, gas reimbursement, or subsidy.

## 1. Choose an isolated deployment path

There are two supported paths:

1. **Direct deployment:** deploy the creation bytecode in
   `public/contracts/PlatformRandomness.json` with these constructor arguments:
   `(platformOwner, platformName, requestPrice, maxPending)`.
2. **Ownerless factory:** deploy `RandomnessFactory`, then call
   `deployPlatform(platformName, requestPrice, maxPending)`. The returned
   platform is owned by the caller. The factory is nonpayable, retains no MON,
   and has no owner, treasury, platform array, fee, withdrawal, registry, or
   upgrade path. Discover deployments from its `PlatformDeployed` event.

The factory is optional. A frontend can deploy `PlatformRandomness` directly
and therefore does not depend on one canonical factory address.

The optional Foundry script deploys only the ownerless factory:

```bash
DEPLOYER_PRIVATE_KEY="<local-key>" forge script \
  contracts/script/Deploy.s.sol:Deploy \
  --rpc-url https://testnet-rpc.monad.xyz \
  --broadcast
```

The key is read only from the local process environment. Never commit it. The
key owner supplies its own MON and pays the deployment gas.

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
outcomes even when their target blocks are identical. `maxPending` limits local
storage pressure; it is not Sybil protection.

Tx1 requires the exact current request price. All of that payment stays in the
platform instance until its owner withdraws it. `protocolFee()` permanently
returns `0`.

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
- pause state and request price;
- ownership and request-payment balance.

Therefore, Tx1 spam that fills platform A's cap does not fill platform B's cap,
change B's counter, or touch B's funds. There is no global request queue or
loop, so simultaneous requests do not create a contract-level queue
bottleneck. Monad-wide congestion and gas-price competition are still shared
chain properties and cannot be isolated by an application contract.

Pausing new Tx1 calls never blocks Tx2 or expiry for existing requests.

## 9. Security boundary: authenticated entropy, not a VRF

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
- `public/contracts/PlatformRandomness.sol`: platform source.
- `public/contracts/MonadHeaderReader.sol`: required header-parser source.

Regenerate them from the exact checked-out source with:

```bash
npm run contracts:export
```
