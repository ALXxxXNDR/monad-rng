import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
} from "viem";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 15_000;
const EXPECTED_PLATFORM_VERSION = 1n;
const EXPECTED_FACTORY_VERSION = 1n;

const NETWORKS = Object.freeze({
  testnet: { chainId: 10_143n, displayName: "Monad Testnet" },
  mainnet: { chainId: 143n, displayName: "Monad Mainnet" },
});

const PLATFORM_MUTATING_SIGNATURES = Object.freeze([
  "expireRequest(uint256):nonpayable",
  "finalizeRandomness(uint256,bytes,bytes,bytes):nonpayable",
  "requestRandomness():payable",
  "withdrawRevenue():nonpayable",
]);

const FACTORY_MUTATING_SIGNATURES = Object.freeze([
  "deployPlatform(address,string,uint256,uint256):nonpayable",
]);

const PLATFORM_REQUIRED_GETTERS = Object.freeze({
  CONFIGURATION_LOCKED: "bool",
  VERSION: "uint256",
  maxPending: "uint256",
  platformName: "string",
  protocolFee: "uint256",
  requestPrice: "uint256",
  revenueRecipient: "address",
});

export class DeploymentAttestationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentAttestationError";
  }
}

function fail(message) {
  throw new DeploymentAttestationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function normalizeHex(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function sameAddress(left, right) {
  return normalizeHex(left) === normalizeHex(right);
}

function requireEnvironmentValue(env, name, { allowEmpty = false } = {}) {
  const value = env[name];
  if (value === undefined || (!allowEmpty && value.trim() === "")) {
    fail(`Missing required environment variable ${name}`);
  }
  return value;
}

function parseAddress(env, name) {
  const value = requireEnvironmentValue(env, name);
  try {
    return getAddress(value);
  } catch {
    fail(`${name} must be a valid EVM address`);
  }
}

function parseHash(env, name) {
  const value = requireEnvironmentValue(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${name} must be a 32-byte transaction hash`);
  }
  return value.toLowerCase();
}

function parseDecimalUint(env, name) {
  const value = requireEnvironmentValue(env, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${name} must be an unsigned base-10 integer`);
  }
  return BigInt(value);
}

function parseRpcUrl(env, name, { requireHttps = false } = {}) {
  const value = requireEnvironmentValue(env, name);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      fail(`${name} must use HTTP or HTTPS`);
    }
    if (requireHttps && parsed.protocol !== "https:") {
      fail(`${name} must use HTTPS for Mainnet attestation`);
    }
  } catch (error) {
    if (error instanceof DeploymentAttestationError) throw error;
    fail(`${name} must be a valid HTTP(S) URL`);
  }
  return value;
}

function resolveArtifactPath(env, name, defaultRelativePath) {
  const configured = env[name];
  if (configured === undefined || configured.trim() === "") {
    return path.join(projectRoot, defaultRelativePath);
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(projectRoot, configured);
}

export function readAttestationEnvironment(env = process.env) {
  const network = requireEnvironmentValue(env, "MONAD_NETWORK").toLowerCase();
  const networkDefinition = NETWORKS[network];
  assert(
    networkDefinition,
    "MONAD_NETWORK must be either testnet or mainnet",
  );

  const expectedChainId = parseDecimalUint(env, "MONAD_EXPECTED_CHAIN_ID");
  assert(
    expectedChainId === networkDefinition.chainId,
    `MONAD_NETWORK=${network} requires chain ID ${networkDefinition.chainId}`,
  );

  const requireHttps = network === "mainnet";
  const primaryRpcUrl = parseRpcUrl(env, "MONAD_RPC_URL_PRIMARY", {
    requireHttps,
  });
  const secondaryRpcUrl = parseRpcUrl(env, "MONAD_RPC_URL_SECONDARY", {
    requireHttps,
  });
  assert(
    primaryRpcUrl !== secondaryRpcUrl,
    "Primary and secondary RPC URLs must be different",
  );
  assert(
    new URL(primaryRpcUrl).origin !== new URL(secondaryRpcUrl).origin,
    "Primary and secondary RPC URLs must use different provider origins",
  );

  return Object.freeze({
    network,
    networkDisplayName: networkDefinition.displayName,
    expectedChainId,
    primaryRpcUrl,
    secondaryRpcUrl,
    factoryAddress: parseAddress(env, "MONAD_FACTORY_ADDRESS"),
    platformAddress: parseAddress(env, "MONAD_PLATFORM_ADDRESS"),
    expectedDeployer: parseAddress(env, "MONAD_EXPECTED_DEPLOYER"),
    expectedRevenueRecipient: parseAddress(
      env,
      "MONAD_EXPECTED_REVENUE_RECIPIENT",
    ),
    expectedPlatformName: requireEnvironmentValue(
      env,
      "MONAD_EXPECTED_PLATFORM_NAME",
      { allowEmpty: true },
    ),
    expectedRequestPrice: parseDecimalUint(
      env,
      "MONAD_EXPECTED_REQUEST_PRICE_WEI",
    ),
    expectedMaxPending: parseDecimalUint(
      env,
      "MONAD_EXPECTED_MAX_PENDING",
    ),
    factoryDeploymentTxHash: parseHash(
      env,
      "MONAD_FACTORY_DEPLOYMENT_TX_HASH",
    ),
    platformDeploymentTxHash: parseHash(
      env,
      "MONAD_PLATFORM_DEPLOYMENT_TX_HASH",
    ),
    platformArtifactPath: resolveArtifactPath(
      env,
      "MONAD_PLATFORM_ARTIFACT",
      "public/contracts/PlatformRandomness.json",
    ),
    factoryArtifactPath: resolveArtifactPath(
      env,
      "MONAD_FACTORY_ARTIFACT",
      "public/contracts/RandomnessFactory.json",
    ),
  });
}

function isNonEmptyHexBytes(value) {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(value)
  );
}

