# Monad RNG Platform Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a role-based onboarding pack and a discoverable `/integrate` website hub that teach external Monad platforms to operate Tx1 and Tx2 as one complete randomness flow.

**Architecture:** Keep the four Markdown guides in `docs/` as the canonical source. A small build-time publisher copies those guides into `public/docs/`, while `/integrate` provides a human-readable entry point and links to the public Markdown files. The existing interactive landing page remains the demo and gains three visible paths into the integration hub: primary navigation, hero action, and public-good section.

**Tech Stack:** Markdown, Next.js 16/Vinext, React 19, TypeScript, CSS, Node.js test runner, Foundry, OpenAI Sites.

## Global Constraints

- Every guide and the `/integrate` first viewport must state: “Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.”
- Never describe Tx2, permissionless rescue, a keeper, or a smart contract as automatic execution.
- Distinguish direct EOA integration from wrapper integration: when a wrapper submits Tx1, the stored requester is the wrapper and requester-window Tx2 must be forwarded through that wrapper.
- Protocol fee is permanently `0`; every transaction sender still pays Monad gas unless an integrating platform separately sponsors it.
- Describe this as authenticated multi-block proposer entropy, not a cryptographic VRF, and require an external VRF or threshold randomness above the integration’s stated value ceiling.
- Use block numbers as authoritative: targets are `R+8`, `R+24`, `R+40`; requester Tx2 opens at `R+42`; permissionless rescue opens at `R+104`; last proof is `R+8199`; expiry starts at `R+8200`.
- State that Monad public RPC does not return pending transactions from `eth_getTransactionByHash`; the demo cannot universally guarantee speed-up/cancel replacement discovery.
- Treat the browser application as a Monad Testnet reference demo, not a production SDK, ledger, queue, keeper, or transaction journal.
- Keep `docs/*.md` as the canonical documentation; generated `public/docs/*.md` files must not be hand-edited or committed.
- Preserve the current visual language, wallet demo, contract behavior, artifact hash, package manager, and `.openai/hosting.json` project ID.
- Do not add a backend, application-owned wallet, paid service, runtime secret, new protocol fee, or new production dependency.
- The public site must expose Integrate from the desktop navigation and from a hero CTA that remains visible when navigation is hidden on narrower screens.

---

### Task 1: Production readiness and integration guides

**Files:**
- Create: `docs/production-readiness.md`
- Create: `docs/integration-guide.md`
- Test: `tests/onboarding-docs.test.mjs`

**Interfaces:**
- Consumes: Constants and lifecycle rules from `contracts/src/PlatformRandomness.sol`.
- Produces: Canonical adoption and implementation guides; exact guide titles and lifecycle phrases consumed by Task 3’s website links and tests.

- [ ] **Step 1: Write failing documentation tests**

Create `tests/onboarding-docs.test.mjs` with Node tests that read both files and assert:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("readiness guide makes Tx1 and Tx2 one mandatory product flow", async () => {
  const guide = await read("docs/production-readiness.md");
  assert.match(guide, /Tx1 locks the request/i);
  assert.match(guide, /Tx2 finalizes and permanently stores/i);
  assert.match(guide, /not automatic/i);
  assert.match(guide, /not a cryptographic VRF/i);
  assert.match(guide, /Go\\/No-Go/i);
});

