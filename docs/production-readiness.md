# Monad RND production readiness

## The rule you cannot skip: Tx1 + Tx2

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

Tx1 locks the economic action and fixes three future target blocks.

Tx2 authenticates those blocks, derives the seed, and stores it permanently.

Tx1 without Tx2 is an unfinished request, not a random result.

Your product flow must therefore include request creation, deadline tracking,
Tx2 execution, result settlement, permissionless rescue, and expiry handling.
Tx2 and rescue are **not automatic**. A smart contract cannot wake itself up:
an assigned person or service must submit each transaction and pay its Monad
gas.

## Five-minute fit check

Do not adopt this primitive if any answer in the right-hand column is true.

| Decision | Required answer | No-Go answer |
| --- | --- | --- |
| Who completes requests? | We can name the requester-window Tx2 operator, its gas budget, and a permissionless rescue policy. | We expect Tx2 or rescue to happen automatically, or cannot assign an operator. |
| When is value committed? | Payment, eligibility, inventory, and the randomness request become irreversible together in Tx1. | A player can wait for information, cancel, retry, or select among requests after Tx1. |
| What happens after proof expiry? | We have approved a customer-facing refund, replacement, or alternative-fulfilment policy. | We have no expiry customer policy or assume the protocol refunds the request. |
| What security property is required? | Authenticated proposer entropy with a documented value ceiling is acceptable. | The product needs cryptographic VRF guarantees or perfectly unbiasable randomness. |

If you cannot name a Tx2 operator and rescue policy, cannot bind value during
Tx1, cannot define an expiry customer policy, or need cryptographic VRF
guarantees, stop the integration and choose another randomness design.

## What the primitive does

`PlatformRandomness` provides authenticated multi-block proposer entropy for
one isolated application:

1. Tx1 calls `requestRandomness`, permanently records the requester and request
   block, and fixes three future target blocks.
2. Tx2 supplies the three raw Monad block headers. The contract authenticates
   each header against the canonical block hash, verifies its encoded block
   number, and extracts its `mixHash`.
3. The contract derives one domain-separated seed from the chain ID, platform
   address, request ID, requester, and three authenticated entropy values.
4. Successful Tx2 stores that seed exactly once and reduces the platform's
   pending count.
5. `draw(requestId, upperBound)` converts the permanent seed to a deterministic
   value in `[0, upperBound)` with rejection sampling instead of biased raw
   modulo.

Each platform instance has separate request IDs, storage, pending cap, price,
pause state, owner, and revenue balance. One platform filling its own pending
cap does not fill another platform's cap.

## What it does not guarantee

This construction is **not a cryptographic VRF** and is not perfectly
unbiasable. A scheduled proposer can know its own contribution and may choose
to skip or withhold a proposal. Three separated targets reduce simple
single-block influence; they do not eliminate last-proposer bias.

The contract also does not provide:

- automatic Tx2, rescue, expiry, refunds, payouts, or keeper rewards;
- product inventory, eligibility, access control, or anti-Sybil policy;
- protection against a player creating many requests and selecting only a
  favourable result;
- a production RPC service, transaction journal, indexer, or incident response
  team;
- recovery of a random result after the oldest proof has expired; or
- an independent security audit of your wrapper and product integration.

Use an external VRF or threshold randomness whenever a prize or aggregate
exposure is above the integration's approved value ceiling.

## Cost and responsibility

`protocolFee()` is permanently `0`. That means Monad RND takes no protocol fee;
it does **not** mean transactions are gasless.

| Cost or balance | Who is responsible |
| --- | --- |
| Platform deployment and administration gas | The deploying or owner operation signer |
| Tx1 gas and exact `requestPrice` | The Tx1 sender, unless the platform separately sponsors it |
| Requester-window Tx2 gas | The assigned requester finalizer or its sponsor |
| Permissionless rescue gas | The rescue caller or a separately funded platform keeper |
| Expiry gas | The expiry caller or the platform |
| `requestPrice` revenue | Remains in that platform instance until its owner withdraws it |
| Customer expiry compensation | The integrating platform under its own policy |

There is no protocol treasury, relayer, gas reimbursement, rescue reward, or
automatic refund. Budget for congestion and maintain funded Tx2 and rescue
signers before accepting requests.

## Full lifecycle by block number

Let `R` be the block in which Tx1 is included. Block numbers, not wall-clock
estimates, are authoritative.

| Block point | Product and contract state |
| --- | --- |
| `R` | Tx1 locks the business action, records the requester, and creates one pending request. |
| `R+8`, `R+24`, `R+40` | The three fixed target blocks contribute the authenticated header entropy. |
| `R+42` | Requester Tx2 opens after the third target is two blocks old. Only the stored requester may finalize through `R+103`. |
| `R+104` | Permissionless rescue opens. Anyone may submit the same proof and store the same result; this is not automatic execution. |
| `R+8199` | This is the last proof block. Tx2 is still valid because the first target at `R+8` remains inside the 8,191-block history window. |
| `R+8200` | Expiry starts. Tx2 can no longer authenticate the oldest target, and anyone may call `expireRequest`; no random result is created. |

