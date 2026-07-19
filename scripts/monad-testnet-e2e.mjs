#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  fromRlp,
  getAddress,
  http,
  keccak256,
  toHex,
} from "viem";

import {
  CANONICAL_CANARY,
  FINALIZE_SAFETY_BLOCKS,
  HISTORY_STORAGE,
  SCENARIO_DEFINITIONS,
  SCENARIO_NAMES,
  TESTNET_CHAIN_ID,
  asJson,
  assertCanonicalCanaryConfig,
  assertTestnetChainId,
  gasWithMargin,
  normalizeRoleAddresses,
  publicRpcLabel,
  readinessForScenario,
  requireScenarioName,
  safeCastEnvironment,
  scheduleForRequestBlock,
} from "./lib/monad-testnet-e2e-core.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const ARTIFACT_PATH = resolve(ROOT, "public/contracts/PlatformRandomness.json");
const DEFAULT_STATE_PATH = resolve(ROOT, "work/e2e/monad-testnet-v1.json");
const RPC_URL =
  process.env.MONAD_E2E_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const STATE_PATH = resolve(process.env.MONAD_E2E_STATE ?? DEFAULT_STATE_PATH);
const TIMEOUT_MS = Number(process.env.MONAD_E2E_TIMEOUT_MS ?? "180000");
const POLL_MS = Number(process.env.MONAD_E2E_POLL_MS ?? "1000");
const DRAW_UPPER_BOUND = 100n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TX1_GAS_CAP = 300_000n;
const TX2_GAS_CAP = 1_000_000n;
const EXPIRY_GAS_CAP = 150_000n;
const RAW_HEADER_MAX_BYTES = 4_096;
const EXPECTED_CAST_VERSION = "1.7.1-monad-v1.0.0";
const EXPECTED_CAST_COMMIT = "bb49277de2e0979b9d37dc0e5f7f18f24b0262b8";

