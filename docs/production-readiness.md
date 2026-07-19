# Monad RNG production readiness

## The rule you cannot skip: Tx1 + Tx2

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

At the start of the release process, only Monad Testnet, chain ID `10143`, is
the validated baseline. Mainnet must remain blocked until the exact build
passes Testnet end to end. Mainnet needs fresh RPC and EIP-2935 verification,
an updated threat model, and an independent security review appropriate to the
value at risk. That review must include a working `debug_getRawHeader` path.

Tx1 locks the economic action and fixes three future target blocks.

Tx2 authenticates those blocks, derives the seed, and stores it permanently.

Tx1 without Tx2 is an unfinished request, not a random result.

Your product flow must therefore include request creation, deadline tracking,
Tx2 execution, result settlement, permissionless rescue, and expiry handling.
Tx2 and rescue are **not automatic**. A smart contract cannot wake itself up:
an assigned person or service must submit each transaction and pay its Monad
gas.

The contract does not require an always-on application server. A browser,
script, serverless task, community caller, or keeper can submit Tx2. That
flexibility does not remove the need for a funded caller, monitoring, and a
deadline policy.

V1 is ownerless and fixed forever. It has no administrator, pause, proxy,
upgrade, or configuration setter. `revenueRecipient`, `platformName`,
`requestPrice`, and `maxPending` are chosen at deployment. If they are wrong
or the code needs to change, the product must move new requests to a new V2
address while it finishes all existing V1 requests.

## Five-minute fit check

Do not adopt this primitive if any answer in the right-hand column is true.

| Decision | Required answer | No-Go answer |
| --- | --- | --- |
| Who completes requests? | We can name the requester-window Tx2 operator, its gas budget, and a permissionless rescue policy. | We expect Tx2 or rescue to happen automatically, or cannot assign an operator. |
| When is value committed? | Payment, eligibility, inventory, and the randomness request become irreversible together in Tx1. | A player can wait for information, cancel, retry, or select among requests after Tx1. |
| What happens after proof expiry? | We have approved a customer-facing refund, replacement, or alternative-fulfilment policy. | We have no expiry customer policy or assume the protocol refunds the request. |
| What security property is required? | Authenticated proposer entropy with a documented value ceiling is acceptable. | The product needs cryptographic VRF guarantees or perfectly unbiasable randomness. |
| Can we accept permanent configuration? | We have independently approved the recipient, name, price, cap, code, and V2 migration procedure. | We need an emergency admin, pause, price change, cap change, recipient recovery, or in-place upgrade. |
| Can the free mode withstand spam? | We have chosen a paid gate, wrapper eligibility, rate control, or tested capacity policy. | We assume a finite free cap is Sybil protection or that `maxPending == 0` blocks requests. |

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

Each platform instance has separate request IDs, storage, pending state, fixed
cap, fixed price, fixed revenue recipient, and revenue balance. One platform
filling its own positive cap does not fill another platform's cap.

`maxPending == 0` means unlimited. A positive value is a permanent cap. With a
free request price, a Sybil attacker may fill a finite cap and hold its slots
until finalization or expiry; unlimited mode avoids cap lockout but permits
unbounded platform-local state growth paid for by request senders. Neither
choice replaces application eligibility or economic controls.

## What it does not guarantee

This construction is **not a cryptographic VRF** and is not perfectly
unbiasable. A scheduled proposer can know its own contribution and may choose
to skip or withhold a proposal. Three separated targets reduce simple
single-block influence; they do not eliminate last-proposer bias.

A block producer can also order or delay Tx1 inclusion within the power the
network gives that producer, which changes the request block and therefore all
three targets. Requests included in the same block reuse the same three target
headers even though their final seeds are domain-separated. Evaluate the total
value across those correlated requests: one proposal decision can affect many
draws at once.

The contract also does not provide:

- automatic Tx2, rescue, expiry, refunds, payouts, or keeper rewards;
- product inventory, eligibility, access control, or anti-Sybil policy;
- protection against a player creating many requests and selecting only a
  favourable result;
- a production RPC service, transaction journal, indexer, or incident response
  team;
- recovery of a random result after the oldest proof has expired;
- an emergency admin, pause, configuration correction, recipient recovery, or
  in-place upgrade; or
- an independent security audit of your wrapper and product integration.

Use an external VRF or threshold randomness whenever a prize or aggregate
exposure is above the integration's approved value ceiling.

## Cost and responsibility

`protocolFee()` is permanently `0`. That means Monad RNG takes no protocol fee;
it does **not** mean transactions are gasless.

| Cost or balance | Who is responsible |
| --- | --- |
| Platform deployment gas | The deployment signer; that wallet gains no authority |
| Tx1 gas and exact `requestPrice` | The Tx1 sender, unless the platform separately sponsors it |
| Requester-window Tx2 gas | The assigned requester finalizer or its sponsor |
| Permissionless rescue gas | The rescue caller or a separately funded platform keeper |
| Expiry gas | The expiry caller or the platform |
| Revenue sweep gas | Any caller may pay; the entire balance always goes to the fixed `revenueRecipient` |
| `requestPrice` revenue | Remains in that platform instance until `withdrawRevenue()` succeeds |
| Customer expiry compensation | The integrating platform under its own policy |

There is no protocol treasury, relayer, gas reimbursement, rescue reward, or
automatic refund. Budget for congestion and maintain funded Tx2 and rescue
signers before accepting requests.

The withdrawal caller cannot redirect or claim revenue. Use a recipient that
can accept native MON. A wrong or reverting recipient can strand revenue
because V1 has no recovery function.

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
| Release approvers | Verify the ownerless code, approved address, fixed recipient/name/price/cap, manifests, and V2 migration gate. They have no on-chain admin authority. |
| Application wrapper | Atomically binds payment, eligibility, inventory, and Tx1; records the player-to-request mapping; forwards requester-window Tx2 when the wrapper is the stored requester. |
| Requester-window finalizer | Watches new requests and submits funded Tx2 transactions from `R+42`, before rescue is needed. |
| Permissionless rescue keeper | Independently takes over at `R+104`, submits the same authenticated proof, and continues until the internal safety cutoff. Rescue is not automatic. |
| RPC operator | Provides and health-checks chain ID, finalized reads, canonical block data, and `debug_getRawHeader`, with capacity, timeouts, and failover. |
| Treasury | Funds deployment, Tx1 sponsorship if offered, Tx2, rescue, expiry, and incident gas; reconciles request revenue and customer compensation. |
| Monitoring | Indexes request/finalize/expiry and revenue-withdrawal events; alerts on `R+42`, `R+104`, the safety cutoff, pending growth, RPC failure, and low signer balance. |
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
- [ ] The approved chain, contract address, code, fixed recipient/name/price/
      cap, and absence of owner/admin/pause/upgrade/setters are independently
      verified.
- [ ] `maxPending == 0` is treated as unlimited; zero-price spam, finite-cap
      lockout, and unlimited-mode growth have explicit controls.
- [ ] A wrong configuration or defect triggers the documented V2 address
      migration; nobody expects the deployment wallet to repair V1.
- [ ] The integration has been tested end to end through Tx1, requester Tx2,
      rescue, permanent read, and expiry.

Any unchecked item is **No-Go**. In particular, do not launch on the assumption
that a browser tab, public RPC, keeper, rescue caller, or contract will execute
Tx2 automatically.
