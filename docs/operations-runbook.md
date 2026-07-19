# Monad RNG operations runbook

## Operating promise

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

Monitor every `RandomnessRequested` until exactly one terminal contract event:
`RandomnessFinalized` or `RandomnessRequestExpired`. A submitted transaction,
wallet hash, elapsed timeout, or database flag is not a terminal contract
state.

Tx2, keeper work, rescue, expiry, refunds, and settlement all need an external
caller or service. Permissionless rescue is not automatic. Each sender needs
Monad gas, and the protocol supplies no keeper reward, relayer, treasury, or
refund.

No always-on application server is required. A browser, script, serverless
task, community caller, or keeper can submit the transactions. Whatever model
you choose still needs monitoring, a funded caller, and a durable record; the
contract cannot schedule its own Tx2.

V1 has no owner, admin, pause, upgrade, or configuration setter. Its
`revenueRecipient`, `platformName`, `requestPrice`, and `maxPending` are fixed
forever. Operational controls therefore live in the integrating application,
allowlist, wrapper, and transaction workers.

For every write, persist the business-action ID, chain, contract, function and
calldata hash, sender, nonce, original hash, replacement hashes, receipts,
events, finalized observation, and operator decision. Use a durable
transaction journal and uniqueness constraints; browser storage is not an
operations ledger.

## Normal Tx1 → Tx2 path

Let `R` be the canonical block containing Tx1. Block numbers, not elapsed
seconds, control every transition.

1. Before Tx1, create one durable business-action record and irrevocably bind
   its payment, eligibility, inventory, and customer policy. Lock it so two
   workers cannot open two requests.
2. Read the approved chain, platform address, fixed price, and pending
   capacity. If `maxPending` is positive, confirm a slot is available.
   Persist the intended Tx1 sender, nonce, value, destination, and calldata
   hash before broadcast.
3. After finalized inclusion, decode `RandomnessRequested` only from the
   approved platform receipt. Store its request ID, requester, `R`, target
   blocks `R+8`, `R+24`, `R+40`, and deadlines `R+42`, `R+104`, `R+8199`,
   and `R+8200`.
4. At or after `R+42`, fetch the exact RLP headers for all three targets with
   `debug_getRawHeader` from a health-checked RPC. Check their canonical hashes
   and keep them in first, second, third order.
5. Read the on-chain request and wrapper entry, simulate the exact Tx2 action,
   then journal its sender, nonce, destination, and calldata hash before
   broadcast.
6. Submit requester-window Tx2 through the stored requester path. Save the
   returned hash immediately and keep polling canonical receipts without
   opening another business action.
7. Wait until the successful receipt block is covered by the RPC's `finalized`
   tag. Validate `RandomnessFinalized`, `getRequest`, and any wrapper settlement
   before presenting the outcome as permanent.
8. Settle the locked action exactly once and reconcile the permanent result,
   draw, inventory, accounting, and customer record.
9. If Tx2 has not finalized by `R+104`, hand the same request to the rescue
   runbook. Continue monitoring until `RandomnessFinalized` or
   `RandomnessRequestExpired`; never abandon it in a generic “pending” state.

If new intake must stop, disable it in every application and wrapper entry
point. The V1 platform contract itself cannot be paused. Continue operating
Tx2, rescue, reads, and expiry for existing requests.

## Requester-window finalization

Requester-window Tx2 opens at `R+42`. Only the requester stored by
`PlatformRandomness` may call `finalizeRandomness` through `R+103`.

- **Direct mode:** the same EOA that sent Tx1 is the stored requester. A
  different keeper EOA cannot directly finalize during this window.
- **Wrapper mode:** the wrapper called `PlatformRandomness` in Tx1, so the
  wrapper is the stored requester. A public `finalizeEntry` function may let
  any funded operator trigger the wrapper, but the wrapper itself must forward
  `finalizeRandomness` and preserve its own request-to-player/entry mapping.

At each retry attempt, first read the on-chain request and business state. If
another worker already finalized it, reconcile that result as success. If a
transaction is still pending or unknown, use the sender-and-nonce procedure
below rather than creating another Tx2 with a new nonce.