const HELP = `
Monad RNG V1 Testnet E2E helper

This tool is deliberately locked to the "${CANONICAL_CANARY.platformName}" free
public canary created by Deploy.s.sol on Monad Testnet chain ID 10143. It
requires the requester to be the canary's fixed revenue recipient, verifies the
exact name, zero price, and unlimited cap, and never accepts a raw private key
or mnemonic. Cast decrypts an encrypted keystore using a private password file
supplied by path.

Commands:
  init                     Verify code/config and create a public state file.
  status                   Re-read finalized state and show all four scenarios.
  request <scenario>       Send one Tx1 as the requester.
  act <scenario>           Finalize or expire once that scenario is eligible.

Scenarios:
  requester                Requester Tx2 from R+42 through R+103.
  rescue                   Separate rescuer Tx2 at R+104 or later.
  historical               Tx2 at R+297 or later; all targets are 257+ blocks old.
  expiry                   Separate rescuer expires at R+8200 or later.

Required for init:
  MONAD_E2E_CONTRACT
  MONAD_E2E_REQUESTER_ADDRESS
  MONAD_E2E_RESCUER_ADDRESS

Required only for a transaction signed by ROLE (REQUESTER or RESCUER):
  MONAD_E2E_<ROLE>_KEYSTORE
  MONAD_E2E_<ROLE>_PASSWORD_FILE

Optional:
  MONAD_E2E_RPC_URL         Defaults to the official Monad Testnet RPC.
  MONAD_E2E_STATE           Defaults to work/e2e/monad-testnet-v1.json.
  MONAD_E2E_TIMEOUT_MS      Defaults to 180000.
  MONAD_E2E_POLL_MS         Defaults to 1000.

Run one command at a time. Do not run this helper concurrently with another
transaction process using either signer. An unresolved pre-broadcast intent is
intentionally not retried automatically.
`.trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizedErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}/[redacted]`;
    } catch {
      return "[redacted URL]";
    }
  });
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /(AUTH|KEY|MNEMONIC|PASSWORD|SECRET|TOKEN)/i.test(name) &&
      typeof value === "string" &&
      value.length >= 4
    ) {
      message = message.split(value).join("[redacted]");
    }
  }
  return message.slice(0, 1_000);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function normalizeHash(value, label = "hash") {
  assert(
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
    `${label} must be 32-byte hex`,
  );
  return value.toLowerCase();
}

function normalizeHexBytes(value, label, maxBytes = undefined) {
  assert(
    typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value),
    `${label} must be even-length hex bytes`,
  );
  if (maxBytes !== undefined) {
    assert((value.length - 2) / 2 <= maxBytes, `${label} is too large`);
  }
  return value;
}

function normalizeRequest(value) {
  const read = (name, index) =>
    Array.isArray(value) ? value[index] : value?.[name];
  return {
    requester: getAddress(read("requester", 0)),
    requestBlock: BigInt(read("requestBlock", 1)),
    firstTargetBlock: BigInt(read("firstTargetBlock", 2)),
    secondTargetBlock: BigInt(read("secondTargetBlock", 3)),
    thirdTargetBlock: BigInt(read("thirdTargetBlock", 4)),
    pricePaid: BigInt(read("pricePaid", 5)),
    finalizer: getAddress(read("finalizer", 6)),
    result: normalizeHash(read("result", 7), "stored result"),
    finalized: Boolean(read("finalized", 8)),
    expired: Boolean(read("expired", 9)),
  };
}

async function loadArtifact() {
  const parsed = JSON.parse(await readFile(ARTIFACT_PATH, "utf8"));
  assert(parsed?.schemaVersion === 2, "Unexpected artifact schema");
  assert(Array.isArray(parsed.abi), "Artifact ABI is missing");
  normalizeHexBytes(parsed.runtimeBytecode, "artifact runtime bytecode");
  const calculatedHash = keccak256(parsed.runtimeBytecode);
  assert(
    calculatedHash.toLowerCase() ===
      normalizeHash(parsed.runtimeBytecodeHash, "artifact runtime hash"),
    "Artifact runtime bytecode does not match its published hash",
  );
  return parsed;
}

function createClient() {
  assertTestnetChainId(process.env.MONAD_E2E_CHAIN_ID ?? TESTNET_CHAIN_ID);
  assert(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS >= 10_000, "Invalid timeout");
  assert(Number.isFinite(POLL_MS) && POLL_MS >= 250, "Invalid poll interval");
  return createPublicClient({
    transport: http(RPC_URL, {
      timeout: Math.min(TIMEOUT_MS, 30_000),
      retryCount: 1,
    }),
  });
}

async function readState(required = true) {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    assert(parsed.schemaVersion === 1, "Unsupported E2E state schema");
    assertTestnetChainId(parsed.chainId);
    parsed.contractAddress = getAddress(parsed.contractAddress);
    parsed.roles = normalizeRoleAddresses(
      parsed.roles.requester,
      parsed.roles.rescuer,
    );
    for (const name of SCENARIO_NAMES) {
      assert(parsed.scenarios?.[name], `State is missing scenario ${name}`);
    }
    return parsed;
  } catch (error) {
    if (!required && error?.code === "ENOENT") return undefined;
    if (error?.code === "ENOENT") {
      throw new Error(`State file not found: run "init" first (${STATE_PATH})`);
    }
    throw error;
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${asJson(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, STATE_PATH);
}

async function verifyNetworkAndContract(client, artifact, stateOrInput) {
  const chainId = BigInt(await client.getChainId());
  assertTestnetChainId(chainId);

  const contractAddress = getAddress(stateOrInput.contractAddress);
  const code = await client.getCode({ address: contractAddress });
  normalizeHexBytes(code, "deployed runtime bytecode");
  assert(code !== "0x", `No contract code at ${contractAddress}`);
  const runtimeHash = keccak256(code);
  assert(
    runtimeHash.toLowerCase() === artifact.runtimeBytecodeHash.toLowerCase(),
    `Runtime mismatch: expected ${artifact.runtimeBytecodeHash}, received ${runtimeHash}`,
  );

  const read = (functionName) =>
    client.readContract({
      address: contractAddress,
      abi: artifact.abi,
      functionName,
      blockTag: "finalized",
    });
  const [
    version,
    configurationLocked,
    protocolFee,
    revenueRecipient,
    platformName,
    requestPrice,
    maxPending,
    pendingCount,
    nextRequestId,
  ] = await Promise.all([
    read("VERSION"),
    read("CONFIGURATION_LOCKED"),
    read("protocolFee"),
    read("revenueRecipient"),
    read("platformName"),
    read("requestPrice"),
    read("maxPending"),
    read("pendingCount"),
    read("nextRequestId"),
  ]);

  assert(BigInt(version) === 1n, `Unexpected VERSION: ${version}`);
  assert(configurationLocked === true, "CONFIGURATION_LOCKED is not true");
  assert(BigInt(protocolFee) === 0n, `protocolFee is not zero: ${protocolFee}`);

  const config = {
    runtimeHash: runtimeHash.toLowerCase(),
    version: "1",
    configurationLocked: true,
    protocolFee: "0",
    revenueRecipient: getAddress(revenueRecipient),
    platformName,
    requestPrice: BigInt(requestPrice).toString(),
    maxPending: BigInt(maxPending).toString(),
  };

  if (stateOrInput.config) {
    for (const key of Object.keys(config)) {
      assert(
        stateOrInput.config[key] === config[key],
        `Frozen config changed at ${key}: expected ${stateOrInput.config[key]}, received ${config[key]}`,
      );
    }
  }

  return {
    chainId,
    contractAddress,
    config,
    pendingCount: BigInt(pendingCount),
    nextRequestId: BigInt(nextRequestId),
  };
}

async function getFinalizedBlock(client) {
  const block = await client.getBlock({ blockTag: "finalized" });
  assert(
    block?.number !== null && block?.number !== undefined,
    "Finalized block has no number",
  );
  normalizeHash(block.hash, "finalized block hash");
  return block;
}

async function readRequest(client, artifact, state, requestId) {
  const value = await client.readContract({
    address: state.contractAddress,
    abi: artifact.abi,
    functionName: "getRequest",
    args: [BigInt(requestId)],
    blockTag: "finalized",
  });
  return normalizeRequest(value);
}

function eventFromReceipt(receipt, artifact, contractAddress, eventName) {
  const matches = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: artifact.abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName === eventName) matches.push(decoded.args);
    } catch {
      // Logs for other events from the same contract are expected.
    }
  }
  assert(matches.length === 1, `Expected exactly one ${eventName} event`);
  return matches[0];
}

async function waitForFinalizedReceipt(client, transactionHash) {
  const deadline = Date.now() + TIMEOUT_MS;
  let receipt;
  while (Date.now() < deadline) {
    try {
      receipt = await client.getTransactionReceipt({ hash: transactionHash });
      break;
    } catch (error) {
      if (error?.name !== "TransactionReceiptNotFoundError") throw error;
    }
    await delay(POLL_MS);
  }
  assert(receipt, `Timed out waiting for receipt ${transactionHash}`);
  assert(receipt.status === "success", `Transaction reverted: ${transactionHash}`);

  while (Date.now() < deadline) {
    const finalized = await getFinalizedBlock(client);
    if (finalized.number >= receipt.blockNumber) {
      const canonical = await client.getBlock({
        blockNumber: receipt.blockNumber,
      });
      assert(
        canonical.hash?.toLowerCase() === receipt.blockHash.toLowerCase(),
        `Finalized canonical block does not contain receipt ${transactionHash}`,
      );
      return { receipt, finalizedBlock: finalized.number };
    }
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for finalized receipt ${transactionHash}`);
}

