import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANONICAL_CANARY,
  FINALIZE_SAFETY_BLOCKS,
  TESTNET_CHAIN_ID,
  assertCanonicalCanaryConfig,
  assertTestnetChainId,
  gasWithMargin,
  normalizeRoleAddresses,
  readinessForScenario,
  safeCastEnvironment,
  scheduleForRequestBlock,
} from "../scripts/lib/monad-testnet-e2e-core.mjs";

const REQUESTER = "0x1111111111111111111111111111111111111111";
const RESCUER = "0x2222222222222222222222222222222222222222";

test("the helper is hard-locked to Monad Testnet", () => {
  assert.equal(assertTestnetChainId("10143"), TESTNET_CHAIN_ID);
  assert.throws(() => assertTestnetChainId("143"), /Testnet-only/);
  assert.throws(() => assertTestnetChainId("31337"), /Testnet-only/);
});

test("all exact lifecycle block boundaries are derived from request block R", () => {
  assert.deepEqual(scheduleForRequestBlock(1_000n), {
    requestBlock: 1_000n,
    firstTargetBlock: 1_008n,
    secondTargetBlock: 1_024n,
    thirdTargetBlock: 1_040n,
    requesterFinalizationBlock: 1_042n,
    permissionlessRescueBlock: 1_104n,
    historicalProofBlock: 1_297n,
    lastProofValidBlock: 9_199n,
    firstExpiryBlock: 9_200n,
  });
});

test("requester Tx2 opens exactly at R+42", () => {
  assert.equal(readinessForScenario("requester", 1_000n, 1_041n).ready, false);
  const ready = readinessForScenario("requester", 1_000n, 1_042n);
  assert.equal(ready.ready, true);
  assert.equal(ready.actor, "requester");
  assert.equal(readinessForScenario("requester", 1_000n, 1_103n).ready, true);
  const permissionless = readinessForScenario("requester", 1_000n, 1_104n);
  assert.equal(permissionless.ready, false);
  assert.equal(permissionless.requesterWindowOpen, false);
});

test("permissionless rescue opens exactly at R+104", () => {
  assert.equal(readinessForScenario("rescue", 1_000n, 1_103n).ready, false);
  const ready = readinessForScenario("rescue", 1_000n, 1_104n);
  assert.equal(ready.ready, true);
  assert.equal(ready.actor, "rescuer");
});

test("historical proof waits until all three targets are at least 257 blocks old", () => {
  assert.equal(readinessForScenario("historical", 1_000n, 1_296n).ready, false);
  const ready = readinessForScenario("historical", 1_000n, 1_297n);
  assert.equal(ready.ready, true);
  assert.equal(1_297n - ready.schedule.firstTargetBlock, 289n);
  assert.equal(1_297n - ready.schedule.secondTargetBlock, 273n);
  assert.equal(1_297n - ready.schedule.thirdTargetBlock, 257n);
});

test("expiry opens exactly at R+8200", () => {
  assert.equal(readinessForScenario("expiry", 1_000n, 9_199n).ready, false);
  const ready = readinessForScenario("expiry", 1_000n, 9_200n);
  assert.equal(ready.ready, true);
  assert.equal(ready.action, "expire");
  assert.equal(ready.actor, "rescuer");
});

test("the helper refuses Tx2 inside its final safety window", () => {
  const schedule = scheduleForRequestBlock(1_000n);
  assert.equal(
    readinessForScenario(
      "rescue",
      1_000n,
      schedule.lastProofValidBlock - FINALIZE_SAFETY_BLOCKS,
    ).ready,
    true,
  );
  const tooLate = readinessForScenario(
    "rescue",
    1_000n,
    schedule.lastProofValidBlock - FINALIZE_SAFETY_BLOCKS + 1n,
  );
  assert.equal(tooLate.ready, false);
  assert.equal(tooLate.safelyBeforeExpiry, false);
});

test("requester and rescuer must be separate normalized addresses", () => {
  assert.deepEqual(normalizeRoleAddresses(REQUESTER, RESCUER), {
    requester: REQUESTER,
    rescuer: RESCUER,
  });
  assert.throws(
    () => normalizeRoleAddresses(REQUESTER, REQUESTER),
    /must be different/,
  );
});

