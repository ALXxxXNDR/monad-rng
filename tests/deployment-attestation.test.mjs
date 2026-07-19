import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiParameters,
} from "viem";

import {
  DeploymentAttestationError,
  assertOwnerlessArtifacts,
  attestMonadDeployment,
  formatAttestationReport,
  loadAttestationArtifacts,
  normalizeContractArtifact,
  readAttestationEnvironment,
} from "../scripts/attest-monad-deployment.mjs";

const platformRawArtifact = JSON.parse(
  await readFile(
    new URL("../public/contracts/PlatformRandomness.json", import.meta.url),
    "utf8",
  ),
);
const platformArtifact = normalizeContractArtifact(
  platformRawArtifact,
  "Platform",
);

const FACTORY = getAddress("0x1000000000000000000000000000000000000001");
const PLATFORM = getAddress("0x2000000000000000000000000000000000000002");
const DEPLOYER = getAddress("0x3000000000000000000000000000000000000003");
const RECIPIENT = getAddress("0x4000000000000000000000000000000000000004");
const FACTORY_TX = `0x${"11".repeat(32)}`;
const PLATFORM_TX = `0x${"22".repeat(32)}`;
const AUDIT_HASH = `0x${"aa".repeat(32)}`;
const FACTORY_BLOCK_HASH = `0x${"bb".repeat(32)}`;
const PLATFORM_BLOCK_HASH = `0x${"cc".repeat(32)}`;
const PLATFORM_NAME = "Test platform";

const factoryRawArtifact = {
  abi: [
    {
      type: "function",
      name: "VERSION",
      inputs: [],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "deployPlatform",
      inputs: [
        { name: "revenueRecipient", type: "address" },
        { name: "platformName", type: "string" },
        { name: "requestPrice", type: "uint256" },
        { name: "maxPending", type: "uint256" },
      ],
      outputs: [{ name: "platform", type: "address" }],
      stateMutability: "nonpayable",
    },
    {
      type: "event",
      name: "PlatformDeployed",
      inputs: [
        { indexed: true, name: "platform", type: "address" },
        { indexed: true, name: "revenueRecipient", type: "address" },
        { indexed: false, name: "platformName", type: "string" },
        { indexed: false, name: "requestPrice", type: "uint256" },
        { indexed: false, name: "maxPending", type: "uint256" },
      ],
      anonymous: false,
    },
  ],
  deployedBytecode: {
    object: "0x600160005260206000f3",
    linkReferences: {},
  },
};
const factoryArtifact = normalizeContractArtifact(
  factoryRawArtifact,
  "Factory",
);

const baseConfig = Object.freeze({
  network: "testnet",
  networkDisplayName: "Monad Testnet",
  expectedChainId: 10_143n,
  factoryAddress: FACTORY,
  platformAddress: PLATFORM,
  expectedDeployer: DEPLOYER,
  expectedRevenueRecipient: RECIPIENT,
  expectedPlatformName: PLATFORM_NAME,
  expectedRequestPrice: 0n,
  expectedMaxPending: 0n,
  factoryDeploymentTxHash: FACTORY_TX,
  platformDeploymentTxHash: PLATFORM_TX,
});

function deploymentLog() {
  return {
    address: FACTORY,
    topics: encodeEventTopics({
      abi: factoryRawArtifact.abi,
      eventName: "PlatformDeployed",
      args: {
        platform: PLATFORM,
        revenueRecipient: RECIPIENT,
      },
    }),
    data: encodeAbiParameters(
      parseAbiParameters("string, uint256, uint256"),
      [PLATFORM_NAME, 0n, 0n],
    ),
  };
}