function hasLinkReferences(references) {
  return (
    references &&
    typeof references === "object" &&
    Object.keys(references).length > 0
  );
}

export function normalizeContractArtifact(rawArtifact, label) {
  assert(
    rawArtifact && typeof rawArtifact === "object",
    `${label} artifact must be a JSON object`,
  );
  assert(Array.isArray(rawArtifact.abi), `${label} artifact has no ABI`);

  const runtimeBytecode =
    rawArtifact.runtimeBytecode ?? rawArtifact.deployedBytecode?.object;
  assert(
    isNonEmptyHexBytes(runtimeBytecode),
    `${label} artifact has invalid deployed runtime bytecode`,
  );
  assert(
    !hasLinkReferences(rawArtifact.deployedBytecode?.linkReferences),
    `${label} artifact has unresolved runtime library links`,
  );

  const runtimeBytecodeHash = keccak256(runtimeBytecode);
  if (rawArtifact.runtimeBytecodeHash !== undefined) {
    assert(
      /^0x[0-9a-fA-F]{64}$/.test(rawArtifact.runtimeBytecodeHash),
      `${label} artifact has an invalid declared runtime hash`,
    );
    assert(
      normalizeHex(rawArtifact.runtimeBytecodeHash) ===
        normalizeHex(runtimeBytecodeHash),
      `${label} artifact runtime bytes do not match its declared hash`,
    );
  }

  return Object.freeze({
    abi: rawArtifact.abi,
    runtimeBytecode,
    runtimeBytecodeHash,
  });
}

function functionSignature(item) {
  const inputs = item.inputs?.map((input) => input.type).join(",") ?? "";
  return `${item.name}(${inputs}):${item.stateMutability}`;
}

function assertGetter(abi, name, outputType, label) {
  const matches = abi.filter(
    (item) =>
      item.type === "function" &&
      item.name === name &&
      (item.inputs?.length ?? 0) === 0,
  );
  assert(matches.length === 1, `${label} ABI must expose exactly one ${name}()`);
  const [getter] = matches;
  assert(
    getter.stateMutability === "view" || getter.stateMutability === "pure",
    `${label} ABI ${name}() must be read-only`,
  );
  assert(
    getter.outputs?.length === 1 && getter.outputs[0].type === outputType,
    `${label} ABI ${name}() has an unexpected return type`,
  );
}

function assertNoFallbackOrReceive(abi, label) {
  assert(
    !abi.some((item) => item.type === "fallback" || item.type === "receive"),
    `${label} ABI must not expose a fallback or receive entry point`,
  );
}

function mutatingSignatures(abi) {
  return abi
    .filter(
      (item) =>
        item.type === "function" &&
        item.stateMutability !== "view" &&
        item.stateMutability !== "pure",
    )
    .map(functionSignature)
    .sort();
}