async function secureRegularFile(pathValue, label) {
  assert(pathValue, `${label} path is required`);
  const path = resolve(pathValue);
  const details = await stat(path);
  assert(details.isFile(), `${label} must be a regular file`);
  assert(
    (details.mode & 0o077) === 0,
    `${label} permissions are too broad; use chmod 600`,
  );
  if (typeof process.getuid === "function") {
    assert(details.uid === process.getuid(), `${label} must be owned by this user`);
  }
  return path;
}

function roleEnvironmentNames(role) {
  const prefix = `MONAD_E2E_${role.toUpperCase()}`;
  return {
    keystore: `${prefix}_KEYSTORE`,
    passwordFile: `${prefix}_PASSWORD_FILE`,
  };
}

async function castResult(arguments_, environment, label) {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn("cast", arguments_, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectResult);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectResult(
          new Error(
            `${label} failed (cast exit ${code}). Cast output was intentionally not echoed; inspect RPC/funds/keystore inputs locally.`,
          ),
        );
        return;
      }
      resolveResult({ stdout, stderr });
    });
  });
}

async function verifiedRoleCastEnvironment(state, role) {
  const names = roleEnvironmentNames(role);
  const keystorePath = await secureRegularFile(
    process.env[names.keystore],
    `${role} encrypted keystore`,
  );
  const passwordFilePath = await secureRegularFile(
    process.env[names.passwordFile],
    `${role} password file`,
  );
  const address = state.roles[role];
  const environment = safeCastEnvironment(process.env, {
    rpcUrl: RPC_URL,
    address,
    keystorePath,
    passwordFilePath,
  });
  const version = await castResult(
    ["--version"],
    environment,
    `${role} Cast version verification`,
  );
  assert(
    version.stdout.includes(EXPECTED_CAST_VERSION) &&
      version.stdout.includes(EXPECTED_CAST_COMMIT),
    `cast must be the reviewed Monad build ${EXPECTED_CAST_VERSION} (${EXPECTED_CAST_COMMIT})`,
  );
  const result = await castResult(
    ["wallet", "address"],
    environment,
    `${role} keystore verification`,
  );
  const derived = getAddress(result.stdout.trim());
  assert(
    derived === address,
    `${role} keystore derives ${derived}, not the pinned address ${address}`,
  );
  return environment;
}

async function broadcastWithCast({
  state,
  role,
  nonce,
  gasLimit,
  value,
  signature,
  args,
}) {
  const environment = await verifiedRoleCastEnvironment(state, role);
  const command = [
    "send",
    "--async",
    "--nonce",
    nonce.toString(),
    "--gas-limit",
    gasLimit.toString(),
    "--value",
    `${value}wei`,
    state.contractAddress,
    signature,
    ...args.map(String),
  ];
  const result = await castResult(command, environment, `${role} transaction`);
  const matches = result.stdout.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  assert(matches.length === 1, "Cast did not return exactly one transaction hash");
  return normalizeHash(matches[0], "transaction hash");
}

