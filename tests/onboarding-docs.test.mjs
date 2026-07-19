import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const publishedGuideFiles = [
  "production-readiness.md",
  "integration-guide.md",
  "deployment-and-verification.md",
  "operations-runbook.md",
];
const mandatoryFlowSentence =
  "Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.";

test("publisher copies every onboarding guide byte for byte", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "monad-rng-onboarding-docs-"),
  );

  try {
    const { guideFiles, publishOnboardingDocs } = await import(
      new URL("../scripts/publish-onboarding-docs.mjs", import.meta.url)
    );
    assert.deepEqual(guideFiles, publishedGuideFiles);

    await publishOnboardingDocs({
      root: fileURLToPath(root),
      outputDirectory,
    });

    await Promise.all(
      publishedGuideFiles.map(async (file) => {
        const [canonical, published] = await Promise.all([
          readFile(new URL(`docs/${file}`, root)),
          readFile(join(outputDirectory, file)),
        ]);
        assert.deepEqual(published, canonical, `${file} must be an exact copy`);
      }),
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("readiness guide makes Tx1 and Tx2 one mandatory product flow", async () => {
  const guide = await read("docs/production-readiness.md");
  assert.match(guide, /Tx1 locks the request/i);
  assert.match(guide, /Tx2 finalizes and permanently stores/i);
  assert.match(guide, /not automatic/i);
  assert.match(guide, /not a cryptographic VRF/i);
  assert.match(guide, /Go\/No-Go/i);
});

test("every canonical guide states the exact mandatory Tx1 and Tx2 flow", async () => {
  await Promise.all(
    publishedGuideFiles.map(async (file) => {
      const guide = await read(`docs/${file}`);
      assert.ok(
        guide.includes(mandatoryFlowSentence),
        `${file} must state the mandatory flow exactly`,
      );
    }),
  );
});

test("every canonical onboarding guide uses the Monad RNG brand", async () => {
  await Promise.all(
    ["contract-integration.md", ...publishedGuideFiles].map(async (file) => {
      const guide = await read(`docs/${file}`);
      assert.match(guide, /Monad RNG/, `${file} must name Monad RNG`);
      assert.doesNotMatch(
        guide,
        /Monad RND/,
        `${file} must not expose the retired Monad RND brand`,
      );
    }),
  );
});

test("readiness guide limits validation to Monad Testnet and requires a fresh mainnet review", async () => {
  const guide = await read("docs/production-readiness.md");
  assert.match(guide, /only Monad Testnet[^.\n]*chain ID[^.\n]*10143/i);
  assert.match(guide, /mainnet[\s\S]{0,240}RPC[^.\n]*EIP-2935/i);
  assert.match(guide, /mainnet[\s\S]{0,320}threat model/i);
  assert.match(guide, /mainnet[\s\S]{0,400}independent security review/i);
});

test("integration guide covers direct and wrapper requester semantics", async () => {
  const guide = await read("docs/integration-guide.md");
  assert.match(guide, /R\+8[^\n]*R\+24[^\n]*R\+40/i);
  assert.match(guide, /R\+42/i);
  assert.match(guide, /R\+104/i);
  assert.match(guide, /requester is the wrapper/i);
  assert.match(guide, /openEntry/);
  assert.match(guide, /finalizeEntry/);
  assert.match(guide, /entryId[^\n]*requestId[^\n]*player/i);
});

test("deployment guide verifies code, address, owner, and configuration separately", async () => {
  const guide = await read("docs/deployment-and-verification.md");
  assert.match(guide, /chain ID[^\n]*10143/i);
  assert.match(guide, /runtime hash/i);
  assert.match(guide, /approved address/i);
  assert.match(guide, /owner/i);
  assert.match(guide, /requestPrice/);
  assert.match(guide, /maxPending/);
  assert.match(guide, /deployment manifest/i);
});

test("direct deployment validates both transports, pins the chain, and narrows bytecode", async () => {
  const guide = await read("docs/deployment-and-verification.md");
  assert.match(guide, /publicClient\.getChainId\(\)/);
  assert.match(guide, /walletClient\.getChainId\(\)/);
  assert.match(guide, /chain:\s*monadTestnet/);
  assert.match(guide, /asserts value is Hex/);
  assert.match(guide, /0x\(\?:\[0-9a-fA-F\]\{2\}\)\+/);
  assert.match(guide, /bytecode:\s*creationBytecode/);
});

test("canary accepts a zero seed and compares the event result with storage", async () => {
  const guide = await read("docs/deployment-and-verification.md");
  assert.doesNotMatch(guide, /nonzero result/i);
  assert.match(
    guide,
    /RandomnessFinalized[\s\S]{0,300}event result[\s\S]{0,120}stored result/i,
  );
});

test("operations guide has a non-automatic Tx2 and nonce recovery runbook", async () => {
  const guide = await read("docs/operations-runbook.md");
  assert.match(guide, /Tx1[^\n]*Tx2/i);
  assert.match(guide, /permissionless[^\n]*not automatic/i);
  assert.match(guide, /eth_getTransactionByHash[^\n]*pending/i);
  assert.match(guide, /nonce/i);
  assert.match(guide, /R\+8199/i);
  assert.match(guide, /R\+8200/i);
  assert.match(guide, /RPC failover/i);
});

test("README describes transaction-hash persistence as best effort after broadcast", async () => {
  const readme = await read("README.md");
  assert.match(readme, /attempts to save[\s\S]{0,160}best-effort/i);
  assert.match(
    readme,
    /callback[\s\S]{0,120}localStorage[\s\S]{0,180}fail[\s\S]{0,120}broadcast/i,
  );
  assert.match(readme, /manual sender-and-nonce reconciliation/i);
  assert.doesNotMatch(readme, /saves each deployment,[\s\S]{0,80}immediately/i);
});

test("README and demo describe the cutoff as a best-effort start gate", async () => {
  const [readme, demo] = await Promise.all([
    read("README.md"),
    read("app/components/RandomnessDemo.tsx"),
  ]);

  for (const source of [readme, demo]) {
    assert.match(source, /best-effort UI margin/i);
    assert.match(source, /prevents starting a\s+new Tx2 flow/i);
    assert.match(source, /does not\s+guarantee broadcast or inclusion/i);
  }
  assert.doesNotMatch(readme, /stops all Tx2 submissions/i);
  assert.doesNotMatch(demo, /closes Tx2 64 blocks early/i);
});

test("README document map links the detailed contract reference", async () => {
  const readme = await read("README.md");
  assert.match(readme, /\(docs\/contract-integration\.md\)/);
});

test("the default Node test command includes onboarding regressions", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.match(packageJson.scripts.test, /tests\/onboarding-docs\.test\.mjs/);
});
