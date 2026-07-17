# Monad Public Randomness Design

## Purpose

Build an open-source, zero-protocol-fee randomness public good for Monad
builders, plus a live landing page that lets a user connect a wallet, deploy an
isolated demo instance, submit Tx1, submit Tx2, and inspect the permanently
stored result.

The authors do not subsidize gas, storage, keepers, or prizes. Each transaction
sender pays Monad gas. Each integrating platform chooses its own request price,
including zero, and may separately choose to sponsor users.

## Product promise

- Protocol fee is permanently zero.
- Each platform has an isolated contract and isolated request storage.
- Tx1 fixes the requester, target blocks, request price, and algorithm version.
- Tx2 authenticates three future Monad block headers, derives one deterministic
  random seed, and stores it in contract state.
- Before the rescue block, only the original requester may submit Tx2.
- From `lastTargetBlock + 64`, anyone may submit Tx2, but the result remains
  assigned to the original requester.
- Once Tx2 succeeds, the result has no history-window expiry.
- The landing page works without an application backend.

## Honest security description

This product is not marketed as an unbiasable cryptographic VRF. It is
authenticated multi-block proposer entropy:

1. Tx1 chooses three future block numbers that the user cannot change.
2. Tx2 submits the raw RLP headers for those blocks.
3. The contract authenticates each raw header against Monad's canonical block
   hash.
4. The contract extracts the header `mixHash` values, which Monad uses for
   proposer entropy.
5. The contract domain-separates the final seed with the chain ID, platform
   contract, request ID, and requester.

This reduces transaction-order blockhash grinding and single-proposer
influence. A proposer can still know its own value and may skip a proposal.
The UI must visibly state that high-value prizes should use a threshold or
external VRF.

## Network assumptions

- Demo network: Monad testnet, chain ID `10143`.
- Public RPC: `https://testnet-rpc.monad.xyz`.
- Explorer: `https://testnet.monadscan.com`.
- Faucet: `https://faucet.monad.xyz`.
- Historical block hash contract:
  `0x0000F90827F1C53a10cb7A02335B175320002935`.
- EIP-2935 history window: 8,191 blocks.
- Normal finalization also accepts the EVM `blockhash` result when a target is
  within the most recent 256 blocks.
- The configured RPC must support `debug_getRawHeader`.

## On-chain architecture

### `MonadHeaderReader`

A focused Solidity library that:

- requires one canonical top-level RLP list with no trailing bytes;
- walks every header field as an RLP string;
- decodes field 8 as the block number;
- decodes field 13 as the 32-byte `mixHash`;
- rejects non-canonical strings, nested lists, truncated values, oversized
  integers, and malformed list lengths.

### `PlatformRandomness`

One immutable-code instance per integrating platform. It owns only that
platform's settings, funds, counters, requests, and results.

Constructor settings:

- platform owner;
- platform display name;
- request price;
- maximum pending requests.

Fixed algorithm settings:

- first target: request block + 8;
- second target: first target + 16;
- third target: second target + 16;
- owner finalization opens after the third target is two blocks old;
- permissionless rescue opens at third target + 64.

Tx1:

```solidity
function requestRandomness() external payable returns (uint256 requestId);
```

Tx1 requires the exact current platform request price and snapshots all target
blocks. It increments only the platform instance's pending count.

Tx2:

```solidity
function finalizeRandomness(
    uint256 requestId,
    bytes calldata header1,
    bytes calldata header2,
    bytes calldata header3
) external returns (bytes32 randomness);
```

Tx2 verifies ownership timing, authenticates the three headers, verifies their
encoded block numbers, derives the seed, stores it exactly once, and decrements
the platform-local pending count. Duplicate finalization is rejected.

Views:

```solidity
function getRequest(uint256 requestId) external view returns (Request memory);
function draw(uint256 requestId, uint256 upperBound) external view returns (uint256);
function protocolFee() external pure returns (uint256);
```

`protocolFee()` always returns zero. `draw` returns a deterministic uniform
value in `[0, upperBound)`.