If a wrapper exposes no forwarding function, the player EOA cannot bypass it
during this window. Direct platform finalization by another address does not
open until `R+104`.

## Permissionless rescue

At `R+104`, the contract permits any address to submit the same authenticated
headers through `R+8199`. This changes who may pay for Tx2; it does not change
the request ID, requester, source blocks, result, player, or settlement.

Operate rescue as an assigned service:

1. Alert and enqueue any request not finalized by `R+104`.
2. Read the current platform request and wrapper entry. Treat an already stored
   result as reconciliation, not as a reason to send another Tx1.
3. Re-fetch or verify all three canonical raw headers and simulate the exact
   rescue call.
4. For wrapper products, prefer the reviewed wrapper's `finalizeEntry` so
   randomness and product settlement remain atomic. A rescuer may also call
   the underlying platform directly after `R+104`; the wrapper must then
   reconcile the stored result before settling once.
5. Persist intent, sender, nonce, calldata hash, and every transaction hash.
   Coordinate keepers so they do not race with unrelated nonces or settlements.
6. Require finalized success and the on-chain result before closing the alert.

Rescue is permissionless, not automatic. The contract pays no rescue reward
and reimburses no gas, so keepers need monitored balances and an explicit
platform treasury assignment.

## Proof deadline and expiry

The first target is `R+8`, and EIP-2935 retains 8,191 historical hashes for the
contract's proof path. The exact boundaries are:

| Boundary | Meaning |
| --- | --- |
| `R+8199` | Last contract-valid proof block. Tx2 must be included successfully at or before this block; merely broadcasting here is insufficient. |
| `R+8200` | First expiry block. Tx2 can no longer authenticate the oldest target, and anyone may call `expireRequest`. |

Set an earlier internal safety cutoff based on observed RPC, signer, fee, and
inclusion latency. The included demo's margin is not a new contract rule.
Escalate before the internal cutoff, then again with enough blocks left for RPC
failover and replacement reconciliation.

At `R+8200` or later, read the request again and submit expiry only if it is
still pending. A successful expiry releases one platform-local pending slot
but creates no random result, refund, reward, or fund movement. The expired
request can never later be finalized. Apply only the compensation or
alternative-fulfilment policy approved before Tx1, and prevent duplicate
settlement or result-shopping replacement requests.

## Transaction states and safe retry rules

The durable journal must use evidence-based states:

| State | Required evidence | Safe operator action |
| --- | --- | --- |
| Not-broadcast | The prepared intent is durable, no signer or wallet returned a hash, and the broadcast component has definitive local evidence that submission never occurred. | Re-read contract state, retain the same business-action lock, simulate, and broadcast the one prepared action. |
| Pending/unknown | A hash was returned but there is no finalized canonical receipt, or an RPC returns `null`/times out. | Do not clear, resend with a new nonce, create a new Tx1, or settle. Reconcile the sender and nonce across canonical blocks and approved RPCs. Re-broadcasting the exact same signed raw transaction is hash-identical, but still needs an audit entry. |
| Finalized success | A successful receipt is in a block covered by `finalized`, and its event and on-chain state match the intended action. | Mark the write complete, reconcile downstream state exactly once, and never retry it. |
| Finalized revert | A reverted receipt is in a finalized block and the sender nonce is therefore consumed. | Read current contract state and decode the cause. If the business action is still required, record a reviewed new attempt under the same idempotency key; never infer that a new randomness request is automatically safe. |
| Confirmed replacement with identical action | Canonical evidence identifies a same-sender, same-nonce replacement, and chain, destination, value, and calldata match the journaled action; only fee fields differ. | Preserve both hashes, follow the replacement, and require finalized success before settlement. Treat its one canonical execution as the original action. |
| Nonce consumed by a different action | A canonical transaction uses the intended sender and nonce but destination, value, or calldata differs, including a cancellation. | Open an incident, mark the original action not executed, inspect on-chain business state, and require an audited manual decision before any new nonce or action is issued. Never relabel the different action as success. |

Sender-and-nonce reconciliation means:

1. Keep the sender, intended nonce, complete call envelope, original hash, and
   earliest possible block in the journal.