async function estimatedGas(
  client,
  state,
  artifact,
  role,
  functionName,
  args,
  value,
  cap,
) {
  const data = encodeFunctionData({
    abi: artifact.abi,
    functionName,
    args,
  });
  const estimate = await client.estimateGas({
    account: state.roles[role],
    to: state.contractAddress,
    data,
    value,
  });
  return gasWithMargin(estimate, cap);
}

function receiptRecord(receipt) {
  return {
    transactionHash: receipt.transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash.toLowerCase(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  };
}

async function verifyRequestReceipt(client, artifact, state, scenario, receipt) {
  const event = eventFromReceipt(
    receipt,
    artifact,
    state.contractAddress,
    "RandomnessRequested",
  );
  const observedNextRequestId = BigInt(
    state.scenarios[scenario].intent.observedNextRequestIdBefore,
  );
  const requestId = BigInt(event.requestId);
  const requestBlock = BigInt(event.requestBlock);
  const schedule = scheduleForRequestBlock(requestBlock);
  assert(
    requestId >= observedNextRequestId,
    "Tx1 request ID predates the nextRequestId observed before broadcast",
  );
  assert(
    getAddress(event.requester) === state.roles.requester,
    "Tx1 event requester does not match the pinned requester",
  );
  assert(
    requestBlock === receipt.blockNumber,
    "Tx1 event request block differs from receipt block",
  );
  assert(BigInt(event.firstTargetBlock) === schedule.firstTargetBlock, "Wrong first target");
  assert(BigInt(event.secondTargetBlock) === schedule.secondTargetBlock, "Wrong second target");
  assert(BigInt(event.thirdTargetBlock) === schedule.thirdTargetBlock, "Wrong third target");
  assert(
    BigInt(event.pricePaid) === BigInt(state.config.requestPrice),
    "Tx1 event price differs from fixed requestPrice",
  );

  const stored = await readRequest(client, artifact, state, requestId);
  assert(stored.requester === state.roles.requester, "Stored requester mismatch");
  assert(stored.requestBlock === requestBlock, "Stored request block mismatch");
  assert(stored.firstTargetBlock === schedule.firstTargetBlock, "Stored target 1 mismatch");
  assert(stored.secondTargetBlock === schedule.secondTargetBlock, "Stored target 2 mismatch");
  assert(stored.thirdTargetBlock === schedule.thirdTargetBlock, "Stored target 3 mismatch");
  assert(stored.pricePaid === BigInt(state.config.requestPrice), "Stored price mismatch");
  assert(!stored.finalized && !stored.expired, "Fresh request is not pending");

  state.scenarios[scenario] = {
    ...state.scenarios[scenario],
    requestId: requestId.toString(),
    requestBlock: requestBlock.toString(),
    tx1: receiptRecord(receipt),
    intent: null,
  };
  await writeState(state);
}

async function fetchAuthenticatedHeader(client, targetBlock, finalizedBlock) {
  const block = await client.getBlock({ blockNumber: targetBlock });
  assert(block.hash, `Canonical block ${targetBlock} has no hash`);
  const canonicalHash = normalizeHash(block.hash, `block ${targetBlock} hash`);
  const rawHeader = normalizeHexBytes(
    await client.request({
      method: "debug_getRawHeader",
      params: [toHex(targetBlock)],
    }),
    `raw header ${targetBlock}`,
    RAW_HEADER_MAX_BYTES,
  );
  assert(
    keccak256(rawHeader).toLowerCase() === canonicalHash,
    `Raw header hash mismatch at block ${targetBlock}`,
  );
  const fields = fromRlp(rawHeader, "hex");
  assert(
    Array.isArray(fields) && fields.length > 13,
    "Raw header is not the expected RLP list",
  );
  assert(BigInt(fields[8]) === targetBlock, `Raw header number mismatch at ${targetBlock}`);
  const mixHash = normalizeHash(fields[13], `block ${targetBlock} mixHash`);
  if (block.mixHash) {
    assert(
      normalizeHash(block.mixHash, `RPC block ${targetBlock} mixHash`) === mixHash,
      `Raw-header mixHash mismatch at ${targetBlock}`,
    );
  }
  return {
    rawHeader,
    evidence: {
      blockNumber: targetBlock.toString(),
      ageAtRead: (finalizedBlock - targetBlock).toString(),
      canonicalHash,
      mixHash,
    },
  };
}

async function verifyEip2935(client, targetBlock, finalizedBlock) {
  assert(
    finalizedBlock - targetBlock >= 257n,
    "Historical scenario did not move a target outside the 256-block BLOCKHASH window",
  );
  const canonical = await client.getBlock({ blockNumber: targetBlock });
  const response = await client.call({
    to: HISTORY_STORAGE,
    data: toHex(targetBlock, { size: 32 }),
    blockTag: "finalized",
  });
  const historyHash = normalizeHash(response.data, "EIP-2935 history hash");
  assert(
    canonical.hash?.toLowerCase() === historyHash,
    "EIP-2935 history hash differs from the canonical block hash",
  );
  return {
    targetBlock: targetBlock.toString(),
    ageAtRead: (finalizedBlock - targetBlock).toString(),
    historyHash,
  };
}

function independentlyDerivedResult(state, scenarioState, headerEvidence) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        "MONAD_PUBLIC_RANDOMNESS_V1",
        TESTNET_CHAIN_ID,
        state.contractAddress,
        BigInt(scenarioState.requestId),
        state.roles.requester,
        headerEvidence[0].mixHash,
        headerEvidence[1].mixHash,
        headerEvidence[2].mixHash,
      ],
    ),
  );
}

