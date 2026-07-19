# Monad RNG integration guide

## Integration outcome

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

At the end of this integration, one business action has exactly one durable
request identity:

1. Tx1 locks payment, eligibility, and inventory while creating the request.
2. The application persists the player, business action, request ID, requester,
   transaction, and block deadlines.
3. An operator waits for the three fixed target blocks.
4. Tx2 authenticates their raw headers, permanently stores the seed, and
   settles the previously locked action.
5. A funded rescue path takes over if the first operator does not complete Tx2.
6. A pre-approved customer policy handles requests that reach expiry.

Tx2, a keeper, permissionless rescue, and expiry are **not automatic**. Every
transaction needs an external caller and Monad gas.

## Choose direct EOA or wrapper mode

The address that calls `PlatformRandomness.requestRandomness` is permanently
stored as the requester.

| Mode | Tx1 path | Stored requester | Requester-window Tx2 |
| --- | --- | --- | --- |
| Direct EOA | The player's or application operator's EOA calls `PlatformRandomness` directly. | The EOA | That same EOA must call `finalizeRandomness` from `R+42` through `R+103`. |
| Application wrapper | The player calls `openEntry`, then the wrapper calls `PlatformRandomness`. | The requester is the wrapper, not the player EOA. | Anyone may call the wrapper's permissionless `finalizeEntry`; the wrapper forwards Tx2, so `PlatformRandomness` still sees its stored requester. |

Use direct mode only when the product can irrevocably bind the economic action
to the request without giving the EOA a cancellation, retry, or
result-selection option. It is simplest for a demonstration or an action with
no economic value.

Use wrapper mode for paid entries, prizes, mints, assignments, and other
value-bearing actions. One wrapper transaction can validate the player, retain
or lock payment, reserve product state, call Tx1, and store the returned
request ID atomically. If any step reverts, all of Tx1 reverts.

The player EOA cannot call `PlatformRandomness.finalizeRandomness` during the
requester-only window when a wrapper created the request. The integration must
expose a wrapper forwarding function.

## Deploy or select one isolated platform contract

Use one approved `PlatformRandomness` instance for the integrating platform.
Its request IDs, pending count, cap, price, pause state, owner, and balance are
isolated from every other instance.

Before enabling Tx1, pin and verify:

- the expected network and chain ID;
- the approved platform contract address and exact runtime code;
- the platform owner or multisig;
- `platformName`, `requestPrice`, `maxPending`, and `requestsPaused`; and
- the deployment transaction, source revision, build profile, and verification
  evidence.

`protocolFee()` is permanently `0`, but every deployment, Tx1, Tx2, rescue,
expiry, and administration sender pays Monad gas unless the application
separately sponsors it. Set `maxPending` from tested operational capacity;
`maxPending == 0` rejects every new request.

The repository's Monad Testnet browser application is a reference demo, not a
production SDK or proof that an arbitrary address is approved for your
platform.

## Implement Tx1: lock value and request together

The following compact Solidity pattern demonstrates both halves of the wrapper
flow. It retains `entryPrice` in the wrapper and forwards the exact current
`requestPrice` to `PlatformRandomness` in the same Tx1.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPlatformRandomness {
    struct Request {
        address requester;
        uint256 requestBlock;
        uint256 firstTargetBlock;
        uint256 secondTargetBlock;
        uint256 thirdTargetBlock;
        uint256 pricePaid;
        address finalizer;
        bytes32 result;
        bool finalized;
        bool expired;
    }

    function requestPrice() external view returns (uint256);
    function requestRandomness() external payable returns (uint256 requestId);

    function getRequest(uint256 requestId)
        external
        view
        returns (Request memory request);

    function finalizeRandomness(
        uint256 requestId,
        bytes calldata header1,
        bytes calldata header2,
        bytes calldata header3
    ) external returns (bytes32 randomness);

    function draw(uint256 requestId, uint256 upperBound)
        external
        view
        returns (uint256);
}

