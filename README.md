# Monad RNG

Monad RNG is an open-source, zero-protocol-fee randomness building block for
Monad applications. It uses three authenticated future Monad block headers,
stores the result permanently after Tx2, and keeps every integrating platform
in its own isolated contract.

The included website lets a nondeveloper connect a wallet, deploy a personal
test instance, make a request, finalize it, and inspect the saved result. It
does not need an application server.

## Start here

> **Tx1 locks the request; Tx2 finalizes and permanently stores the random
> result. A production integration must operate both as one flow.**

Read the guides in role order:

1. Product leads and technical owners:
   [`production-readiness.md`](docs/production-readiness.md)
2. Application and smart-contract engineers:
   [`integration-guide.md`](docs/integration-guide.md)
3. Release and deployment engineers:
   [`deployment-and-verification.md`](docs/deployment-and-verification.md)
4. Operators and support teams:
   [`operations-runbook.md`](docs/operations-runbook.md)
5. Detailed contract behavior and ABI reference:
   [`contract-integration.md`](docs/contract-integration.md)

## What you should know first

- This is **not a cryptographic VRF**. It is authenticated multi-block proposer
  entropy.
- A block proposer knows its own contribution and can choose to skip proposing.
  Three spaced blocks reduce simple single-block influence but cannot remove
  this last-proposer bias.
- Use it for free, low-value, or economically bounded draws. Use a threshold or
  external VRF when a prize is worth more than the likely cost of influencing
  a block.
- Protocol fee is always `0`.
- Each platform chooses its own request price, including `0`.
- The wallet that sends each transaction pays that transaction's Monad gas.
- The authors operate no server, private key, relayer, keeper, treasury, gas
  sponsor, or subsidy.

## Try it step by step