2. Read `eth_getTransactionCount(sender, "finalized")` and inspect canonical
   blocks from the recorded start block for the transaction that consumed that
   sender and nonce. A nonce count alone does not prove which action executed.
3. Compare chain ID, sender, nonce, destination, value, and calldata with the
   durable intent. Preserve both original and replacement hashes.
4. Verify the affected contract/request state and event at `finalized`.
5. Append the evidence, operator, reason, and decision to an audit entry before
   clearing a pending action or authorizing another broadcast.

Timeout alone never completes this procedure. Prefer idempotent on-chain state
checks, database locks, and same-nonce/same-action replacement handling over a
new-nonce retry.

## Monad replacement limitation

On Monad public RPC, `eth_getTransactionByHash` returns `null` for pending
mempool transactions. The same response can therefore be observed before
inclusion even though the original transaction may still execute.

A dropped or replaced transaction cannot be declared safe to retry from a
timeout, one `null` response, a page reload, or a wallet label alone. The
system cannot universally discover a speed-up or cancellation before the
replacement becomes queryable in canonical chain data.

Do not send a second Tx1 with a new nonce while the first is merely unknown;
both could later execute. Reconcile sender+nonce against canonical blocks,
compare the full action envelope, verify on-chain state, and write the audit
entry described above. If policy permits a fee replacement, use the intended
same nonce and identical destination/value/calldata through a controlled
signer workflow, then follow whichever matching transaction becomes canonical.

## RPC health check and failover

Run every check at worker startup, periodically during operation, and before
promoting a fallback:

| Check | Pass condition |
| --- | --- |
| `eth_chainId` | Exactly `0x279f` / decimal `10143` for the supported Monad Testnet deployment. |
| `finalized` | `eth_getBlockByNumber("finalized", false)` returns a non-null block, advances within the agreed lag, and agrees with another healthy endpoint. |
| `debug_getRawHeader` | A known finalized block returns exact RLP header bytes whose Keccak hash equals that canonical block hash and whose encoded number and `mixHash` can be parsed. |
| Browser CORS | When a browser calls the RPC, an actual request from the deployed origin passes preflight/POST CORS; a server-side probe is not a substitute. |
| EIP-2935 lookup | An `eth_call` to `0x0000F90827F1C53a10cb7A02335B175320002935` for a finalized block older than 256 but still within 8,191 blocks returns the same canonical block hash. |
| Bounded timeout | Every RPC operation fails within the documented client deadline; no worker can hang indefinitely while a proof deadline advances. |
| Rate limit and capacity | A controlled probe stays within provider policy, exposes throttling clearly, and leaves measured headroom for the request and rescue load. |
| Failover | A separately operated endpoint passes all the same checks and returns matching finalized data; merely having a second URL is not failover. |

RPC failover procedure:

1. Mark the primary unhealthy after the configured bounded failures and alert
   with endpoint, method, latency, error, and affected request deadlines.
2. Stop assigning new work to it. Do not mark its unknown transactions dropped.
3. Run the entire table against the secondary. An endpoint without
   `debug_getRawHeader`, browser CORS when required, or working EIP-2935 access
   cannot serve Tx2.
4. Compare finalized block number/hash and re-fetch each affected raw header.
   Reject conflicting canonical data and escalate rather than mixing proofs.
5. Switch through configuration with an audit record, process the oldest proof
   deadlines first, and continue sender+nonce reconciliation.
6. Backfill events from the last trusted finalized checkpoint and reconcile
   every open request before declaring recovery.

If no endpoint passes, stop new product intake in the application and preserve
existing jobs. The contract cannot be paused, so also remove the V1 address
from every frontend, wrapper, and automated request path. Finalization and
expiry remain the recovery priority.

## Monitoring and alerts

At minimum, monitor:

- every `RandomnessRequested`, `RandomnessFinalized`, and
  `RandomnessRequestExpired`, with a cardinality check that each request reaches
  one terminal state;
- current block distance to `R+42`, `R+104`, the internal safety cutoff,
  `R+8199`, and `R+8200`;