function assertExactMutatingSurface(abi, expected, label) {
  const actual = mutatingSignatures(abi);
  const sortedExpected = [...expected].sort();
  assert(
    actual.length === sortedExpected.length &&
      actual.every((value, index) => value === sortedExpected[index]),
    `${label} ABI has an unexpected state-changing function`,
  );
}

export function assertOwnerlessArtifacts(platformArtifact, factoryArtifact) {
  for (const [name, outputType] of Object.entries(
    PLATFORM_REQUIRED_GETTERS,
  )) {
    assertGetter(platformArtifact.abi, name, outputType, "Platform");
  }
  assertExactMutatingSurface(
    platformArtifact.abi,
    PLATFORM_MUTATING_SIGNATURES,
    "Platform",
  );
  assertNoFallbackOrReceive(platformArtifact.abi, "Platform");

  assertGetter(factoryArtifact.abi, "VERSION", "uint256", "Factory");
  assertExactMutatingSurface(
    factoryArtifact.abi,
    FACTORY_MUTATING_SIGNATURES,
    "Factory",
  );
  assertNoFallbackOrReceive(factoryArtifact.abi, "Factory");
}

async function readJsonArtifact(filePath, label) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    fail(`Could not read the ${label} artifact`);
  }

  let rawArtifact;
  try {
    rawArtifact = JSON.parse(contents);
  } catch {
    fail(`${label} artifact is not valid JSON`);
  }
  return normalizeContractArtifact(rawArtifact, label);
}

export async function loadAttestationArtifacts(config) {
  const [platformArtifact, factoryArtifact] = await Promise.all([
    readJsonArtifact(config.platformArtifactPath, "Platform"),
    readJsonArtifact(config.factoryArtifactPath, "Factory"),
  ]);
  assertOwnerlessArtifacts(platformArtifact, factoryArtifact);
  return { platformArtifact, factoryArtifact };
}

function createEndpoint(label, url) {
  return {
    label,
    client: createPublicClient({
      transport: http(url, {
        batch: false,
        retryCount: 1,
        timeout: REQUEST_TIMEOUT_MS,
      }),
    }),
  };
}

export function createAttestationEndpoints(config) {
  return [
    createEndpoint("RPC A", config.primaryRpcUrl),
    createEndpoint("RPC B", config.secondaryRpcUrl),
  ];
}

async function rpcRead(endpoint, action, operation) {
  try {
    return await operation();
  } catch {
    // Do not surface Viem's underlying error. It can contain a credential-bearing
    // RPC URL, request headers, or a provider-specific response.
    fail(`${endpoint.label} failed while ${action}`);
  }
}

function requireBlock(block, label) {
  assert(
    block && typeof block === "object" && typeof block.number === "bigint",
    `${label} did not return a numbered block`,
  );
  assert(
    typeof block.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(block.hash),
    `${label} did not return a canonical block hash`,
  );
  return block;
}

async function readChainHead(endpoint) {
  const [chainId, finalizedBlock] = await Promise.all([
    rpcRead(endpoint, "reading chain ID", () => endpoint.client.getChainId()),
    rpcRead(endpoint, "reading the finalized block", () =>
      endpoint.client.getBlock({ blockTag: "finalized" }),
    ),
  ]);
  return {
    chainId: BigInt(chainId),
    finalizedBlock: requireBlock(
      finalizedBlock,
      `${endpoint.label} finalized head`,
    ),
  };
}

async function chooseCommonFinalizedBlock(config, endpoints) {
  const heads = await Promise.all(endpoints.map(readChainHead));
  for (let index = 0; index < endpoints.length; index += 1) {
    assert(
      heads[index].chainId === config.expectedChainId,
      `${endpoints[index].label} returned chain ID ${heads[index].chainId}; expected ${config.expectedChainId}`,
    );
  }

  const auditBlockNumber = heads.reduce(
    (minimum, head) =>
      head.finalizedBlock.number < minimum
        ? head.finalizedBlock.number
        : minimum,
    heads[0].finalizedBlock.number,
  );

  const blocks = await Promise.all(
    endpoints.map((endpoint) =>
      rpcRead(endpoint, `reading audit block ${auditBlockNumber}`, () =>
        endpoint.client.getBlock({ blockNumber: auditBlockNumber }),
      ).then((block) =>
        requireBlock(block, `${endpoint.label} audit block ${auditBlockNumber}`),
      ),
    ),
  );
  assert(
    normalizeHex(blocks[0].hash) === normalizeHex(blocks[1].hash),
    `RPC endpoints disagree on canonical hash for audit block ${auditBlockNumber}`,
  );

  return {
    auditBlockNumber,
    auditBlockHash: blocks[0].hash,
    finalizedHeads: heads.map((head) => head.finalizedBlock.number),
  };
}