test("the E2E helper accepts only the exact free canonical canary", () => {
  const config = {
    revenueRecipient: REQUESTER,
    platformName: CANONICAL_CANARY.platformName,
    requestPrice: CANONICAL_CANARY.requestPrice.toString(),
    maxPending: CANONICAL_CANARY.maxPending.toString(),
  };
  assert.equal(assertCanonicalCanaryConfig(config, REQUESTER), true);
  assert.throws(
    () =>
      assertCanonicalCanaryConfig(
        { ...config, revenueRecipient: RESCUER },
        REQUESTER,
      ),
    /revenueRecipient/,
  );
  assert.throws(
    () =>
      assertCanonicalCanaryConfig(
        { ...config, platformName: "lookalike" },
        REQUESTER,
      ),
    /platformName/,
  );
  assert.throws(
    () =>
      assertCanonicalCanaryConfig({ ...config, requestPrice: "1" }, REQUESTER),
    /requestPrice/,
  );
  assert.throws(
    () =>
      assertCanonicalCanaryConfig({ ...config, maxPending: "1" }, REQUESTER),
    /maxPending/,
  );
});

test("gas margin rounds up and enforces reviewed transaction caps", () => {
  assert.equal(gasWithMargin(101n, 1_000n), 122n);
  assert.equal(gasWithMargin(100n, 120n), 120n);
  assert.throws(() => gasWithMargin(101n, 120n), /exceeds the reviewed cap/);
});

test("Cast child environment drops raw signing variables and carries only file paths", () => {
  const environment = safeCastEnvironment(
    {
      PATH: "/usr/bin",
      PRIVATE_KEY: "raw-secret",
      DEPLOYER_PRIVATE_KEY: "raw-secret",
      ETH_PRIVATE_KEY: "raw-secret",
      MNEMONIC: "raw words",
      ETH_PASSWORD: "raw-secret",
    },
    {
      rpcUrl: "https://testnet-rpc.monad.xyz",
      address: REQUESTER,
      keystorePath: "/safe/requester.keystore",
      passwordFilePath: "/safe/requester.password",
    },
  );
  assert.equal(environment.PRIVATE_KEY, undefined);
  assert.equal(environment.DEPLOYER_PRIVATE_KEY, undefined);
  assert.equal(environment.ETH_PRIVATE_KEY, undefined);
  assert.equal(environment.MNEMONIC, undefined);
  assert.equal(environment.ETH_KEYSTORE, "/safe/requester.keystore");
  assert.equal(environment.ETH_PASSWORD, "/safe/requester.password");
  assert.equal(environment.CHAIN, "10143");
});

test("CLI help is transaction-free and documents every scenario", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/monad-testnet-e2e.mjs", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Testnet chain ID 10143/);
  assert.match(result.stdout, /requester/);
  assert.match(result.stdout, /rescue/);
  assert.match(result.stdout, /historical/);
  assert.match(result.stdout, /expiry/);
  assert.doesNotMatch(result.stdout, /--private-key/);
});

test("every transaction path re-attests the live Testnet contract before signing", () => {
  const source = readFileSync("scripts/monad-testnet-e2e.mjs", "utf8");
  const requestPath = source.match(
    /async function requestScenario[\s\S]*?\n}\n\nasync function actionScenario/,
  )?.[0];
  const actionPath = source.match(
    /async function actionScenario[\s\S]*?\n}\n\nasync function showStatus/,
  )?.[0];

  assert.match(requestPath ?? "", /verifyNetworkAndContract\(client, artifact, state\)/);
  assert.match(actionPath ?? "", /verifyNetworkAndContract\(client, artifact, state\)/);
  assert.ok(
    requestPath.indexOf("verifyNetworkAndContract") <
      requestPath.indexOf("reconcileScenario"),
  );
  assert.ok(
    actionPath.indexOf("verifyNetworkAndContract") <
      actionPath.indexOf("reconcileScenario"),
  );
  assert.match(source, /"--nonce",\s*nonce\.toString\(\)/);
  assert.match(source, /1\.7\.1-monad-v1\.0\.0/);
  assert.match(source, /console\.error\(sanitizedErrorMessage\(error\)\)/);
});