Set an earlier operational cutoff so a submitted Tx2 has time to be included
before `R+8199`. A UI warning or keeper deadline is an operating margin, not a
change to the contract boundary.

## Choose a value ceiling

There is no universal safe prize amount. Approve a ceiling from your own threat
model before launch:

1. Calculate the largest value a participant or proposer could gain across one
   request, one account, one campaign, and correlated concurrent requests.
2. Include the value of selective redemption, retries, side markets, and
   reputational or governance consequences, not only the displayed prize.
3. Assess whether that gain could justify proposer skipping, withholding, or
   collusion under expected network conditions.
4. Add product controls that bind one economic action to one request and limit
   aggregate exposure.
5. Record the approved ceiling, reviewer, evidence, and review date. Reassess it
   when product value, network conditions, or contract configuration changes.

Route every action above that ceiling to an external VRF or threshold
randomness system. If your team cannot defend a concrete ceiling, the decision
is No-Go.

## Decide the expiry and customer policy

Expiry releases a pending slot; it does not generate randomness, refund
`requestPrice`, move platform funds, or compensate the player. An expired
request can never be finalized later.

Before Tx1 is enabled, decide and publish:

- the earlier internal Tx2 deadline and escalation points;
- who may trigger rescue and who pays its gas;
- whether the customer receives a refund, a replacement request created
  without result shopping, or deterministic alternative fulfilment;
- how retained entry payment, reserved inventory, and the platform's
  `requestPrice` revenue are accounted for;
- how support proves the request expired and prevents duplicate compensation;
  and
- which event and database records form the audit trail.

Never let an expiry policy give a player a free option to retry after learning
a result. Compensation rules must be fixed before the original Tx1 and applied
consistently.

## Assign production roles

Name a primary and backup for every row. “Permissionless” describes who is
allowed to submit a transaction; it does not assign operational ownership.

| Role | Production assignment |
| --- | --- |
| Platform owner / multisig | Owns the isolated instance; approves and verifies price, pending cap, pause state, withdrawals, and ownership changes. |
| Application wrapper | Atomically binds payment, eligibility, inventory, and Tx1; records the player-to-request mapping; forwards requester-window Tx2 when the wrapper is the stored requester. |
| Requester-window finalizer | Watches new requests and submits funded Tx2 transactions from `R+42`, before rescue is needed. |
| Permissionless rescue keeper | Independently takes over at `R+104`, submits the same authenticated proof, and continues until the internal safety cutoff. Rescue is not automatic. |
| RPC operator | Provides and health-checks chain ID, finalized reads, canonical block data, and `debug_getRawHeader`, with capacity, timeouts, and failover. |
| Treasury | Funds deployment, Tx1 sponsorship if offered, Tx2, rescue, expiry, and incident gas; reconciles request revenue and customer compensation. |
| Monitoring | Indexes request/finalize/expiry and admin events; alerts on `R+42`, `R+104`, the safety cutoff, pending-cap pressure, RPC failure, and low signer balance. |
| Customer support | Applies the pre-approved expiry policy, communicates status without promising an unavailable result, and prevents duplicate compensation. |

The Monad Testnet browser application is a reference demo. Its `localStorage`
and Web Locks are not a production SDK, ledger, queue, keeper, transaction
journal, or cross-device lock.

## Go/No-Go checklist

Choose **Go** only when every item is checked:

- [ ] Product and engineering agree that Tx1 and Tx2 are one mandatory flow.
- [ ] Tx1 irrevocably binds payment, eligibility, inventory, and exactly one
      business action to exactly one request.
- [ ] The stored requester is understood for both direct EOA and wrapper modes.
- [ ] A funded requester-window finalizer and a separately monitored rescue
      policy have named owners and backups.
- [ ] The team uses the exact `R+8`, `R+24`, `R+40`, `R+42`, `R+104`,
      `R+8199`, and `R+8200` boundaries.
- [ ] The value ceiling and the external VRF or threshold-randomness fallback
      are approved.
- [ ] Expiry compensation, accounting, customer language, and duplicate
      prevention are approved before Tx1.
- [ ] RPC capacity, raw-header support, failover, gas budgets, monitoring, and
      incident escalation have been rehearsed.
- [ ] The approved chain, contract address, code, owner, and configuration are
      pinned and independently verified.
- [ ] The integration has been tested end to end through Tx1, requester Tx2,
      rescue, permanent read, and expiry.

Any unchecked item is **No-Go**. In particular, do not launch on the assumption
that a browser tab, public RPC, keeper, rescue caller, or contract will execute
Tx2 automatically.
