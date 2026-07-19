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
  assert.match(guide, /Go\/No-Go/i);
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