- Tx1-to-Tx2 latency, requester-window success rate, rescue volume, expiry
  volume, and oldest open request;
- on-chain `pendingCount / maxPending` when the cap is positive, application
  queue depth, and blocked Tx1 calls; for unlimited mode, monitor absolute
  pending growth;
- requester and rescue signer balances versus the configured number of
  worst-case gas limits, with warning and critical thresholds;
- RPC chain ID, finalized lag/hash agreement, latency, timeouts, error rate,
  rate-limit responses, raw-header validity, EIP-2935 health, and failover
  readiness;
- transaction-journal pending/unknown age, nonce gaps, replacements, different
  nonce consumers, and unfinalized receipts;
- indexer checkpoint block/hash, replay progress, duplicate/missing event
  checks, and reconciliation against `getRequest` and `pendingCount`;
- `RevenueWithdrawn`, unexpected balance accumulation, and any mismatch
  between the approved frozen configuration and live reads; and
- expired requests awaiting inventory release, accounting, customer contact,
  or compensation.

Page a human before the proof window is endangered. A dashboard without an
assigned responder, funded signer, escalation route, and tested procedure is
not an operating control.

## Incident runbooks

### RPC outage

1. Alert, record affected methods and request deadlines, and stop new product
   intake if Tx2 capacity is no longer assured.
2. Apply the RPC failover procedure above. Never interpret missing pending data
   as proof that a transaction was dropped.
3. Re-fetch canonical headers and receipts through the healthy endpoint and
   process the oldest request first.
4. Backfill from the last trusted finalized block, reconcile every sender
   nonce and open request, then document the outage and recovery.

### Keeper balance low

1. Alert before the signer falls below the approved number of worst-case
   transactions; prioritize the nearest proof deadlines.
2. Fund it from the assigned platform treasury through the approved process.
   The protocol will not reimburse it.
3. Confirm the funding transaction at `finalized` and re-read the balance.
4. Resume work without changing requester semantics: a direct request needs
   its requester through `R+103`; a rescue signer becomes eligible at `R+104`.
5. Reconcile any work that was delayed and adjust the threshold only through a
   reviewed capacity change.

### Withdraw request revenue

1. Read the approved contract address, fixed `revenueRecipient`, and balance
   from the intended chain.
2. Confirm the recipient can accept native MON. For a contract recipient,
   simulate its receive path before relying on the sweep.
3. Anyone may call `withdrawRevenue()`. Journal and simulate the exact call;
   the caller pays gas and cannot select the amount or destination.
4. Require a finalized successful receipt, check `RevenueWithdrawn`, and
   reconcile the recipient balance and platform balance.
5. If the transfer reverts, do not deploy a helper or use a different caller
   expecting a different destination. The recipient is fixed; investigate its
   receive behavior and treat an unrecoverable recipient as a V2 incident.

### Pending cap full

This incident applies only when the fixed `maxPending` is positive.

1. Confirm `pendingCount`, `maxPending`, and open requests directly on-chain;
   do not rely only on the index.
2. Stop accepting product actions that would create Tx1. Identify RPC failure,
   keeper failure, spam, or unmatched terminal events.
3. Finalize eligible requests, rescue from `R+104`, and expire only at
   `R+8200` or later.
4. Reconcile the event index and customer records. The cap cannot be raised in
   place, so do not wait for an admin transaction that does not exist.
5. If the permanent cap no longer fits the product, deploy and verify V2 with a
   newly reviewed cap, route only new requests to V2, and finish every V1
   request at V1.

### Proof deadline near

1. Trigger this runbook at the internal safety cutoff, not at `R+8199`.
2. Escalate to the rescue lead, verify signer balance and healthy RPCs, fetch
   all three headers, simulate, and submit with enough blocks for inclusion and
   nonce reconciliation.
3. Track the canonical inclusion block. Tx2 must succeed no later than
   `R+8199`; a hash returned at that block is not enough.
4. If no proof transaction was included by `R+8199`, stop Tx2 attempts. At
   `R+8200`, follow the expired-request procedure and customer policy.

### Revenue recipient compromised or misconfigured

