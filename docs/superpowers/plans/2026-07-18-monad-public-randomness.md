# Monad Public Randomness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a tested Monad block-randomness contract and a deployed landing page where a connected wallet deploys an isolated demo instance, executes Tx1 and Tx2, and reads the permanent result.

**Architecture:** Solidity contracts authenticate three future Monad RLP headers and store a domain-separated seed in a platform-local instance. A backend-free React landing page uses an injected wallet plus Monad's public RPC for deployment, requests, raw-header retrieval, finalization, and result inspection.

**Tech Stack:** Solidity 0.8.28, Foundry, React 19, Next-compatible vinext, TypeScript, viem, Node test runner, Cloudflare Workers/Sites.

## Global Constraints

- Protocol fee is permanently zero and there is no author treasury.
- Every user pays their own Monad gas unless an integrating platform independently sponsors it.
- Every platform instance has separate storage, funds, counters, and caps.
- Demo network is Monad testnet chain ID `10143`.
- Public RPC is `https://testnet-rpc.monad.xyz`.
- Tx1 uses target offsets `+8`, `+24`, and `+40`.
- Owner Tx2 opens two blocks after the third target.
- Permissionless rescue opens at third target `+64`.
- Three authenticated header `mixHash` values feed the final seed.
- The UI must not call the construction a cryptographic VRF.
- No backend, private-key storage, server-owned wallet, or protocol subsidy.
- Existing requests remain finalizable when new requests are paused.

---

### Task 1: Contract test harness and Monad header reader

**Files:**
- Create: `foundry.toml`
- Create: `contracts/test/fixtures/MonadHeaderFixture.sol`
- Create: `contracts/test/MonadHeaderReader.t.sol`
- Create: `contracts/src/MonadHeaderReader.sol`
- Create: `contracts/lib/forge-std/**` through Foundry dependency installation

**Interfaces:**
- Consumes: a real Monad testnet raw RLP header fixture.
- Produces: `MonadHeaderReader.readNumberAndMixHash(bytes calldata) returns (uint256, bytes32)`.

- [ ] **Step 1: Install the generated Foundry test dependency**

Run:

```bash
forge install foundry-rs/forge-std --no-git
```

Expected: `contracts/lib/forge-std/src/Test.sol` exists.

- [ ] **Step 2: Write the failing fixture and parser tests**

Create tests that call:

```solidity
(uint256 number, bytes32 mixHash) =
    harness.readNumberAndMixHash(MonadHeaderFixture.rawHeader());
assertEq(number, 45_730_415);
assertEq(
    mixHash,
    0x03ff4794124a285d6f8024f7620315ccf5233c1e252bb7843e45e3a06ff604e9
);
```

Add separate tests that reject a non-list, a truncated list, trailing bytes,
nested header fields, non-canonical short strings, a block number longer than
32 bytes, and a `mixHash` that is not 32 bytes.

- [ ] **Step 3: Run the parser tests and verify RED**

Run:

```bash
forge test --match-contract MonadHeaderReaderTest -vv
```

Expected: compilation fails because `MonadHeaderReader.sol` does not exist.

- [ ] **Step 4: Implement the minimal canonical RLP parser**

Implement `MonadHeaderReader` with custom errors for malformed RLP, invalid
field type, invalid block number, and invalid mixHash. Parse the complete outer
list, capture fields 8 and 13, and verify that the outer encoded length equals
the calldata length.

- [ ] **Step 5: Run the parser tests and verify GREEN**

Run:

```bash
forge test --match-contract MonadHeaderReaderTest -vv
```

Expected: all parser tests pass.

- [ ] **Step 6: Commit the parser**

```bash
git add foundry.toml contracts
git commit -m "feat: authenticate Monad header fields"
```

### Task 2: Platform-isolated randomness lifecycle

**Files:**
- Create: `contracts/test/PlatformRandomness.t.sol`
- Create: `contracts/src/PlatformRandomness.sol`

**Interfaces:**
- Consumes: `MonadHeaderReader.readNumberAndMixHash`.
- Produces: `requestRandomness`, `finalizeRandomness`, `getRequest`, `draw`,
  `setRequestPrice`, `setMaxPending`, `setRequestsPaused`, `withdraw`, and
  `transferOwnership`.

- [ ] **Step 1: Write failing Tx1 tests**

Test exact pricing, zero-price requests, target blocks `+8/+24/+40`, the
platform-local request counter, pending cap, pause behavior, and owner-only
configuration.

- [ ] **Step 2: Run Tx1 tests and verify RED**

Run:

```bash
forge test --match-contract PlatformRandomnessTest --match-test test_Request -vv
```