async function readRuntime(endpoint, address, auditBlockNumber, label) {
  const runtime = await rpcRead(
    endpoint,
    `reading ${label} runtime bytecode`,
    () => endpoint.client.getBytecode({ address, blockNumber: auditBlockNumber }),
  );
  assert(
    isNonEmptyHexBytes(runtime),
    `${endpoint.label} returned no ${label} runtime bytecode`,
  );
  return runtime;
}

async function attestRuntime({
  endpoints,
  address,
  auditBlockNumber,
  artifact,
  label,
}) {
  const runtimes = await Promise.all(
    endpoints.map((endpoint) =>
      readRuntime(endpoint, address, auditBlockNumber, label),
    ),
  );
  assert(
    normalizeHex(runtimes[0]) === normalizeHex(runtimes[1]),
    `RPC endpoints returned different ${label} runtime bytecode`,
  );

  const runtimeHashes = runtimes.map((runtime) => keccak256(runtime));
  assert(
    normalizeHex(runtimeHashes[0]) === normalizeHex(runtimeHashes[1]),
    `RPC endpoints returned different ${label} runtime hashes`,
  );
  assert(
    normalizeHex(runtimes[0]) === normalizeHex(artifact.runtimeBytecode),
    `${label} on-chain runtime bytes do not match the release artifact`,
  );
  assert(
    normalizeHex(runtimeHashes[0]) ===
      normalizeHex(artifact.runtimeBytecodeHash),
    `${label} on-chain runtime hash does not match the release artifact`,
  );
  return runtimeHashes[0];
}

async function readContractValue(
  endpoint,
  { address, abi, functionName, blockNumber, label },
) {
  return rpcRead(endpoint, `reading ${label}`, () =>
    endpoint.client.readContract({
      address,
      abi,
      functionName,
      blockNumber,
    }),
  );
}

async function readPlatformConfiguration(
  endpoint,
  config,
  platformArtifact,
  auditBlockNumber,
) {
  const read = (functionName) =>
    readContractValue(endpoint, {
      address: config.platformAddress,
      abi: platformArtifact.abi,
      functionName,
      blockNumber: auditBlockNumber,
      label: `Platform ${functionName}()`,
    });

  const [
    configurationLocked,
    version,
    revenueRecipient,
    platformName,
    requestPrice,
    maxPending,
    protocolFee,
  ] = await Promise.all([
    read("CONFIGURATION_LOCKED"),
    read("VERSION"),
    read("revenueRecipient"),
    read("platformName"),
    read("requestPrice"),
    read("maxPending"),
    read("protocolFee"),
  ]);

  let checksummedRecipient;
  try {
    checksummedRecipient = getAddress(revenueRecipient);
  } catch {
    fail(`${endpoint.label} returned an invalid revenueRecipient()`);
  }

  return {
    configurationLocked,
    version: BigInt(version),
    revenueRecipient: checksummedRecipient,
    platformName,
    requestPrice: BigInt(requestPrice),
    maxPending: BigInt(maxPending),
    protocolFee: BigInt(protocolFee),
  };
}

function assertSamePlatformConfiguration(left, right) {
  assert(
    left.configurationLocked === right.configurationLocked &&
      left.version === right.version &&
      sameAddress(left.revenueRecipient, right.revenueRecipient) &&
      left.platformName === right.platformName &&
      left.requestPrice === right.requestPrice &&
      left.maxPending === right.maxPending &&
      left.protocolFee === right.protocolFee,
    "RPC endpoints returned different Platform configuration",
  );
}