async function verifyFinalizationReceipt(
  client,
  artifact,
  state,
  scenario,
  receipt,
) {
  const scenarioState = state.scenarios[scenario];
  const schedule = scheduleForRequestBlock(BigInt(scenarioState.requestBlock));
  if (scenario === "requester") {
    assert(
      receipt.blockNumber >= schedule.requesterFinalizationBlock &&
        receipt.blockNumber < schedule.permissionlessRescueBlock,
      "Requester Tx2 was not included inside the requester-only window",
    );
  } else if (scenario === "rescue") {
    assert(
      receipt.blockNumber >= schedule.permissionlessRescueBlock,
      "Rescue Tx2 was included before permissionless rescue opened",
    );
  } else if (scenario === "historical") {
    assert(
      receipt.blockNumber >= schedule.historicalProofBlock,
      "Historical Tx2 was included before every target aged beyond BLOCKHASH",
    );
  }
  const event = eventFromReceipt(
    receipt,
    artifact,
    state.contractAddress,
    "RandomnessFinalized",
  );
  const expectedFinalizer = state.roles[SCENARIO_DEFINITIONS[scenario].actor];
  assert(
    BigInt(event.requestId) === BigInt(scenarioState.requestId),
    "Tx2 request ID mismatch",
  );
  assert(getAddress(event.requester) === state.roles.requester, "Tx2 requester mismatch");
  assert(getAddress(event.finalizer) === expectedFinalizer, "Tx2 finalizer mismatch");
  const eventResult = normalizeHash(event.result, "Tx2 event result");
  assert(
    eventResult === scenarioState.intent.expectedResult,
    "Tx2 event result differs from independent header derivation",
  );

  const stored = await readRequest(
    client,
    artifact,
    state,
    BigInt(scenarioState.requestId),
  );
  assert(stored.finalized && !stored.expired, "Tx2 did not store finalized state");
  assert(stored.requester === state.roles.requester, "Stored Tx2 requester mismatch");
  assert(stored.finalizer === expectedFinalizer, "Stored finalizer mismatch");
  assert(stored.result === eventResult, "Stored result differs from Tx2 event");

  const draw = async () =>
    BigInt(
      await client.readContract({
        address: state.contractAddress,
        abi: artifact.abi,
        functionName: "draw",
        args: [BigInt(scenarioState.requestId), DRAW_UPPER_BOUND],
        blockTag: "finalized",
      }),
    );
  const firstDraw = await draw();
  const secondDraw = await draw();
  assert(firstDraw === secondDraw, "Repeated draw returned a different value");
  assert(firstDraw >= 0n && firstDraw < DRAW_UPPER_BOUND, "Draw is out of range");

  state.scenarios[scenario] = {
    ...scenarioState,
    tx2: receiptRecord(receipt),
    result: eventResult,
    drawUpperBound: DRAW_UPPER_BOUND.toString(),
    draw: firstDraw.toString(),
    headers: scenarioState.intent.headers,
    eip2935: scenarioState.intent.eip2935 ?? null,
    intent: null,
  };
  await writeState(state);
}

async function verifyExpiryReceipt(client, artifact, state, scenario, receipt) {
  const scenarioState = state.scenarios[scenario];
  const schedule = scheduleForRequestBlock(BigInt(scenarioState.requestBlock));
  assert(
    receipt.blockNumber >= schedule.firstExpiryBlock,
    "Expiry was included before the proof window closed",
  );
  const event = eventFromReceipt(
    receipt,
    artifact,
    state.contractAddress,
    "RandomnessRequestExpired",
  );
  assert(
    BigInt(event.requestId) === BigInt(scenarioState.requestId),
    "Expiry request ID mismatch",
  );
  assert(getAddress(event.requester) === state.roles.requester, "Expiry requester mismatch");
  assert(getAddress(event.expirer) === state.roles.rescuer, "Expiry caller mismatch");
  const stored = await readRequest(
    client,
    artifact,
    state,
    BigInt(scenarioState.requestId),
  );
  assert(!stored.finalized && stored.expired, "Expiry did not store expired state");
  assert(stored.finalizer === ZERO_ADDRESS, "Expired request unexpectedly has a finalizer");
  state.scenarios[scenario] = {
    ...scenarioState,
    expiry: receiptRecord(receipt),
    intent: null,
  };
  await writeState(state);
}