Expected: compilation fails because `PlatformRandomness` does not exist.

- [ ] **Step 3: Implement minimal Tx1 and administration**

Use a platform-local mapping keyed by sequential `uint256 requestId`, require
exact `msg.value`, snapshot all target blocks, and keep finalization enabled
while request creation is paused.

- [ ] **Step 4: Run Tx1 tests and verify GREEN**

Run:

```bash
forge test --match-contract PlatformRandomnessTest --match-test test_Request -vv
```

Expected: all Tx1 tests pass.

- [ ] **Step 5: Write failing Tx2 tests**

Use `vm.setBlockhash` and valid fixture-derived headers to prove:

```solidity
bytes32 expected = keccak256(
    abi.encode(
        "MONAD_PUBLIC_RANDOMNESS_V1",
        block.chainid,
        address(randomness),
        requestId,
        alice,
        mixHash1,
        mixHash2,
        mixHash3
    )
);
```

Cover too-early calls, header/block mismatch, requester-only timing, T+64
permissionless rescue, duplicate finalization, pending-count release, and
permanent result reads. Cover the last EIP-2935-valid block and permissionless
no-refund expiration on the following block. Test deterministic rejection
sampling with a forced rejection candidate.

- [ ] **Step 6: Run Tx2 tests and verify RED**

Run:

```bash
forge test --match-contract PlatformRandomnessTest --match-test test_Finalize -vv
```

Expected: tests fail because finalization behavior is missing.

- [ ] **Step 7: Implement header authentication and Tx2**

Authenticate recent targets with `blockhash`; otherwise query
`0x0000F90827F1C53a10cb7A02335B175320002935`. Verify all encoded block numbers,
derive and store one seed, and release one pending slot before emitting the
finalization event. Pack each stored request into three slots, derive the fixed
target offsets when reading, use unbiased bounded draws, and allow anyone to
mark a request expired only after its first target leaves the 8,191-block
history window. Expiration releases local capacity without a refund or reward.

- [ ] **Step 8: Run all lifecycle tests and verify GREEN**

Run:

```bash
forge test --match-contract PlatformRandomnessTest -vv
```

Expected: all lifecycle tests pass.

- [ ] **Step 9: Commit the lifecycle**

```bash
git add contracts
git commit -m "feat: add isolated two-transaction randomness"
```

### Task 3: Zero-fee factory, artifact, and contract documentation

**Files:**
- Create: `contracts/test/RandomnessFactory.t.sol`
- Create: `contracts/src/RandomnessFactory.sol`
- Create: `contracts/script/Deploy.s.sol`
- Create: `scripts/export-contract-artifact.mjs`
- Create: `public/contracts/PlatformRandomness.json`
- Create: `public/contracts/PlatformRandomness.sol`
- Create: `docs/contract-integration.md`

**Interfaces:**
- Consumes: `PlatformRandomness` constructor and ABI.
- Produces: an ownerless `deployPlatform` factory, browser-consumable ABI and
  creation bytecode, and integration instructions.

- [ ] **Step 1: Write the failing factory test**

Assert that `deployPlatform("Demo", 0, 128)` creates an instance owned by the
caller, reports `protocolFee() == 0`, and does not share counters or balances
with another deployed instance.

- [ ] **Step 2: Run the factory test and verify RED**

Run:

```bash
forge test --match-contract RandomnessFactoryTest -vv
```

Expected: compilation fails because `RandomnessFactory` does not exist.

- [ ] **Step 3: Implement the ownerless factory**

Deploy full immutable-code platform instances, emit one indexed deployment
event, and keep no platform array, fee balance, owner, or upgrade path.

- [ ] **Step 4: Run factory and full contract tests**

Run:

```bash
forge test -vv
```

Expected: all contract tests pass.

- [ ] **Step 5: Export the browser artifact**

Build with Forge, then write a deterministic script that copies the contract
ABI and creation bytecode to `public/contracts/PlatformRandomness.json` and
copies the verified Solidity sources for download.

- [ ] **Step 6: Document integration**

Document direct deployment, Tx1, target readiness, raw-header retrieval, Tx2,
T+64 rescue, result reads, zero protocol fee, platform pricing, and the
non-VRF security disclosure.

- [ ] **Step 7: Commit factory and artifacts**

```bash
git add contracts scripts public/contracts docs/contract-integration.md
git commit -m "feat: publish zero-fee platform deployment kit"
```

### Task 4: Browser contract client

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `app/lib/network.ts`
- Create: `app/lib/randomness.ts`
- Create: `app/lib/storage.ts`
- Create: `tests/randomness-client.test.mjs`