Platform administration affects only future requests:

- set request price;
- set pending-request cap, never below the current pending count;
- pause or unpause new Tx1 calls;
- transfer platform ownership;
- withdraw platform request revenue.

Pausing never blocks Tx2.

### `RandomnessFactory`

A stateless, ownerless deployment helper. It charges no fee and deploys a new
`PlatformRandomness` owned by the caller. It keeps no global request queue,
global cap, or global platform array; discovery uses deployment events.

The landing page may deploy `PlatformRandomness` directly so it does not depend
on a predeployed canonical factory.

## Spam and isolation behavior

- A free platform can set request price to zero.
- A caller still pays its own Monad gas for every Tx1.
- Each instance has a hard `maxPending` cap.
- When platform A reaches its cap, only A's Tx1 is paused by capacity.
- Tx2 remains open so A can recover.
- Platforms B and C use separate state and continue normally.
- There is no on-chain loop over pending requests.
- Every request is found directly by `(platform contract, requestId)`.
- Per-wallet limits may improve UX but are not treated as Sybil protection.
- If a platform sponsors Tx1 gas, that platform must add its own coupons,
  eligibility rules, and daily budget.

Chain-wide congestion remains a shared Monad property and cannot be isolated by
an application contract.

## Landing page

The single-page product is named **Monad RND** and uses a dark, high-contrast
Monad-purple visual system with restrained motion and no decorative stock
imagery.

### Primary flow

1. Connect an injected EVM wallet.
2. Switch or add Monad testnet.
3. Use a saved/pasted platform contract, or deploy a personal isolated demo
   instance with price zero.
4. Submit Tx1 and show its transaction hash and request ID.
5. Show the three target block numbers and a live readiness indicator.
6. When ready, fetch all three raw headers from the public RPC.
7. Submit Tx2 from the requesting wallet.
8. Show the permanent seed, a 1-100 draw, source blocks, owner, finalizer,
   transaction link, and verification status.

### Result explorer

A visitor may enter any compatible platform contract address and request ID.
The page reads `getRequest` and `draw` and displays a shareable result panel.
No write permission or backend indexer is required.

### Failure handling

- No wallet: show a focused connect action.
- Wrong network: show one switch-network action.
- No MON: link to the official faucet.
- Target not ready: keep Tx2 disabled and show remaining blocks.
- RPC lacks `debug_getRawHeader`: explain that a compatible RPC is required.
- History expired: explain that the request can no longer be authenticated if
  it was never finalized.
- Duplicate/finalized request: refresh and display the stored result.
- Wallet rejection: return to the prior stable UI state.

### Persistence

Device-local storage keeps:

- the most recently used demo contract address per chain;
- recent request IDs and transaction hashes;
- no private keys, signatures, or authoritative result data.

All authoritative results are read from the platform contract.

## Accessibility and responsive behavior

- Semantic headings and form labels.
- Full keyboard operation and visible focus states.
- Status text does not rely on color alone.
- Reduced-motion media query disables nonessential animation.
- Mobile layout keeps wallet, Tx1, Tx2, and result actions in one vertical flow.
- Contract addresses and seeds wrap without horizontal overflow.

## Verification

- Forge unit tests cover RLP canonicality, real Monad header fixtures, request
  creation, pricing, caps, timing, requester-only finalization, T+64 rescue,
  duplicate races, revenue withdrawal, and platform isolation.
- Node tests cover network configuration, header RPC request construction,
  request-state formatting, result formatting, and local persistence.
- Rendered HTML tests cover the landing content, wallet controls, two-step demo,
  result explorer, security disclosure, and removal of starter metadata.
- The full site build must succeed.
- A live RPC smoke test must retrieve a Monad testnet raw header and match its
  reported block hash.

## Deployment

- Source is committed and pushed exactly as built.
- The site is published through Sites as a private production deployment.
- Because the authors hold no funded deployment key, the landing page performs
  live platform-instance deployment through the connected user's wallet.
- Contract source, ABI, and creation bytecode ship with the open-source site.