test("integration guide covers direct and wrapper requester semantics", async () => {
  const guide = await read("docs/integration-guide.md");
  assert.match(guide, /R\\+8[^\\n]*R\\+24[^\\n]*R\\+40/i);
  assert.match(guide, /R\\+42/i);
  assert.match(guide, /R\\+104/i);
  assert.match(guide, /requester is the wrapper/i);
  assert.match(guide, /openEntry/);
  assert.match(guide, /finalizeEntry/);
  assert.match(guide, /entryId[^\\n]*requestId[^\\n]*player/i);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --test tests/onboarding-docs.test.mjs`

Expected: FAIL because the two guide files do not exist.

- [ ] **Step 3: Write `docs/production-readiness.md`**

Use this exact section order:

1. `The rule you cannot skip: Tx1 + Tx2`
2. `Five-minute fit check`
3. `What the primitive does`
4. `What it does not guarantee`
5. `Cost and responsibility`
6. `Full lifecycle by block number`
7. `Choose a value ceiling`
8. `Decide the expiry and customer policy`
9. `Assign production roles`
10. `Go/No-Go checklist`

The opening must explain in plain language:

```text
Tx1 locks the economic action and fixes three future target blocks.
Tx2 authenticates those blocks, derives the seed, and stores it permanently.
Tx1 without Tx2 is an unfinished request, not a random result.
```

The five-minute fit check must reject adoption when the team cannot name a Tx2 operator/rescue policy, cannot bind value during Tx1, cannot define an expiry customer policy, or needs cryptographic VRF guarantees.

The lifecycle table must contain the exact six points from the Global Constraints. The role table must assign platform owner/multisig, application wrapper, requester-window finalizer, permissionless rescue keeper, RPC operator, treasury, monitoring, and customer support.

- [ ] **Step 4: Write `docs/integration-guide.md`**

Use this exact section order:

1. `Integration outcome`
2. `Choose direct EOA or wrapper mode`
3. `Deploy or select one isolated platform contract`
4. `Implement Tx1: lock value and request together`
5. `Persist the request identity`
6. `Wait for the three targets`
7. `Implement Tx2: authenticate, finalize, and settle`
8. `Add permissionless rescue`
9. `Read the permanent result`
10. `Handle expiry`
11. `Production transaction journal`
12. `Launch checklist`

Include a direct-mode flow where the EOA is requester and a wrapper-mode flow where `PlatformRandomness` records the wrapper as requester. Include a copyable Solidity wrapper pattern with both:

```solidity
function openEntry() external payable returns (uint256 entryId, uint256 requestId)
```

and:

```solidity
function finalizeEntry(
    uint256 entryId,
    bytes calldata header1,
    bytes calldata header2,
    bytes calldata header3
) external returns (uint256 draw)
```

The example must store `entryId → {player, requestId, settled}` before later settlement, call `requestRandomness` from the wrapper in Tx1, call `finalizeRandomness` from the same wrapper in Tx2, reject duplicate settlement, and use `draw(requestId, prizeCount)` rather than raw modulo.

Document that `finalizeEntry` can be permissionless at the wrapper level because the wrapper itself remains the underlying requester, while all callers derive the same authenticated result. State that a real integration must add its own inventory, payout, reentrancy, access-control, and expiry-compensation rules.

For transaction recovery, require a durable journal keyed by a business action ID and containing chain ID, contract, calldata hash, sender, nonce, original/final hash, request ID, and state. State that Web Locks and localStorage are demo-only.

- [ ] **Step 5: Run documentation tests**

Run: `node --test tests/onboarding-docs.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add docs/production-readiness.md docs/integration-guide.md tests/onboarding-docs.test.mjs
git commit -m "docs: add RNG readiness and integration guides"
```

---

### Task 2: Deployment, verification, and operations guides

**Files:**
- Create: `docs/deployment-and-verification.md`
- Create: `docs/operations-runbook.md`
- Modify: `tests/onboarding-docs.test.mjs`
- Modify: `docs/contract-integration.md`

**Interfaces:**
- Consumes: Public artifact at `public/contracts/PlatformRandomness.json`, runtime hash exported by the current build, Monad Testnet chain ID `10143`, and lifecycle language from Task 1.
- Produces: Canonical deployment and operating procedures consumed by Task 3’s public document publisher.

- [ ] **Step 1: Add failing tests for deployment and operations**

Extend `tests/onboarding-docs.test.mjs` with:

```js
test("deployment guide verifies code, address, owner, and configuration separately", async () => {
  const guide = await read("docs/deployment-and-verification.md");
  assert.match(guide, /chain ID[^\\n]*10143/i);
  assert.match(guide, /runtime hash/i);
  assert.match(guide, /approved address/i);
  assert.match(guide, /owner/i);
  assert.match(guide, /requestPrice/);
  assert.match(guide, /maxPending/);
  assert.match(guide, /deployment manifest/i);
});

test("operations guide has a non-automatic Tx2 and nonce recovery runbook", async () => {
  const guide = await read("docs/operations-runbook.md");
  assert.match(guide, /Tx1[^\\n]*Tx2/i);
  assert.match(guide, /permissionless[^\\n]*not automatic/i);
  assert.match(guide, /eth_getTransactionByHash[^\\n]*pending/i);
  assert.match(guide, /nonce/i);
  assert.match(guide, /R\\+8199/i);
  assert.match(guide, /R\\+8200/i);
  assert.match(guide, /RPC failover/i);
});
```

- [ ] **Step 2: Run the tests and verify the two new cases fail**

Run: `node --test tests/onboarding-docs.test.mjs`

Expected: the existing Task 1 cases pass and the two new guide cases fail because the files do not exist.

- [ ] **Step 3: Write `docs/deployment-and-verification.md`**

Use this exact section order:

1. `Supported baseline`
2. `Before deployment`
3. `Choose direct deployment or Factory`
4. `Direct deployment`
5. `Factory deployment`
6. `Create the deployment manifest`
7. `Verify chain and bytecode`
8. `Verify approved address, owner, and settings`
9. `Verify source on an explorer`
10. `Run a canary Tx1 + Tx2`
11. `Go live or discard the deployment`

State that the repository has been verified only against Monad Testnet chain ID `10143`, that mainnet adoption needs fresh network/RPC/EIP-2935 verification and security review, and that current internal review is not an external audit.

Show direct deployment using Foundry creation bytecode or a short Viem example based on the published artifact. Show Factory deployment as optional and note that the current public JSON artifact covers `PlatformRandomness`; a team using Factory must build/verify `RandomnessFactory` from source until a Factory artifact is published.

The deployment manifest example must include network name, chain ID, platform address, approved address, deployment transaction, deployment block, owner, platform name, request price, max pending, pause state, runtime hash, source commit, compiler version, optimizer profile, and verification URL.

Use the exact runtime hash produced by `public/contracts/PlatformRandomness.json`; read it from the file during implementation rather than copying an unverified value from conversation context.

- [ ] **Step 4: Write `docs/operations-runbook.md`**

Use this exact section order:

1. `Operating promise`
2. `Normal Tx1 → Tx2 path`
3. `Requester-window finalization`
4. `Permissionless rescue`
5. `Proof deadline and expiry`
6. `Transaction states and safe retry rules`
7. `Monad replacement limitation`
8. `RPC health check and failover`
9. `Monitoring and alerts`
10. `Incident runbooks`
11. `Customer support answers`

The normal flow must require monitoring every `RandomnessRequested` through `RandomnessFinalized` or `RandomnessRequestExpired`. The retry state table must distinguish not-broadcast, pending/unknown, finalized success, finalized revert, confirmed replacement with identical action, and nonce consumed by a different action.

State that Monad’s `eth_getTransactionByHash` returns `null` for mempool transactions. A dropped or replaced transaction cannot be declared safe to retry from timeout alone. Require sender+nonce reconciliation against canonical blocks and an audit entry before clearing a pending action.

RPC startup health checks must include `eth_chainId`, `finalized`, `debug_getRawHeader`, browser CORS when relevant, EIP-2935 lookup, bounded timeout, rate limit, and failover. Include incident procedures for RPC outage, keeper balance low, pending cap full, proof deadline near, owner key compromise, corrupt event index, and expired request.

- [ ] **Step 5: Correct the wrapper requester explanation in `docs/contract-integration.md`**

Immediately after the existing Tx1 wrapper checklist, add a warning that `msg.sender` at `PlatformRandomness` is the wrapper. Explain that:

- the player EOA cannot directly call requester-window Tx2;
- the wrapper must expose a forwarding function that calls `finalizeRandomness`;
- the wrapper must keep its own `requestId → player/entry` mapping;
- without forwarding, direct permissionless finalization is delayed until `R+104`.

Also replace any universal speed-up/cancel guarantee in this document if present with the Monad pending-query limitation.

- [ ] **Step 6: Run the documentation tests**

Run: `node --test tests/onboarding-docs.test.mjs`

Expected: 4 tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add docs/deployment-and-verification.md docs/operations-runbook.md docs/contract-integration.md tests/onboarding-docs.test.mjs
git commit -m "docs: add deployment and operations playbooks"
```

---

### Task 3: Public Integrate hub and landing-page discovery

**Files:**
- Create: `app/integrate/page.tsx`
- Create: `scripts/publish-onboarding-docs.mjs`
- Modify: `app/components/RandomnessDemo.tsx`
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `tests/onboarding-docs.test.mjs`
- Modify: `README.md`
- Generated, ignored: `public/docs/*.md`

**Interfaces:**
- Consumes: Four canonical guide files from Tasks 1–2.
- Produces: `/integrate`, public Markdown URLs under `/docs/`, and three landing-page entry paths.

- [ ] **Step 1: Add failing site and publisher tests**

Extend `tests/rendered-html.test.mjs` so its render helper accepts a path:

```js
async function render(pathname = "/") {
  // Existing worker import stays unchanged.
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    // Existing bindings and execution context stay unchanged.
  );
}
```

Add assertions to the landing test for an `/integrate` navigation link and hero CTA. Add a new test that renders `/integrate` and asserts:

```js
assert.match(html, /Integrate Monad RNG/i);
assert.match(html, /Tx1 locks the request/i);
assert.match(html, /Tx2 finalizes and permanently stores/i);
assert.match(html, /production-readiness\\.md/);
assert.match(html, /integration-guide\\.md/);
assert.match(html, /deployment-and-verification\\.md/);
assert.match(html, /operations-runbook\\.md/);
assert.match(html, /reference demo, not a production SDK/i);
```

Extend `tests/onboarding-docs.test.mjs` to run `scripts/publish-onboarding-docs.mjs` in a temporary output directory and verify all four copied files are byte-for-byte equal to their canonical sources.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm run build && node --test tests/rendered-html.test.mjs tests/onboarding-docs.test.mjs`

Expected: FAIL because `/integrate`, landing links, and publisher do not exist.

- [ ] **Step 3: Implement the documentation publisher**

Create `scripts/publish-onboarding-docs.mjs` with:

```js
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const guideFiles = [
  "production-readiness.md",
  "integration-guide.md",
  "deployment-and-verification.md",
  "operations-runbook.md",
];

export async function publishOnboardingDocs({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  outputDirectory = resolve(root, "public/docs"),
} = {}) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    guideFiles.map((file) =>
      copyFile(resolve(root, "docs", file), resolve(outputDirectory, file)),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishOnboardingDocs();
}
```

Add `"docs:publish": "node scripts/publish-onboarding-docs.mjs"`, `"predev": "npm run docs:publish"`, and `"prebuild": "npm run docs:publish"` to `package.json`. Add `/public/docs/` to `.gitignore`.

- [ ] **Step 4: Implement `app/integrate/page.tsx`**

Build a server-rendered page in the existing design language with:

- a header linking the wordmark back to `/`;
- a `Run demo` link to `/#demo`;
- an opening eyebrow `Platform onboarding`;
- H1 `Integrate Monad RNG`;
- an above-the-fold warning card containing the exact mandatory Tx1+Tx2 sentence;
- a four-step flow: Tx1 lock, wait for targets, Tx2 finalize, settle from stored result;
- four role-based guide cards linking to `/docs/<filename>`;
- a direct EOA vs wrapper comparison;
- a lifecycle block table with all six authoritative block points;
- a production boundary section covering non-VRF, caller gas, no automatic rescue, RPC/replacement limits, browser demo scope, and expiry;
- final CTAs to `/#demo` and `/contracts/PlatformRandomness.json`;
- a home link in the footer.

Use semantic headings, lists, tables, and accessible link labels. Do not add client state or a new dependency.

- [ ] **Step 5: Add site styles**

Add namespaced `.integrate-*` styles to `app/globals.css`. Reuse current variables, button classes, page width, wordmark, and focus styles. At widths under `860px`, stack the warning, guide cards, comparisons, and lifecycle table safely. At widths under `620px`, make CTA links full width and preserve a minimum 44px touch target.

- [ ] **Step 6: Add three landing-page entry paths**

In `app/components/RandomnessDemo.tsx`:

1. Add `<a href="/integrate">Integrate</a>` as the first primary-navigation item.
2. Add a hero action `<a className="button button--secondary" href="/integrate">Integration guide</a>`.
3. Add an `/integrate` link labeled `Platform onboarding →` in the public-good source links.

Because the primary navigation is hidden below `1180px`, the hero CTA is the required mobile/tablet discovery path.

Replace the README’s universal replacement statement with:

```text
The demo can follow a replacement only after the original transaction becomes
queryable. Monad public RPC does not expose mempool transactions through
eth_getTransactionByHash, so a speed-up or cancel before inclusion may require
manual sender-and-nonce reconciliation.
```

Add a `Start here` document map near the top of README, with the four guides in role order and a strong Tx1+Tx2 warning.

- [ ] **Step 7: Update metadata copy**

Change the site description in `app/layout.tsx` so it says the primitive locks Tx1 and finalizes/stores through Tx2 as one flow. Preserve the existing title and dynamic-origin metadata behavior.

- [ ] **Step 8: Run focused and full application tests**

Run:

```bash
npm run build
node --test tests/rendered-html.test.mjs tests/onboarding-docs.test.mjs
npm test
npm run lint
```

Expected: build passes; focused tests pass; all application tests pass; lint exits `0`.

- [ ] **Step 9: Commit Task 3**

```bash
git add .gitignore README.md app/components/RandomnessDemo.tsx app/globals.css app/integrate/page.tsx app/layout.tsx package.json scripts/publish-onboarding-docs.mjs tests/onboarding-docs.test.mjs tests/rendered-html.test.mjs
git commit -m "feat: publish platform integration hub"
```

---

### Task 4: Social preview, full verification, and publication

**Files:**
- Modify: `public/og.png`
- Modify if image dimensions change: `app/layout.tsx`
- Verify only: all source, docs, tests, and `.openai/hosting.json`

**Interfaces:**
- Consumes: Completed landing page and Integrate hub.
- Produces: Exact validated source commit, public Sites deployment, and external builder access.

- [ ] **Step 1: Generate and inspect one site-specific social card**

Generate one landscape card using the existing black-grid, Monad-purple, and lime visual system. Required visible text:

```text
Monad RNG
Tx1 locks. Tx2 finalizes.
Public randomness infrastructure for Monad builders
```

The design must visually connect two transaction nodes into one permanent result. Inspect the image for exact text. Retry once only if text is incorrect or illegible.

- [ ] **Step 2: Save the validated card and update dimensions**

Save the final image as `public/og.png`. If its actual dimensions differ from the current metadata values, update `width` and `height` in `app/layout.tsx`.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm run contracts:export
forge fmt --check
forge test -vv
npm test
npm run lint
node scripts/smoke-monad-rpc.mjs
npm audit --audit-level=low
git diff --check
```

Expected: artifact export has no unexpected source diff; all 53 or more Forge tests pass; all Node/application tests pass; lint passes; Monad live smoke passes for chain `10143`, CORS, finalized header, raw-header hash, mixHash, and EIP-2935; audit reports zero known vulnerabilities; diff check is clean.

- [ ] **Step 4: Perform final independent review**

Review the full implementation against:

- `docs/superpowers/specs/2026-07-19-platform-onboarding-design.md`
- the Global Constraints above;
- actual `PlatformRandomness.sol` timing and requester semantics;
- official Monad pending-transaction behavior;
- desktop and narrow-screen Integrate discoverability;
- public document URLs;
- claim consistency between README, guides, landing, and `/integrate`.

Resolve all Critical and Important findings and rerun their covering tests.

- [ ] **Step 5: Commit the final validated source**

```bash
git add public/og.png app/layout.tsx
git commit -m "chore: refresh Monad RNG social preview"
```

If `app/layout.tsx` did not change, commit only `public/og.png`.

- [ ] **Step 6: Publish the exact commit with Sites**

Reuse the `project_id` from `.openai/hosting.json`. Push the exact validated source state, package the matching build output, save one Sites version with that commit SHA, and deploy it publicly as explicitly approved by the user.

- [ ] **Step 7: Verify the production deployment**

Confirm the deployment reaches `succeeded`, then verify:

1. `/` returns `200` and exposes Integrate in the landing HTML.
2. `/integrate` returns `200` and contains the mandatory Tx1+Tx2 warning.
3. all four `/docs/*.md` URLs return `200`.
4. `/contracts/PlatformRandomness.json` returns `200` and retains the published runtime hash.
5. public access works without owner authentication.

- [ ] **Step 8: Open the deployed site and report the result**

Open the exact production URL in the Codex browser and return the URL plus a concise summary of the new onboarding path and validation outcome.