async function reconcileScenario(
  client,
  artifact,
  state,
  scenario,
  wait = false,
) {
  const intent = state.scenarios[scenario].intent;
  if (!intent) return false;
  if (!intent.transactionHash) {
    throw new Error(
      `${scenario} has a durable ${intent.kind} intent but no transaction hash. ` +
        "Do not retry automatically: recover the sender nonce/transaction first.",
    );
  }

  let receipt;
  if (wait) {
    ({ receipt } = await waitForFinalizedReceipt(client, intent.transactionHash));
  } else {
    try {
      receipt = await client.getTransactionReceipt({
        hash: intent.transactionHash,
      });
    } catch (error) {
      if (error?.name === "TransactionReceiptNotFoundError") return false;
      throw error;
    }
    if (receipt.status !== "success") {
      throw new Error(`${scenario} transaction reverted: ${intent.transactionHash}`);
    }
    const finalized = await getFinalizedBlock(client);
    if (finalized.number < receipt.blockNumber) return false;
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    assert(
      canonical.hash?.toLowerCase() === receipt.blockHash.toLowerCase(),
      `${scenario} receipt is not in the finalized canonical block`,
    );
  }

  if (intent.kind === "request") {
    await verifyRequestReceipt(client, artifact, state, scenario, receipt);
  } else if (intent.kind === "finalize") {
    await verifyFinalizationReceipt(client, artifact, state, scenario, receipt);
  } else if (intent.kind === "expire") {
    await verifyExpiryReceipt(client, artifact, state, scenario, receipt);
  } else {
    throw new Error(`Unknown intent kind ${intent.kind}`);
  }
  return true;
}

async function initialize(client, artifact) {
  const existing = await readState(false);
  if (existing) {
    assert(process.env.MONAD_E2E_CONTRACT, "MONAD_E2E_CONTRACT is required for init");
    const suppliedContract = getAddress(process.env.MONAD_E2E_CONTRACT);
    const suppliedRoles = normalizeRoleAddresses(
      process.env.MONAD_E2E_REQUESTER_ADDRESS,
      process.env.MONAD_E2E_RESCUER_ADDRESS,
    );
    assert(
      suppliedContract === existing.contractAddress,
      "Existing state contract differs from MONAD_E2E_CONTRACT; use a new state path",
    );
    assert(
      suppliedRoles.requester === existing.roles.requester &&
        suppliedRoles.rescuer === existing.roles.rescuer,
      "Existing state roles differ from init inputs; use a new state path",
    );
    const verified = await verifyNetworkAndContract(client, artifact, existing);
    assertCanonicalCanaryConfig(verified.config, existing.roles.requester);
    console.log(`State already initialized: ${STATE_PATH}`);
    return existing;
  }

  const rawContract = process.env.MONAD_E2E_CONTRACT;
  assert(rawContract, "MONAD_E2E_CONTRACT is required for init");
  const contractAddress = getAddress(rawContract);
  const roles = normalizeRoleAddresses(
    process.env.MONAD_E2E_REQUESTER_ADDRESS,
    process.env.MONAD_E2E_RESCUER_ADDRESS,
  );
  const verified = await verifyNetworkAndContract(client, artifact, {
    contractAddress,
  });
  assertCanonicalCanaryConfig(verified.config, roles.requester);
  const state = {
    schemaVersion: 1,
    purpose: "Monad RNG V1 public Testnet E2E evidence; contains no secrets",
    chainId: TESTNET_CHAIN_ID.toString(),
    contractAddress,
    artifactPath: "public/contracts/PlatformRandomness.json",
    config: verified.config,
    roles,
    createdAt: new Date().toISOString(),
    scenarios: Object.fromEntries(
      SCENARIO_NAMES.map((name) => [
        name,
        {
          description: SCENARIO_DEFINITIONS[name].description,
          requestId: null,
          requestBlock: null,
          tx1: null,
          tx2: null,
          expiry: null,
          result: null,
          intent: null,
        },
      ]),
    ),
  };
  await writeState(state);
  console.log(`Initialized public E2E state: ${STATE_PATH}`);
  return state;
}