1. Install an injected EVM wallet such as MetaMask.
2. Add or switch to **Monad Testnet**. Its chain ID is `10143`.
3. Get test MON from the [official faucet](https://faucet.monad.xyz).
4. Open Monad RNG and connect the wallet.
5. Deploy a personal isolated demo contract. Its request price is `0`; the
   deploying wallet still pays deployment gas.
6. Press **Tx1 — request randomness**. Tx1 permanently fixes the requester and
   target blocks at request block `R + 8`, `R + 24`, and `R + 40`.
7. Wait until block `R + 42`. At the current 300 ms target pace this is roughly
   12.6 seconds after Tx1 is included, but the displayed block number is the
   authoritative rule.
8. Press **Tx2 — finalize**. The browser retrieves the three raw block headers,
   the contract authenticates them, and the requesting wallet pays Tx2 gas.
9. Read the permanent seed and the 1–100 draw from the contract.

If the wallet has already returned a transaction hash but an RPC confirmation
check fails, do **not** send the action again. The demo attempts to save each
deployment, Tx1, Tx2, and expiry hash and offers **Check submitted
transaction**. This is best-effort: the hash callback or `localStorage` write
may fail after broadcast, so a returned hash might not survive a page reload.
When a hash is available, recovery reads the existing transaction; it does not
send or charge for a new one. Without a saved hash, complete manual
sender-and-nonce reconciliation before deciding whether any retry is safe.

The demo can follow a replacement only after the original transaction becomes
queryable. Monad public RPC does not expose mempool transactions through
eth_getTransactionByHash, so a speed-up or cancel before inclusion may require
manual sender-and-nonce reconciliation.

Paid browser actions use Web Locks to prevent the same action from opening
twice across tabs. A second tab sees the saved pending transaction instead of
opening another wallet prompt, and short shared-state updates are serialized so
different simultaneous actions cannot erase each other's recovery hash. If a
browser does not support Web Locks, paid writes fail closed; wallet-free reads
and manual recovery remain available.

If the requester does not finalize, anyone may do so from `T + 64`, where `T`
is the third target block. That is block `R + 104` (roughly 31.2 seconds at
300 ms). This is permissionless rescue, **not automatic execution**: somebody
must still submit Tx2 and pay its gas.

## What happens when nobody submits Tx2

EIP-2935 keeps 8,191 historical block hashes. For this request layout:

- the last block where Tx2 can prove all three headers is `R + 8,199`;
- from `R + 8,200`, anyone may mark the request expired;
- expiration frees one platform-local pending slot;
- expiration creates no random result, reward, or refund in this primitive.

To leave time for header retrieval, wallet approval, and inclusion, the included
browser demo uses `R + 8,135` as a best-effort UI margin. It prevents starting a
new Tx2 flow once the observed head reaches that cutoff. Wallet approval, RPC
work, and block production can continue afterward, so this margin does not
guarantee broadcast or inclusion before any particular block. The contract
itself still accepts a valid Tx2 through `R + 8,199`; the site shows both
numbers so the UI margin is never mistaken for an on-chain rule.

At 300 ms per block the proof window is roughly 41 minutes, but block numbers,
not wall-clock time, control the contract.

## How a platform integrates it

1. Deploy one `PlatformRandomness` instance for the platform, directly or
   through the ownerless `RandomnessFactory`.
2. Choose the request price and `maxPending` cap. The factory and protocol
   collect no fee.
3. In the platform's own purchase or entry flow, bind every paid entry,
   inventory item, and user eligibility decision to one Tx1 request.
4. Save the `requestId` and three target blocks from `RandomnessRequested`.
5. After `R + 42`, obtain each target's RLP header with
   `debug_getRawHeader` and call `finalizeRandomness`.
6. Read `getRequest(requestId)` and `draw(requestId, upperBound)`.
7. Keep an operator or community rescue procedure for `R + 104`, and make sure
   requests are finalized before the proof window expires.

Do not let a user create many free requests and choose only a winning request
ID after seeing the outcomes. Valuable integrations should make Tx1
irreversible, charge or lock the full entry value at Tx1, settle every request,
and prevent cancellation or result-based retry. A per-wallet limit alone is
not Sybil protection.

## Isolation and spam behavior

Every platform contract has separate:

- request IDs and stored results;
- request revenue and withdrawals;
- pending-request counter and cap;
- pause and owner settings.

Filling platform A's pending cap does not consume platform B's cap or storage.
It can still increase shared Monad congestion and gas prices because every
platform uses the same chain. A request price of zero is useful for demos and
low-value products, but it makes platform-local Tx1 spam cost only the
attacker's gas.

Pausing blocks only new Tx1 requests. It never blocks Tx2, rescue, or expiry.

## Simultaneous requests and bottlenecks

There is no contract-wide queue shared by all platforms. Each Tx1 creates one
independent request in one platform contract, and each Tx2 finalizes one
request. Monad may execute transactions in parallel, but commits them in a
single deterministic order. Transactions from the same wallet are also ordered
by that wallet's nonce; different wallets can submit independently.

The practical limits are:

- the chosen platform's `maxPending` cap;
- Monad block space and gas pricing during congestion;
- the public RPC provider's published request limits;
- the fact that Tx2 is never automatic and its sender pays its gas.

One user's Tx2 does not automatically finalize another user's request. A shared
public RPC can throttle a busy application even when the contract itself has no
queue. A production integrator may configure its fork to use another
CORS-compatible RPC that supports `debug_getRawHeader`; this repository still
operates and funds no RPC service.

The included browser deliberately recognizes only the exact published
`PlatformRandomness` runtime-bytecode hash before it labels a result verified.
An ABI-shaped or modified contract is rejected. The Solidity code remains MIT
licensed and forkable, but a modified build must publish and verify its own
runtime hash in its own frontend.

## Finality and RPC behavior

Monad blocks progress from Proposed to Voted after one block and Finalized
after two blocks. The contract waits until two blocks after the third target,
so the final target has reached protocol finality before requester Tx2 opens.
Applications should also wait until a transaction's receipt block is covered
by the `finalized` block tag before calling a displayed result permanent.

The browser currently uses:

- RPC: `https://testnet-rpc.monad.xyz`
- explorer: `https://testnet.monadscan.com`
- EIP-2935 history contract:
  `0x0000F90827F1C53a10cb7A02335B175320002935`

The RPC must support `debug_getRawHeader`. The official Ankr testnet endpoint
disables `debug_*` methods, so it is not a compatible Tx2 fallback.

## Gas and economics

Monad charges a transaction's configured **gas limit**, not only the gas it
eventually uses:

```text
gas paid = gas limit × gas price
```

Always review the wallet's gas limit before signing. A platform that promises
"free" use must separately sponsor or reimburse its users; this repository
does not do so. Deployment, Tx1, Tx2, rescue, and expiry each require the
caller to pay gas.

Current Monad documentation lists a 200 million block gas limit and a 30
million per-transaction gas limit. Those are network ceilings, not estimates
of what Monad RNG calls will consume.

The platform request price is separate from gas. It is set by the platform,
paid exactly in Tx1, retained by that platform contract, and withdrawable only
by that platform's owner. No amount is routed to the authors.

## Run locally

Requirements:

- Node.js `22.13.0` or newer
- Foundry for Solidity build and tests

```bash
npm install
npm run dev
```

Then open the local URL printed by the development server.

No runtime environment variables or secrets are required. See
[`.env.example`](.env.example). Never put a private key or seed phrase in this
project.

## Verify the release

```bash
forge test -vv
node --test tests/randomness-client.test.mjs
npm test
npm run lint
node scripts/smoke-monad-rpc.mjs
```

The live smoke check verifies browser CORS, chain ID, a finalized raw RLP
header, its canonical Keccak block hash, its block-number and mixHash fields,
and an EIP-2935 hash more than 256 blocks old.

Published integration artifacts are under `public/contracts/`. Solidity source
and tests are under `contracts/`, and the detailed integration guide is
[`docs/contract-integration.md`](docs/contract-integration.md).

## Official Monad references

- [Monad testnet network information](https://docs.monad.xyz/developer-essentials/testnets)
- [Public RPC limits](https://docs.monad.xyz/reference/rpc-limits)
- [JSON-RPC overview and block tags](https://docs.monad.xyz/reference/json-rpc/overview)
- [`debug_getRawHeader` API](https://docs.monad.xyz/reference/json-rpc/api#debug-getrawheader)
- [Transaction lifecycle](https://docs.monad.xyz/monad-arch/transaction-lifecycle)
- [Gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing)
- [Historical data](https://docs.monad.xyz/developer-essentials/historical-data)
- [v0.15.0 release and 300 ms block pace](https://docs.monad.xyz/developer-essentials/changelog/releases#v0-15-0)
- [EIP-2935 specification](https://eips.ethereum.org/EIPS/eip-2935)
