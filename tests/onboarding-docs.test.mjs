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