contract PrizeEntryWrapper {
    error EntryNotFound();
    error EntryAlreadySettled();
    error IncorrectPayment(uint256 expected, uint256 received);
    error InvalidPlatform();
    error InvalidPrizeCount();

    struct Entry {
        address player;
        uint256 requestId;
        bool settled;
    }

    IPlatformRandomness public immutable platform;
    uint256 public immutable entryPrice;
    uint256 public immutable prizeCount;
    uint256 public nextEntryId = 1;

    mapping(uint256 entryId => Entry entry) public entries;

    event EntryOpened(
        uint256 indexed entryId,
        uint256 indexed requestId,
        address indexed player
    );
    event EntrySettled(uint256 indexed entryId, uint256 draw);

    constructor(
        IPlatformRandomness platform_,
        uint256 entryPrice_,
        uint256 prizeCount_
    ) {
        if (address(platform_) == address(0)) revert InvalidPlatform();
        if (prizeCount_ == 0) revert InvalidPrizeCount();
        platform = platform_;
        entryPrice = entryPrice_;
        prizeCount = prizeCount_;
    }

    function openEntry() external payable returns (uint256 entryId, uint256 requestId) {
        uint256 randomnessPrice = platform.requestPrice();
        uint256 requiredValue = entryPrice + randomnessPrice;
        if (msg.value != requiredValue) {
            revert IncorrectPayment(requiredValue, msg.value);
        }

        // Add product eligibility and exact inventory reservation here.
        // The entry payment remains locked in this wrapper.
        requestId =
            platform.requestRandomness{value: randomnessPrice}();

        entryId = nextEntryId++;
        entries[entryId] = Entry({
            player: msg.sender,
            requestId: requestId,
            settled: false
        });

        emit EntryOpened(entryId, requestId, msg.sender);
    }

    function finalizeEntry(
        uint256 entryId,
        bytes calldata header1,
        bytes calldata header2,
        bytes calldata header3
    ) external returns (uint256 draw) {
        Entry storage entry = entries[entryId];
        if (entry.player == address(0)) revert EntryNotFound();
        if (entry.settled) revert EntryAlreadySettled();

        // Set before external calls. A revert rolls this change back.
        entry.settled = true;

        IPlatformRandomness.Request memory request =
            platform.getRequest(entry.requestId);
        if (!request.finalized) {
            platform.finalizeRandomness(
                entry.requestId,
                header1,
                header2,
                header3
            );
        }

        draw = platform.draw(entry.requestId, prizeCount);

        // Settle the already reserved inventory or payout from `draw` here.
        emit EntrySettled(entryId, draw);
    }
}
```

The `getRequest` check lets `finalizeEntry` settle an entry even if a rescue
caller already finalized the underlying request directly after `R+104`.
Otherwise the wrapper itself calls `finalizeRandomness`, so it remains the
underlying requester throughout requester-window Tx2. `EntryAlreadySettled`
rejects duplicate product settlement.

This pattern is deliberately limited to the randomness handshake. A real
integration must add its own inventory, payout, reentrancy, access-control, and
expiry-compensation rules, along with safe treasury withdrawal. Do not deploy
the example unchanged with customer value.

## Persist the request identity

The wrapper stores `entryId → {player, requestId, settled}` on-chain and emits
all three identities in `EntryOpened`. Your durable product record should make
the reverse lookup equally explicit: **entryId → requestId → player**. Also
store the business action ID, platform address, chain ID, request block, target
blocks, and Tx1 receipt.

For direct mode, decode `RandomnessRequested` from the confirmed Tx1 receipt.
Validate the emitting contract and expected requester before accepting its
`requestId`. Do not guess from `nextRequestId`, because other requests can be
included first.

Create the business action record before broadcasting Tx1 and enforce a unique
constraint on its idempotency key. After the receipt, update that same record;
do not create a second action. A page reload, timeout, wallet speed-up, or
operator retry must recover the existing identity rather than issue a new
randomness request.

## Wait for the three targets

If Tx1 is included at request block `R`, the fixed targets are `R+8`, `R+24`, and `R+40`.
Requester Tx2 opens at `R+42`, after the third target is two blocks old.

Treat block numbers as authoritative. A seconds estimate is display-only and
must never control readiness or expiry.

For each target:

1. Call a checked Monad RPC's `debug_getRawHeader` with the target block number
   encoded as a JSON-RPC hex quantity.
2. Preserve the returned RLP header bytes exactly; do not decode and re-encode
   them for Tx2.
3. Confirm the RPC is on the pinned chain and that the target is available.
4. Submit the headers in first, second, third order.

The contract hashes each supplied header, authenticates it against Monad's
canonical block hash, and checks the encoded block number. A forged or
out-of-order header reverts.

## Implement Tx2: authenticate, finalize, and settle

In direct mode, the stored EOA submits:

```solidity
bytes32 seed = platform.finalizeRandomness(
    requestId,
    firstRawHeader,
    secondRawHeader,
    thirdRawHeader
);
```

In wrapper mode, call `finalizeEntry(entryId, header1, header2, header3)`.
`finalizeEntry` can be permissionless at the wrapper level because the wrapper
itself remains the underlying requester. During `R+42` through `R+103`,
`PlatformRandomness` sees the wrapper as `msg.sender`, regardless of which EOA
called `finalizeEntry`.

All callers derive the same authenticated result. Callers cannot redirect,
replace, or choose the seed: invalid headers revert, and the first successful
finalization stores the result once. The wrapper then calls
`draw(requestId, prizeCount)` and settles the business action exactly once.

Wait until the Tx2 receipt's block is covered by the RPC's `finalized` block
tag before presenting the result as permanent to a customer. Persist the
original and replacement transaction hashes, receipt, finalizer, seed, draw,
and settlement outcome.

## Add permissionless rescue

Permissionless rescue opens at `R+104`. It changes who may pay to submit Tx2;
it does not change the request, source blocks, seed, player, or destination,
and it is not automatic.

Operate a monitored, funded rescue keeper with an earlier internal deadline.
For wrapper requests, the preferred rescue call is `finalizeEntry`, which can
finalize and settle atomically. From `R+104`, a rescuer may also finalize the
underlying platform request directly; the example wrapper detects that
permanent result on the next `finalizeEntry` call and performs only the
remaining product settlement.

The contract pays no keeper reward and reimburses no gas. Use idempotent jobs:
read the request and entry state before submitting, simulate the exact call,
record the sender and nonce, and treat an already finalized request as success
to reconcile rather than as a reason to create another Tx1.

## Read the permanent result

After finalized confirmation:

```solidity
IPlatformRandomness.Request memory request =
    platform.getRequest(requestId);