function assertExpectedPlatformConfiguration(configuration, config) {
  assert(
    configuration.configurationLocked === true,
    "Platform CONFIGURATION_LOCKED() is not true",
  );
  assert(
    configuration.version === EXPECTED_PLATFORM_VERSION,
    `Platform VERSION() is not ${EXPECTED_PLATFORM_VERSION}`,
  );
  assert(
    sameAddress(
      configuration.revenueRecipient,
      config.expectedRevenueRecipient,
    ),
    "Platform revenueRecipient() does not match the approved recipient",
  );
  assert(
    configuration.platformName === config.expectedPlatformName,
    "Platform platformName() does not match the approved name",
  );
  assert(
    configuration.requestPrice === config.expectedRequestPrice,
    "Platform requestPrice() does not match the approved wei amount",
  );
  assert(
    configuration.maxPending === config.expectedMaxPending,
    "Platform maxPending() does not match the approved cap",
  );
  assert(configuration.protocolFee === 0n, "Platform protocolFee() is not zero");
}

async function attestFactoryVersion(
  endpoints,
  config,
  factoryArtifact,
  auditBlockNumber,
) {
  const versions = await Promise.all(
    endpoints.map((endpoint) =>
      readContractValue(endpoint, {
        address: config.factoryAddress,
        abi: factoryArtifact.abi,
        functionName: "VERSION",
        blockNumber: auditBlockNumber,
        label: "Factory VERSION()",
      }).then(BigInt),
    ),
  );
  assert(
    versions[0] === versions[1],
    "RPC endpoints returned different Factory VERSION() values",
  );
  assert(
    versions[0] === EXPECTED_FACTORY_VERSION,
    `Factory VERSION() is not ${EXPECTED_FACTORY_VERSION}`,
  );
  return versions[0];
}

function requireTransaction(transaction, expectedHash, endpoint, label) {
  assert(transaction && typeof transaction === "object", `${endpoint.label} returned no ${label}`);
  assert(
    normalizeHex(transaction.hash) === normalizeHex(expectedHash),
    `${endpoint.label} returned the wrong ${label} hash`,
  );
  assert(
    typeof transaction.blockNumber === "bigint",
    `${endpoint.label} returned an unmined ${label}`,
  );
  return transaction;
}

function requireReceipt(receipt, expectedHash, endpoint, label) {
  assert(receipt && typeof receipt === "object", `${endpoint.label} returned no ${label} receipt`);
  assert(
    normalizeHex(receipt.transactionHash) === normalizeHex(expectedHash),
    `${endpoint.label} returned the wrong ${label} receipt`,
  );
  assert(
    receipt.status === "success",
    `${endpoint.label} reports a reverted ${label}`,
  );
  assert(
    typeof receipt.blockNumber === "bigint",
    `${endpoint.label} returned an unmined ${label} receipt`,
  );
  assert(
    typeof receipt.blockHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash),
    `${endpoint.label} returned a ${label} receipt without a canonical block hash`,
  );
  return receipt;
}