async function requestScenario(client, artifact, state, scenario) {
  const verified = await verifyNetworkAndContract(client, artifact, state);
  if (await reconcileScenario(client, artifact, state, scenario, false)) {
    console.log(`Recovered and verified the prior Tx1 for ${scenario}`);
    return;
  }
  const scenarioState = state.scenarios[scenario];
  assert(!scenarioState.intent, `${scenario} already has an unresolved intent`);
  assert(
    !scenarioState.requestId,
    `${scenario} already has request ${scenarioState.requestId}`,
  );

  const expectedRequestId = verified.nextRequestId;
  const nonce = await client.getTransactionCount({
    address: state.roles.requester,
    blockTag: "pending",
  });
  scenarioState.intent = {
    kind: "request",
    actor: "requester",
    observedNextRequestIdBefore: expectedRequestId.toString(),
    senderNonceBefore: nonce.toString(),
    createdAt: new Date().toISOString(),
    transactionHash: null,
  };
  await writeState(state);

  const value = BigInt(state.config.requestPrice);
  const gasLimit = await estimatedGas(
    client,
    state,
    artifact,
    "requester",
    "requestRandomness",
    [],
    value,
    TX1_GAS_CAP,
  );
  const transactionHash = await broadcastWithCast({
    state,
    role: "requester",
    nonce,
    gasLimit,
    value,
    signature: "requestRandomness()",
    args: [],
  });
  scenarioState.intent.transactionHash = transactionHash;
  scenarioState.intent.gasLimit = gasLimit.toString();
  await writeState(state);
  console.log(`Tx1 broadcast for ${scenario}: ${transactionHash}`);
  await reconcileScenario(client, artifact, state, scenario, true);
  console.log(`Tx1 finalized and verified for ${scenario}`);
}

async function actionScenario(client, artifact, state, scenario) {
  await verifyNetworkAndContract(client, artifact, state);
  if (await reconcileScenario(client, artifact, state, scenario, false)) {
    console.log(`Recovered and verified the prior action for ${scenario}`);
    return;
  }
  const scenarioState = state.scenarios[scenario];
  assert(!scenarioState.intent, `${scenario} already has an unresolved intent`);
  assert(
    scenarioState.requestId,
    `${scenario} has no Tx1; run request ${scenario}`,
  );

  const stored = await readRequest(
    client,
    artifact,
    state,
    BigInt(scenarioState.requestId),
  );
  if (stored.finalized || stored.expired) {
    throw new Error(
      `${scenario} is already ${
        stored.finalized ? "finalized" : "expired"
      } on-chain but its evidence is incomplete`,
    );
  }
  const finalized = await getFinalizedBlock(client);
  const readiness = readinessForScenario(
    scenario,
    stored.requestBlock,
    finalized.number,
  );
  if (!readiness.ready) {
    if (readiness.requesterWindowOpen === false) {
      throw new Error(
        `${scenario} missed the requester-only window ending before ` +
          `${readiness.schedule.permissionlessRescueBlock}; create a fresh dedicated request`,
      );
    }
    if (readiness.safelyBeforeExpiry === false) {
      throw new Error(
        `${scenario} is inside the final ${FINALIZE_SAFETY_BLOCKS} proof blocks; ` +
          "this helper refuses a late Tx2",
      );
    }
    throw new Error(
      `${scenario} is not ready at finalized block ${finalized.number}; ` +
        `${readiness.blocksRemaining} finalized blocks remain until ${readiness.firstEligibleBlock}`,
    );
  }

  const definition = SCENARIO_DEFINITIONS[scenario];
  const role = definition.actor;
  const nonce = await client.getTransactionCount({
    address: state.roles[role],
    blockTag: "pending",
  });

  if (definition.action === "expire") {
    const gasLimit = await estimatedGas(
      client,
      state,
      artifact,
      role,
      "expireRequest",
      [BigInt(scenarioState.requestId)],
      0n,
      EXPIRY_GAS_CAP,
    );
    scenarioState.intent = {
      kind: "expire",
      actor: role,
      senderNonceBefore: nonce.toString(),
      gasLimit: gasLimit.toString(),
      createdAt: new Date().toISOString(),
      transactionHash: null,
    };
    await writeState(state);
    const transactionHash = await broadcastWithCast({
      state,
      role,
      nonce,
      gasLimit,
      value: 0n,
      signature: "expireRequest(uint256)",
      args: [scenarioState.requestId],
    });
    scenarioState.intent.transactionHash = transactionHash;
    await writeState(state);
    console.log(`Expiry broadcast for ${scenario}: ${transactionHash}`);
    await reconcileScenario(client, artifact, state, scenario, true);
    console.log(`Expiry finalized and verified for ${scenario}`);
    return;
  }

  const headers = await Promise.all(
    [
      stored.firstTargetBlock,
      stored.secondTargetBlock,
      stored.thirdTargetBlock,
    ].map((target) => fetchAuthenticatedHeader(client, target, finalized.number)),
  );
  const eip2935 =
    scenario === "historical"
      ? await Promise.all(
          [
            stored.firstTargetBlock,
            stored.secondTargetBlock,
            stored.thirdTargetBlock,
          ].map((target) => verifyEip2935(client, target, finalized.number)),
        )
      : null;
  const headerEvidence = headers.map(({ evidence }) => evidence);
  const expectedResult = independentlyDerivedResult(
    state,
    scenarioState,
    headerEvidence,
  ).toLowerCase();
  const rawHeaders = headers.map(({ rawHeader }) => rawHeader);
  const args = [BigInt(scenarioState.requestId), ...rawHeaders];
  const gasLimit = await estimatedGas(
    client,
    state,
    artifact,
    role,
    "finalizeRandomness",
    args,
    0n,
    TX2_GAS_CAP,
  );
  scenarioState.intent = {
    kind: "finalize",
    actor: role,
    senderNonceBefore: nonce.toString(),
    gasLimit: gasLimit.toString(),
    createdAt: new Date().toISOString(),
    transactionHash: null,
    expectedResult,
    headers: headerEvidence,
    eip2935,
  };
  await writeState(state);
  const transactionHash = await broadcastWithCast({
    state,
    role,
    nonce,
    gasLimit,
    value: 0n,
    signature: "finalizeRandomness(uint256,bytes,bytes,bytes)",
    args,
  });
  scenarioState.intent.transactionHash = transactionHash;
  await writeState(state);
  console.log(`Tx2 broadcast for ${scenario}: ${transactionHash}`);
  await reconcileScenario(client, artifact, state, scenario, true);
  console.log(`Tx2 finalized and verified for ${scenario}`);
}