function createFakeClient({
  finalizedNumber,
  auditHash = AUDIT_HASH,
  platformRuntime = platformArtifact.runtimeBytecode,
  revenueRecipient = RECIPIENT,
  platformName = PLATFORM_NAME,
  chainId = 10_143,
} = {}) {
  return {
    async getChainId() {
      return chainId;
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === "finalized") {
        return {
          number: finalizedNumber,
          hash: `0x${finalizedNumber.toString(16).padStart(64, "0")}`,
        };
      }
      assert.equal(blockNumber, 110n);
      return { number: blockNumber, hash: auditHash };
    },
    async getBytecode({ address, blockNumber }) {
      assert.equal(blockNumber, 110n);
      if (address === PLATFORM) return platformRuntime;
      if (address === FACTORY) return factoryArtifact.runtimeBytecode;
      return undefined;
    },
    async readContract({ address, functionName, blockNumber }) {
      assert.equal(blockNumber, 110n);
      if (address === FACTORY) {
        assert.equal(functionName, "VERSION");
        return 1n;
      }
      assert.equal(address, PLATFORM);
      const values = {
        CONFIGURATION_LOCKED: true,
        VERSION: 1n,
        revenueRecipient,
        platformName,
        requestPrice: 0n,
        maxPending: 0n,
        protocolFee: 0n,
      };
      assert.ok(functionName in values);
      return values[functionName];
    },
    async getTransaction({ hash }) {
      if (hash === FACTORY_TX) {
        return {
          hash,
          from: DEPLOYER,
          to: null,
          blockNumber: 10n,
        };
      }
      assert.equal(hash, PLATFORM_TX);
      return {
        hash,
        from: DEPLOYER,
        to: FACTORY,
        blockNumber: 11n,
      };
    },
    async getTransactionReceipt({ hash }) {
      if (hash === FACTORY_TX) {
        return {
          transactionHash: hash,
          status: "success",
          from: DEPLOYER,
          to: null,
          contractAddress: FACTORY,
          blockNumber: 10n,
          blockHash: FACTORY_BLOCK_HASH,
          logs: [],
        };
      }
      assert.equal(hash, PLATFORM_TX);
      return {
        transactionHash: hash,
        status: "success",
        from: DEPLOYER,
        to: FACTORY,
        contractAddress: null,
        blockNumber: 11n,
        blockHash: PLATFORM_BLOCK_HASH,
        logs: [deploymentLog()],
      };
    },
  };
}

function endpoint(label, options) {
  return { label, client: createFakeClient(options) };
}