**Interfaces:**
- Consumes: exported ABI/bytecode and injected `window.ethereum`.
- Produces: network switching, demo deployment, Tx1, raw-header retrieval, Tx2,
  result reads, formatting helpers, and device-local recent-request storage.

- [ ] **Step 1: Add viem and write failing client tests**

Install `viem`. Test the exact Monad chain definition, three
`debug_getRawHeader` requests, readiness calculation, request formatting,
1-100 result formatting, address validation, and storage schema migration.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
node --test tests/randomness-client.test.mjs
```

Expected: module-not-found failures for the new client modules.

- [ ] **Step 3: Implement the pure helpers and wallet operations**

Keep authoritative reads on-chain. Store only chain ID, contract address,
request ID, and transaction hashes locally. Never store wallet secrets or
signed transactions.

- [ ] **Step 4: Run client tests and verify GREEN**

Run:

```bash
node --test tests/randomness-client.test.mjs
```

Expected: all client tests pass.

- [ ] **Step 5: Commit the browser client**

```bash
git add package.json package-lock.json app/lib tests/randomness-client.test.mjs
git commit -m "feat: add backend-free Monad wallet client"
```

### Task 5: Landing page and result explorer

**Files:**
- Delete: `app/_sites-preview/SkeletonPreview.tsx`
- Delete: `app/_sites-preview/preview.css`
- Modify: `app/page.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Create: `app/components/RandomnessDemo.tsx`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Replace: `public/favicon.svg`

**Interfaces:**
- Consumes: `app/lib/randomness.ts`, `app/lib/network.ts`, and exported contract
  artifact.
- Produces: responsive landing content, wallet flow, deploy flow, Tx1, Tx2,
  permanent result card, and public result lookup.

- [ ] **Step 1: Replace starter assertions with failing product assertions**

Require rendered HTML to include `Monad RNG`, `Connect wallet`, `Tx1 · Lock
request`, `Tx2 · Store result`, `Result explorer`, `Protocol fee · 0`, and the
non-VRF disclosure. Assert starter metadata and `react-loading-skeleton` are
absent.

- [ ] **Step 2: Run rendered test and verify RED**

Run:

```bash
npm test
```

Expected: rendered assertions fail against the starter skeleton.

- [ ] **Step 3: Implement the complete page**

Build one focused client demo component with explicit stable states:
disconnected, wrong network, ready, deploying, requesting, waiting, finalizing,
finalized, and error. Use one primary action per state and preserve explorer
access without a wallet.

- [ ] **Step 4: Implement responsive styling and metadata**

Use a dark ink background, Monad-purple accent, lime verification highlight,
large editorial type, compact monospaced chain data, visible focus states, and
reduced-motion support. Remove all starter preview code and metadata.

- [ ] **Step 5: Run rendered tests and build**

Run:

```bash
npm test
npm run lint
```

Expected: rendered tests pass, build succeeds, and lint reports zero errors.

- [ ] **Step 6: Commit the landing page**

```bash
git add app public package.json package-lock.json tests
git commit -m "feat: launch Monad RNG interactive landing page"
```

### Task 6: Live integration, security review, and Sites deployment

**Files:**
- Create: `scripts/smoke-monad-rpc.mjs`
- Create: `.env.example`
- Modify: `README.md`
- Modify: `.openai/hosting.json`

**Interfaces:**
- Consumes: complete contracts, browser client, and built site.
- Produces: live RPC evidence, final documentation, exact source commit, saved
  Sites version, and production deployment.

- [ ] **Step 1: Write and run the live RPC smoke test**

Fetch a finalized Monad testnet block, call `debug_getRawHeader`, hash the raw
header, and assert it equals the block's reported hash.

Run:

```bash
node scripts/smoke-monad-rpc.mjs
```

Expected: prints the verified block number and `header hash matched`.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
forge test -vv
node --test tests/randomness-client.test.mjs
npm test
npm run lint
```

Expected: zero failures and zero lint errors.

- [ ] **Step 3: Perform a requirement and security review**

Confirm zero protocol fee, no treasury, platform isolation, exact target
offsets, T+64 rescue, write-once result, pause-safe Tx2, no secret persistence,
visible non-VRF disclosure, and successful public result lookup.

- [ ] **Step 4: Commit the exact validated source**

```bash
git add .
git commit -m "chore: verify Monad RNG release"
```

- [ ] **Step 5: Publish through Sites**

Create or reuse the site project, push the exact validated commit, package the
matching build, save one version, deploy it privately, and poll until production
status succeeds.