1. Stop new product intake, page security and product governance, and remove
   V1 from new-request configuration while facts are established.
2. Read the fixed `revenueRecipient`, price, cap, balance, requests, and
   `RevenueWithdrawn` events directly on-chain. Preserve evidence.
3. Do not attempt an ownership transfer, recipient setter, or pause; none
   exists. The deployment wallet also has no recovery authority.
4. Deploy and verify V2 with the correct recipient and route only new requests
   to V2.
5. Continue finalizing and expiring every existing V1 request. Random results
   do not depend on the recipient and remain permanent at V1.
6. Treat any V1 balance as recoverable only if the fixed recipient can receive
   it. If the address is wrong or rejects MON, V1 has no recovery path.

### Frozen configuration no longer fits

1. Stop creating new V1 product actions at every controlled entry point.
2. Record why the fixed name, price, cap, recipient, or code no longer fits.
3. Build, test, deploy, and independently verify a new V2 address and manifest.
4. Run the full V2 Tx1 + Tx2 canary before enabling new product value.
5. Keep V1 workers and records active until every V1 request is finalized or
   expired. Never move a V1 request ID to V2 or treat the two counters as one.

### Corrupt event index

1. Stop automated settlement and support decisions that depend on the corrupt
   index. Preserve a snapshot for investigation.
2. Find the last trusted finalized checkpoint and verify its block hash with
   two healthy RPCs.
3. Rebuild into a clean index by replaying canonical logs from the deployment
   block or that checkpoint. Filter by approved chain, platform address, and
   exact event topics.
4. Reconcile every open request with `getRequest`, and reconcile aggregate
   pending records with on-chain `pendingCount`.
5. Compare request IDs, terminal-event cardinality, journal nonces, wrapper
   entries, and customer settlement before switching readers to the rebuild.
6. Record the corruption cause, discarded range, replay evidence, and reviewer.

### Expired request

1. Require a finalized `RandomnessRequestExpired` event and
   `getRequest(requestId).expired == true`; a deadline estimate alone is not
   evidence.
2. Mark the business action expired exactly once, block later randomness
   settlement, and release or account for reserved inventory.
3. Apply the refund, replacement, or deterministic alternative fulfilment
   approved before Tx1. The primitive itself pays no refund.
4. Prevent duplicate compensation and never create a customer option to select
   among requests based on unavailable or selectively revealed results.
5. Preserve request, expiry transaction, accounting, communication, and
   compensation evidence; investigate why Tx2 and rescue both missed.

## Customer support answers

**“I sent Tx1. Why is there no result yet?”**

Tx1 creates and locks the request. A separate Tx2 can start at `R+42` after the
three target blocks exist. Operations is tracking the request until it is
finalized or expired.

**“Will permissionless rescue happen automatically?”**

No. Permissionless means any funded caller is allowed from `R+104`; an assigned
keeper or person still has to submit Tx2 and pay gas.

**“Why can I not finalize a wrapper request from my wallet?”**

The wrapper, not the player's wallet, is the stored requester. Through
`R+103`, Tx2 must pass through the wrapper's forwarding function. Direct
permissionless platform finalization opens at `R+104`.

**“The transaction lookup says null. Was it dropped?”**

Not necessarily. Monad public RPC does not expose pending mempool transactions
through `eth_getTransactionByHash`. Operations must reconcile the sender and
nonce against canonical blocks before deciding what happened.

**“Can you send a second request while the first transaction is unknown?”**

No. Two requests could execute and create a result-selection problem. The team
must recover the original action or complete the audited nonce procedure first.

**“Can the result change after Tx2?”**

No. The first successful Tx2 stores one authenticated result permanently.
Support waits for finalized confirmation before presenting it as permanent.

**“What happens if the request expires?”**

From `R+8200`, expiry can release the pending slot but cannot create randomness
or a protocol refund. Support applies the product policy approved before Tx1
and prevents duplicate compensation.

**“Is this a VRF, and is every prize value appropriate?”**

No. It is authenticated multi-block proposer entropy with residual proposer
bias, not a cryptographic VRF. The product must stay under its approved value
ceiling or use an external VRF/threshold system.