async function showStatus(client, artifact, state) {
  await verifyNetworkAndContract(client, artifact, state);
  for (const scenario of SCENARIO_NAMES) {
    await reconcileScenario(client, artifact, state, scenario, false);
  }
  const finalized = await getFinalizedBlock(client);
  console.log(`Monad Testnet (${TESTNET_CHAIN_ID}) via ${publicRpcLabel(RPC_URL)}`);
  console.log(`Contract: ${state.contractAddress}`);
  console.log(`Finalized block: ${finalized.number}`);
  for (const scenario of SCENARIO_NAMES) {
    const item = state.scenarios[scenario];
    if (item.intent) {
      console.log(
        `${scenario}: ${item.intent.kind} pending (${
          item.intent.transactionHash ?? "hash recovery required"
        })`,
      );
      continue;
    }
    if (!item.requestId) {
      console.log(`${scenario}: Tx1 not sent`);
      continue;
    }
    const stored = await readRequest(
      client,
      artifact,
      state,
      BigInt(item.requestId),
    );
    if (stored.finalized) {
      console.log(
        `${scenario}: finalized; request ${item.requestId}; result ${stored.result}`,
      );
      continue;
    }
    if (stored.expired) {
      console.log(`${scenario}: expired; request ${item.requestId}`);
      continue;
    }
    const readiness = readinessForScenario(
      scenario,
      stored.requestBlock,
      finalized.number,
    );
    const readinessLabel =
      readiness.requesterWindowOpen === false
        ? `requester-only window ended before ${readiness.schedule.permissionlessRescueBlock}`
        : readiness.safelyBeforeExpiry === false
          ? "inside the final proof safety window"
          : readiness.ready
            ? `${readiness.action} ready for ${readiness.actor}`
            : `${readiness.blocksRemaining} finalized blocks to ${readiness.firstEligibleBlock}`;
    console.log(
      `${scenario}: pending request ${item.requestId}; ${readinessLabel}`,
    );
  }
  console.log(`Public evidence state: ${STATE_PATH}`);
}

async function main() {
  const [command, scenarioInput, ...extra] = process.argv.slice(2);
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(HELP);
    return;
  }
  assert(extra.length === 0, "Unexpected extra command arguments");
  assert(
    ["init", "status", "request", "act"].includes(command),
    `Unknown command "${command}"`,
  );
  const scenario =
    command === "request" || command === "act"
      ? requireScenarioName(scenarioInput)
      : undefined;
  assert(
    (command === "request" || command === "act") === Boolean(scenarioInput),
    `${command} ${
      command === "request" || command === "act" ? "requires" : "does not accept"
    } a scenario`,
  );

  const client = createClient();
  const artifact = await loadArtifact();
  if (command === "init") {
    const state = await initialize(client, artifact);
    await showStatus(client, artifact, state);
    return;
  }
  const state = await readState();
  if (process.env.MONAD_E2E_CONTRACT) {
    assert(
      getAddress(process.env.MONAD_E2E_CONTRACT) === state.contractAddress,
      "MONAD_E2E_CONTRACT does not match the pinned state",
    );
  }
  if (command === "status") {
    await showStatus(client, artifact, state);
  } else if (command === "request") {
    await requestScenario(client, artifact, state, scenario);
  } else {
    await actionScenario(client, artifact, state, scenario);
  }
}

main().catch((error) => {
  console.error("Monad Testnet E2E helper FAILED");
  console.error(sanitizedErrorMessage(error));
  process.exitCode = 1;
});