test("environment parser pins Monad network and never accepts one RPC twice", () => {
  const env = {
    MONAD_NETWORK: "testnet",
    MONAD_EXPECTED_CHAIN_ID: "10143",
    MONAD_RPC_URL_PRIMARY: "https://rpc-a.example/key-one",
    MONAD_RPC_URL_SECONDARY: "https://rpc-b.example/key-two",
    MONAD_FACTORY_ADDRESS: FACTORY,
    MONAD_PLATFORM_ADDRESS: PLATFORM,
    MONAD_EXPECTED_DEPLOYER: DEPLOYER,
    MONAD_EXPECTED_REVENUE_RECIPIENT: RECIPIENT,
    MONAD_EXPECTED_PLATFORM_NAME: "",
    MONAD_EXPECTED_REQUEST_PRICE_WEI: "0",
    MONAD_EXPECTED_MAX_PENDING: "0",
    MONAD_FACTORY_DEPLOYMENT_TX_HASH: FACTORY_TX,
    MONAD_PLATFORM_DEPLOYMENT_TX_HASH: PLATFORM_TX,
  };

  const parsed = readAttestationEnvironment(env);
  assert.equal(parsed.expectedChainId, 10_143n);
  assert.equal(parsed.expectedPlatformName, "");

  assert.throws(
    () =>
      readAttestationEnvironment({
        ...env,
        MONAD_NETWORK: "mainnet",
      }),
    /requires chain ID 143/,
  );
  assert.throws(
    () =>
      readAttestationEnvironment({
        ...env,
        MONAD_RPC_URL_SECONDARY: env.MONAD_RPC_URL_PRIMARY,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      readAttestationEnvironment({
        ...env,
        MONAD_RPC_URL_SECONDARY: "https://rpc-a.example/key-two",
      }),
    /different provider origins/,
  );
  assert.throws(
    () =>
      readAttestationEnvironment({
        ...env,
        MONAD_NETWORK: "mainnet",
        MONAD_EXPECTED_CHAIN_ID: "143",
        MONAD_RPC_URL_PRIMARY: "http://rpc-a.example",
      }),
    /must use HTTPS for Mainnet/,
  );
});

test("two RPCs attest the common finalized block, exact runtimes, frozen getters, signer, and Factory event", async () => {
  const result = await attestMonadDeployment({
    config: baseConfig,
    platformArtifact,
    factoryArtifact,
    endpoints: [
      endpoint("RPC A", { finalizedNumber: 120n }),
      endpoint("RPC B", { finalizedNumber: 110n }),
    ],
  });

  assert.equal(result.auditBlockNumber, 110n);
  assert.equal(result.auditBlockHash, AUDIT_HASH);
  assert.equal(result.platformRuntimeHash, platformArtifact.runtimeBytecodeHash);
  assert.equal(result.factoryRuntimeHash, factoryArtifact.runtimeBytecodeHash);
  assert.equal(result.configurationLocked, true);
  assert.equal(result.deployer, DEPLOYER);
  assert.equal(result.factoryDeploymentTxHash, FACTORY_TX);
  assert.equal(result.platformDeploymentTxHash, PLATFORM_TX);

  const report = formatAttestationReport(result);
  assert.match(report, /PASSED/);
  assert.match(report, /read-only RPC calls/);
  assert.doesNotMatch(report, /rpc-a\.example|rpc-b\.example|key-one|key-two/);
});

test("attestation rejects endpoint disagreement and a wrong release runtime", async () => {
  await assert.rejects(
    attestMonadDeployment({
      config: baseConfig,
      platformArtifact,
      factoryArtifact,
      endpoints: [
        endpoint("RPC A", { finalizedNumber: 110n }),
        endpoint("RPC B", {
          finalizedNumber: 110n,
          auditHash: `0x${"dd".repeat(32)}`,
        }),
      ],
    }),
    /disagree on canonical hash/,
  );

  await assert.rejects(
    attestMonadDeployment({
      config: baseConfig,
      platformArtifact,
      factoryArtifact,
      endpoints: [
        endpoint("RPC A", {
          finalizedNumber: 110n,
          platformRuntime: "0x6000",
        }),
        endpoint("RPC B", {
          finalizedNumber: 110n,
          platformRuntime: "0x6000",
        }),
      ],
    }),
    /do not match the release artifact/,
  );
});

test("attestation rejects wrong permanent configuration", async () => {
  await assert.rejects(
    attestMonadDeployment({
      config: baseConfig,
      platformArtifact,
      factoryArtifact,
      endpoints: [
        endpoint("RPC A", {
          finalizedNumber: 110n,
          revenueRecipient: DEPLOYER,
        }),
        endpoint("RPC B", {
          finalizedNumber: 110n,
          revenueRecipient: DEPLOYER,
        }),
      ],
    }),
    /does not match the approved recipient/,
  );
});

test("ownerless ABI gate rejects any added state-changing admin function", () => {
  const unsafePlatform = {
    ...platformArtifact,
    abi: [
      ...platformArtifact.abi,
      {
        type: "function",
        name: "setRequestPrice",
        inputs: [{ name: "price", type: "uint256" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
  };

  assert.throws(
    () => assertOwnerlessArtifacts(unsafePlatform, factoryArtifact),
    DeploymentAttestationError,
  );
});

test("the two published artifacts pass the ownerless artifact gate", async () => {
  const artifacts = await loadAttestationArtifacts({
    platformArtifactPath: new URL(
      "../public/contracts/PlatformRandomness.json",
      import.meta.url,
    ),
    factoryArtifactPath: new URL(
      "../public/contracts/RandomnessFactory.json",
      import.meta.url,
    ),
  });

  assert.equal(
    artifacts.platformArtifact.runtimeBytecodeHash,
    platformArtifact.runtimeBytecodeHash,
  );
  assert.match(
    artifacts.factoryArtifact.runtimeBytecodeHash,
    /^0x[0-9a-f]{64}$/,
  );
});

test("RPC failures never echo a credential-bearing URL", async () => {
  const secretUrl = "https://rpc.example/super-secret-api-key";
  const brokenClient = createFakeClient({ finalizedNumber: 110n });
  brokenClient.getChainId = async () => {
    throw new Error(`request failed at ${secretUrl}`);
  };

  await assert.rejects(
    attestMonadDeployment({
      config: baseConfig,
      platformArtifact,
      factoryArtifact,
      endpoints: [
        { label: "RPC A", client: brokenClient },
        endpoint("RPC B", { finalizedNumber: 110n }),
      ],
    }),
    (error) => {
      assert.equal(error.message, "RPC A failed while reading chain ID");
      assert.doesNotMatch(error.message, /super-secret-api-key/);
      return true;
    },
  );
});

test("script contains no wallet or transaction-send path", async () => {
  const source = await readFile(
    new URL("../scripts/attest-monad-deployment.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /privateKeyToAccount|createWalletClient/);
  assert.doesNotMatch(source, /\.sendTransaction\(|\.writeContract\(/);
  assert.doesNotMatch(source, /writeFile|appendFile/);
});