bytes32 permanentSeed = request.result;
uint256 zeroBasedPrize = platform.draw(requestId, prizeCount);
```

Require `request.finalized == true` and `request.expired == false`. `draw`
returns a deterministic value in `[0, prizeCount)` using domain-separated
rejection sampling. Use `draw(requestId, prizeCount)` rather than raw modulo,
which can introduce range bias.

The same request ID and upper bound always return the same draw. Store the
business settlement, but treat the platform contract's finalized request as
the authoritative randomness record.

## Handle expiry

The last valid proof block is `R+8199`; Tx2 is still allowed at that exact
block. Expiry starts at `R+8200`, when anyone may call
`expireRequest(requestId)`.

Expiry marks the request expired and releases one pending slot. It produces no
random result, pays no reward, moves no funds, and provides no protocol refund.
The request can never be finalized afterward.

At expiry, the wrapper and product database must:

1. mark the business action expired exactly once;
2. release or account for reserved inventory;
3. apply the refund, replacement, or alternative-fulfilment policy approved
   before Tx1;
4. prevent both later settlement and duplicate compensation; and
5. preserve request, expiry transaction, accounting, and customer-support
   evidence.

A replacement must not become a free option to shop for a favourable result.
Define eligibility and replacement rules without using unavailable or
selectively revealed randomness.

## Production transaction journal

Use a durable transaction journal keyed by a unique business action ID. At
minimum, one record must contain:

| Required field | Purpose |
| --- | --- |
| Business action ID | Idempotency key tying every retry and recovery to one product action |
| Chain ID | Prevents cross-network recovery |
| Contract | Pins the intended platform or wrapper |
| Calldata hash | Proves which action the signature and transaction represent |
| Sender | Identifies the account whose nonce must be reconciled |
| Nonce | Finds replacement, cancellation, or canonical consumption |
| Original hash | Preserves the first broadcast identity |
| Final hash | Preserves a mined repriced/replacement identity without erasing history |
| Request ID | Links confirmed Tx1 to later Tx2, rescue, result, and expiry |
| State | Records prepared, broadcast, replaced, confirmed, finalized, expired, compensated, or failed |

Write the intent, sender, nonce, and call envelope durably before broadcast;
then append hashes, receipts, events, and finalized observations. Use database
transactions and uniqueness constraints so concurrent workers cannot create
two Tx1 calls for the same business action.

Monad public RPC does not return pending transactions from
`eth_getTransactionByHash`, so timeout alone does not prove a transaction was
dropped or make Tx1 safe to resend. Reconcile the sender and nonce against
canonical blocks and record an audited decision before clearing or retrying a
pending action.

Web Locks and `localStorage` are demo-only. They coordinate neither devices nor
servers, have limited retention, and are not a production ledger, queue,
keeper, or transaction journal.

## Launch checklist

- [ ] The product treats Tx1 and Tx2 as one flow and never awards value after
      Tx1 alone.
- [ ] Direct EOA or wrapper mode is explicit, and every operator understands
      who the stored requester is.
- [ ] The wrapper atomically locks the economic action, stores one
      player/request mapping, forwards requester-window Tx2, and rejects
      duplicate settlement.
- [ ] The integration uses `R+8`, `R+24`, `R+40`, `R+42`, `R+104`, `R+8199`,
      and `R+8200` as authoritative block boundaries.
- [ ] A primary Tx2 operator, permissionless rescue keeper, gas budget, internal
      cutoff, and alert path are tested.
- [ ] The application uses `draw(requestId, upperBound)`, not raw modulo.
- [ ] Expiry accounting and customer compensation are approved and tested.
- [ ] The durable journal prevents duplicate Tx1 and recovers sender/nonce and
      replacement state without relying on a timeout.
- [ ] Chain, approved address, runtime code, owner, price, cap, pause state,
      source, and RPC capabilities are verified.
- [ ] The approved value ceiling is documented; higher-value actions use an
      external VRF or threshold randomness because this primitive is not a
      cryptographic VRF.
- [ ] End-to-end tests cover direct or wrapper Tx1, requester Tx2, direct rescue,
      already-finalized wrapper settlement, permanent read, and expiry.