function decodeExpectedPlatformEvent(logs, factoryArtifact, config, endpoint) {
  const candidates = [];
  for (const log of logs ?? []) {
    if (!sameAddress(log.address, config.factoryAddress)) continue;
    try {
      const decoded = decodeEventLog({
        abi: factoryArtifact.abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName === "PlatformDeployed") candidates.push(decoded.args);
    } catch {
      // Other Factory logs are irrelevant. The exact expected event is required below.
    }
  }

  const matches = candidates.filter((args) => {
    try {
      return (
        sameAddress(args.platform, config.platformAddress) &&
        sameAddress(args.revenueRecipient, config.expectedRevenueRecipient) &&
        args.platformName === config.expectedPlatformName &&
        BigInt(args.requestPrice) === config.expectedRequestPrice &&
        BigInt(args.maxPending) === config.expectedMaxPending
      );
    } catch {
      return false;
    }
  });
  assert(
    matches.length === 1,
    `${endpoint.label} Platform deployment receipt must contain exactly one matching PlatformDeployed event`,
  );
}

async function readDeploymentTransactions(
  endpoint,
  config,
  factoryArtifact,
  auditBlockNumber,
) {
  const [factoryTransaction, factoryReceipt, platformTransaction, platformReceipt] =
    await Promise.all([
      rpcRead(endpoint, "reading the Factory deployment transaction", () =>
        endpoint.client.getTransaction({
          hash: config.factoryDeploymentTxHash,
        }),
      ),
      rpcRead(endpoint, "reading the Factory deployment receipt", () =>
        endpoint.client.getTransactionReceipt({
          hash: config.factoryDeploymentTxHash,
        }),
      ),
      rpcRead(endpoint, "reading the Platform deployment transaction", () =>
        endpoint.client.getTransaction({
          hash: config.platformDeploymentTxHash,
        }),
      ),
      rpcRead(endpoint, "reading the Platform deployment receipt", () =>
        endpoint.client.getTransactionReceipt({
          hash: config.platformDeploymentTxHash,
        }),
      ),
    ]);

  requireTransaction(
    factoryTransaction,
    config.factoryDeploymentTxHash,
    endpoint,
    "Factory deployment transaction",
  );
  requireReceipt(
    factoryReceipt,
    config.factoryDeploymentTxHash,
    endpoint,
    "Factory deployment",
  );
  requireTransaction(
    platformTransaction,
    config.platformDeploymentTxHash,
    endpoint,
    "Platform deployment transaction",
  );
  requireReceipt(
    platformReceipt,
    config.platformDeploymentTxHash,
    endpoint,
    "Platform deployment",
  );

  assert(
    sameAddress(factoryTransaction.from, config.expectedDeployer) &&
      sameAddress(factoryReceipt.from, config.expectedDeployer),
    `${endpoint.label} Factory deployment signer does not match the expected deployer`,
  );
  assert(
    factoryTransaction.to == null && factoryReceipt.to == null,
    `${endpoint.label} Factory deployment was not a contract-creation transaction`,
  );
  assert(
    sameAddress(factoryReceipt.contractAddress, config.factoryAddress),
    `${endpoint.label} Factory receipt contract address does not match`,
  );
  assert(
    factoryTransaction.blockNumber === factoryReceipt.blockNumber,
    `${endpoint.label} Factory transaction and receipt blocks differ`,
  );
  assert(
    factoryReceipt.blockNumber <= auditBlockNumber,
    `${endpoint.label} Factory deployment is not finalized at the audit block`,
  );

  assert(
    sameAddress(platformTransaction.from, config.expectedDeployer) &&
      sameAddress(platformReceipt.from, config.expectedDeployer),
    `${endpoint.label} Platform deployment signer does not match the expected deployer`,
  );
  assert(
    sameAddress(platformTransaction.to, config.factoryAddress) &&
      sameAddress(platformReceipt.to, config.factoryAddress),
    `${endpoint.label} Platform deployment transaction did not call the approved Factory`,
  );
  assert(
    platformTransaction.blockNumber === platformReceipt.blockNumber,
    `${endpoint.label} Platform transaction and receipt blocks differ`,
  );
  assert(
    platformReceipt.blockNumber <= auditBlockNumber,
    `${endpoint.label} Platform deployment is not finalized at the audit block`,
  );
  decodeExpectedPlatformEvent(
    platformReceipt.logs,
    factoryArtifact,
    config,
    endpoint,
  );

  return {
    factoryBlockNumber: factoryReceipt.blockNumber,
    factoryBlockHash: factoryReceipt.blockHash,
    platformBlockNumber: platformReceipt.blockNumber,
    platformBlockHash: platformReceipt.blockHash,
  };
}

function assertSameDeploymentEvidence(left, right) {
  assert(
    left.factoryBlockNumber === right.factoryBlockNumber &&
      normalizeHex(left.factoryBlockHash) === normalizeHex(right.factoryBlockHash),
    "RPC endpoints disagree on the Factory deployment receipt",
  );
  assert(
    left.platformBlockNumber === right.platformBlockNumber &&
      normalizeHex(left.platformBlockHash) === normalizeHex(right.platformBlockHash),
    "RPC endpoints disagree on the Platform deployment receipt",
  );
}

export async function attestMonadDeployment({
  config,
  platformArtifact,
  factoryArtifact,
  endpoints,
}) {
  assert(
    Array.isArray(endpoints) && endpoints.length === 2,
    "Exactly two RPC endpoints are required",
  );
  assertOwnerlessArtifacts(platformArtifact, factoryArtifact);

  const audit = await chooseCommonFinalizedBlock(config, endpoints);
  const [platformRuntimeHash, factoryRuntimeHash, platformConfigurations, factoryVersion, deployments] =
    await Promise.all([
      attestRuntime({
        endpoints,
        address: config.platformAddress,
        auditBlockNumber: audit.auditBlockNumber,
        artifact: platformArtifact,
        label: "Platform",
      }),
      attestRuntime({
        endpoints,
        address: config.factoryAddress,
        auditBlockNumber: audit.auditBlockNumber,
        artifact: factoryArtifact,
        label: "Factory",
      }),
      Promise.all(
        endpoints.map((endpoint) =>
          readPlatformConfiguration(
            endpoint,
            config,
            platformArtifact,
            audit.auditBlockNumber,
          ),
        ),
      ),
      attestFactoryVersion(
        endpoints,
        config,
        factoryArtifact,
        audit.auditBlockNumber,
      ),
      Promise.all(
        endpoints.map((endpoint) =>
          readDeploymentTransactions(
            endpoint,
            config,
            factoryArtifact,
            audit.auditBlockNumber,
          ),
        ),
      ),
    ]);

  assertSamePlatformConfiguration(
    platformConfigurations[0],
    platformConfigurations[1],
  );
  assertExpectedPlatformConfiguration(platformConfigurations[0], config);
  assertSameDeploymentEvidence(deployments[0], deployments[1]);

  return Object.freeze({
    network: config.network,
    networkDisplayName: config.networkDisplayName,
    chainId: config.expectedChainId,
    auditBlockNumber: audit.auditBlockNumber,
    auditBlockHash: audit.auditBlockHash,
    finalizedHeads: audit.finalizedHeads,
    deployer: config.expectedDeployer,
    factoryAddress: config.factoryAddress,
    factoryRuntimeHash,
    factoryVersion,
    factoryDeploymentTxHash: config.factoryDeploymentTxHash,
    factoryDeploymentBlock: deployments[0].factoryBlockNumber,
    platformAddress: config.platformAddress,
    platformRuntimeHash,
    platformVersion: platformConfigurations[0].version,
    platformDeploymentTxHash: config.platformDeploymentTxHash,
    platformDeploymentBlock: deployments[0].platformBlockNumber,
    configurationLocked: platformConfigurations[0].configurationLocked,
    revenueRecipient: platformConfigurations[0].revenueRecipient,
    platformName: platformConfigurations[0].platformName,
    requestPrice: platformConfigurations[0].requestPrice,
    maxPending: platformConfigurations[0].maxPending,
    protocolFee: platformConfigurations[0].protocolFee,
  });
}

export function formatAttestationReport(result) {
  return [
    "Monad deployment attestation PASSED",
    `network: ${result.networkDisplayName} (chain ID ${result.chainId})`,
    `common finalized audit block: ${result.auditBlockNumber} (${result.auditBlockHash})`,
    `RPC agreement: A head ${result.finalizedHeads[0]}, B head ${result.finalizedHeads[1]}`,
    `deployer: ${result.deployer}`,
    `Factory: ${result.factoryAddress}`,
    `Factory deployment transaction: ${result.factoryDeploymentTxHash}`,
    `Factory deployment block: ${result.factoryDeploymentBlock}`,
    `Factory runtime hash / VERSION: ${result.factoryRuntimeHash} / ${result.factoryVersion}`,
    `Platform: ${result.platformAddress}`,
    `Platform deployment transaction: ${result.platformDeploymentTxHash}`,
    `Platform deployment block: ${result.platformDeploymentBlock}`,
    `Platform runtime hash / VERSION: ${result.platformRuntimeHash} / ${result.platformVersion}`,
    `configuration locked: ${result.configurationLocked}`,
    `revenue recipient: ${result.revenueRecipient}`,
    `platform name: ${JSON.stringify(result.platformName)}`,
    `request price (wei): ${result.requestPrice}`,
    `maximum pending requests: ${result.maxPending} (0 means unlimited)`,
    `protocol fee (wei): ${result.protocolFee}`,
    "ownerless ABI: exact V1 state-changing surface confirmed",
    "mode: read-only RPC calls; no transaction sent and no file written",
  ].join("\n");
}

export async function runAttestationCli(env = process.env) {
  const config = readAttestationEnvironment(env);
  const artifacts = await loadAttestationArtifacts(config);
  const endpoints = createAttestationEndpoints(config);
  const result = await attestMonadDeployment({
    config,
    ...artifacts,
    endpoints,
  });
  console.log(formatAttestationReport(result));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runAttestationCli().catch((error) => {
    console.error("Monad deployment attestation FAILED");
    console.error(
      error instanceof DeploymentAttestationError
        ? error.message
        : "Unexpected attestation failure",
    );
    process.exitCode = 1;
  });
}
