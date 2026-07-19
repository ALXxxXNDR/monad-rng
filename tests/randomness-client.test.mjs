import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MONAD_EXPLORER_URL,
  MONAD_RPC_URL,
  MONAD_TESTNET_CHAIN_HEX,
  MONAD_TESTNET_CHAIN_ID,
  RandomnessClientError,
  addressExplorerUrl,
  connectMonadWallet,
  ensureMonadTestnet,
  mapClientError,
  monadTestnet,
  requireContractAddress,
  transactionExplorerUrl,
} from "../app/lib/network.ts";
import {
  DEFAULT_DEMO_MAX_PENDING,
  DEMO_MAX_PENDING_LIMIT,
  assertCompatibleContract,
  calculateReadiness,
  deployDemoPlatform,
  expireRandomnessRequest,
  fetchRawHeaders,
  finalizeRandomnessTx,
  loadPlatformArtifact,
  readRandomnessResult,
  recoverDemoDeployment,
  recoverRandomnessExpiryTx,
  recoverRandomnessFinalizationTx,
  recoverRandomnessRequestTx,
  requestRandomnessTx,
  toOneBasedDraw,
} from "../app/lib/randomness.ts";
import {
  LOCAL_STATE_KEY,
  MAX_PENDING_TRANSACTIONS,
  forgetPendingTransaction,
  loadStoredState,
  readPendingTransactions,
  rememberDemoContract,
  rememberPendingTransaction,
  rememberRequest,
} from "../app/lib/storage.ts";
import * as storageClient from "../app/lib/storage.ts";
import {
  ChainMismatchError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeDeployData,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiParameters,
} from "viem";

const OWNER = getAddress("0x1000000000000000000000000000000000000001");
const REQUESTER = getAddress("0x2000000000000000000000000000000000000002");
const FINALIZER = getAddress("0x3000000000000000000000000000000000000003");
const CONTRACT = getAddress("0x4000000000000000000000000000000000000004");
const DEPLOY_HASH = `0x${"11".repeat(32)}`;
const TX1_HASH = `0x${"22".repeat(32)}`;
const TX2_HASH = `0x${"33".repeat(32)}`;
const EXPIRE_HASH = `0x${"44".repeat(32)}`;
const REPRICED_TX1_HASH = `0x${"55".repeat(32)}`;
const RESULT = `0x${"ab".repeat(32)}`;

const artifact = JSON.parse(
  await readFile(new URL("../public/contracts/PlatformRandomness.json", import.meta.url), "utf8"),
);
const OFFICIAL_RUNTIME_BYTECODE = artifact.runtimeBytecode;
const OFFICIAL_RUNTIME_HASH =
  "0x9b6bf6ae53e215ac89420c58ede612b423963c8876e5bfdf8df8b6db59d1c4ce";

test("RNG branding keeps the legacy browser state namespace recoverable", () => {
  assert.equal(LOCAL_STATE_KEY, "monad-rnd:state:v1");
});

function artifactFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      async json() {
        return artifact;
      },
    };
  };
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    dump(key) {
      return values.get(key);
    },
  };
}

function pendingRequest(overrides = {}) {
  return {
    requester: REQUESTER,
    requestBlock: 100n,
    firstTargetBlock: 108n,
    secondTargetBlock: 124n,
    thirdTargetBlock: 140n,
    pricePaid: 0n,
    finalizer: "0x0000000000000000000000000000000000000000",
    result: `0x${"00".repeat(32)}`,
    finalized: false,
    expired: false,
    ...overrides,
  };
}

function replacementTransaction({
  hash,
  to = CONTRACT,
  input = "0x1234",
  value = 9n,
} = {}) {
  return {
    accessList: [],
    blockHash: null,
    blockNumber: null,
    chainId: 10_143,
    from: REQUESTER,
    gas: 120_000n,
    gasPrice: 1n,
    hash,
    input,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    nonce: 7,
    r: `0x${"01".repeat(32)}`,
    s: `0x${"02".repeat(32)}`,
    to,
    transactionIndex: null,
    type: "eip1559",
    v: 1n,
    value,
    yParity: 0,
  };
}

function successfulReceipt({
  transactionHash,
  to = CONTRACT,
  logs = [],
} = {}) {
  return {
    blockHash: `0x${"03".repeat(32)}`,
    blockNumber: 200n,
    contractAddress: null,
    cumulativeGasUsed: 120_000n,
    effectiveGasPrice: 1n,
    from: REQUESTER,
    gasUsed: 120_000n,
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    status: "success",
    to,
    transactionHash,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function assertReplacementWaitArgs(args, hash) {
  assert.equal(args.hash, hash);
  assert.equal(args.confirmations, 3);
  assert.equal(args.checkReplacement, true);
  assert.equal(typeof args.onReplaced, "function");
}

function finalizedEventLog({
  address = CONTRACT,
  requestId = 7n,
  requester = REQUESTER,
  finalizer = FINALIZER,
  result = RESULT,
} = {}) {
  return {
    address,
    topics: encodeEventTopics({
      abi: artifact.abi,
      eventName: "RandomnessFinalized",
      args: { requestId, requester, finalizer },
    }),
    data: encodeAbiParameters(parseAbiParameters("bytes32"), [result]),
  };
}

function expiredEventLog({
  address = CONTRACT,
  requestId = 7n,
  requester = REQUESTER,
  expirer = FINALIZER,
} = {}) {
  return {
    address,
    topics: encodeEventTopics({
      abi: artifact.abi,
      eventName: "RandomnessRequestExpired",
      args: { requestId, requester, expirer },
    }),
    data: "0x",
  };
}

function viemExecutionError(errorName, args = []) {
  const functionName = errorName === "AlreadyExpired" ? "expireRequest" : "finalizeRandomness";
  const reverted = new ContractFunctionRevertedError({
    abi: artifact.abi,
    data: encodeErrorResult({ abi: artifact.abi, errorName, args }),
    functionName,
  });
  return new ContractFunctionExecutionError(reverted, {
    abi: artifact.abi,
    args: [],
    contractAddress: CONTRACT,
    functionName,
    sender: REQUESTER,
  });
}

test("Monad testnet definition and explorer links are exact", () => {
  assert.equal(MONAD_TESTNET_CHAIN_ID, 10_143);
  assert.equal(MONAD_TESTNET_CHAIN_HEX, "0x279f");
  assert.equal(MONAD_RPC_URL, "https://testnet-rpc.monad.xyz");
  assert.equal(MONAD_EXPLORER_URL, "https://testnet.monadscan.com");
  assert.equal(monadTestnet.id, 10_143);
  assert.deepEqual(monadTestnet.rpcUrls.default.http, [MONAD_RPC_URL]);
  assert.equal(monadTestnet.nativeCurrency.symbol, "MON");
  assert.equal(addressExplorerUrl(CONTRACT), `${MONAD_EXPLORER_URL}/address/${CONTRACT}`);
  assert.equal(transactionExplorerUrl(TX1_HASH), `${MONAD_EXPLORER_URL}/tx/${TX1_HASH}`);
});

test("wallet connect requests accounts and switches an existing Monad chain", async () => {
  const requests = [];
  let currentChain = "0x1";
  const provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === "eth_requestAccounts") return [OWNER];
      if (payload.method === "eth_chainId") return currentChain;
      if (payload.method === "wallet_switchEthereumChain") {
        currentChain = payload.params[0].chainId;
        return null;
      }
      throw new Error(`Unexpected method ${payload.method}`);
    },
  };

  const account = await connectMonadWallet(provider);
  assert.equal(account, OWNER);
  assert.deepEqual(requests, [
    { method: "eth_requestAccounts" },
    { method: "eth_chainId" },
    {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x279f" }],
    },
    { method: "eth_chainId" },
  ]);
});

test("unknown Monad chain is added, explicitly switched, and verified", async () => {
  const requests = [];
  let currentChain = "0x1";
  let switchAttempts = 0;
  const provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === "eth_chainId") return currentChain;
      if (payload.method === "wallet_switchEthereumChain") {
        switchAttempts += 1;
        if (switchAttempts === 1) {
          const error = new Error("unknown chain");
          error.code = 4902;
          throw error;
        }
        currentChain = payload.params[0].chainId;
        return null;
      }
      if (payload.method === "wallet_addEthereumChain") return null;
      throw new Error(`Unexpected method ${payload.method}`);
    },
  };

  await ensureMonadTestnet(provider);
  assert.deepEqual(requests, [
    { method: "eth_chainId" },
    {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x279f" }],
    },
    {
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x279f",
          chainName: "Monad Testnet",
          nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
          rpcUrls: ["https://testnet-rpc.monad.xyz"],
          blockExplorerUrls: ["https://testnet.monadscan.com"],
        },
      ],
    },
    {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x279f" }],
    },
    { method: "eth_chainId" },
  ]);
});

test("a wallet that reports switch success but stays on another chain is rejected", async () => {
  const provider = {
    async request({ method }) {
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected method ${method}`);
    },
  };

  await assert.rejects(ensureMonadTestnet(provider), {
    code: "WRONG_NETWORK",
  });
});

test("EIP-3085 add request keeps exact Monad network metadata", async () => {
  const requests = [];
  let switchAttempts = 0;
  const provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === "eth_chainId") {
        return switchAttempts > 1 ? MONAD_TESTNET_CHAIN_HEX : "0x1";
      }
      if (payload.method === "wallet_switchEthereumChain") {
        switchAttempts += 1;
        if (switchAttempts === 1) {
          throw Object.assign(new Error("unknown chain"), { code: 4902 });
        }
        return null;
      }
      if (payload.method === "wallet_addEthereumChain") return null;
      throw new Error(`Unexpected method ${payload.method}`);
    },
  };
  await ensureMonadTestnet(provider);
  assert.deepEqual(requests[2], {
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: "0x279f",
        chainName: "Monad Testnet",
        nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
        rpcUrls: ["https://testnet-rpc.monad.xyz"],
        blockExplorerUrls: ["https://testnet.monadscan.com"],
      },
    ],
  });
});

test("contract address validation rejects invalid and code-less addresses", async () => {
  assert.equal(requireContractAddress(CONTRACT.toLowerCase()), CONTRACT);
  assert.throws(() => requireContractAddress("not-an-address"), {
    code: "INVALID_ADDRESS",
  });

  await assert.rejects(
    readRandomnessResult({
      publicClient: {
        async getBytecode() {
          return undefined;
        },
      },
      contractAddress: CONTRACT,
      requestId: 1n,
      fetchImpl: artifactFetch(),
    }),
    { code: "CONTRACT_NOT_FOUND" },
  );
});

test("published artifact carries the exact official runtime bytecode and keccak256 hash", () => {
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.runtimeBytecodeHash, OFFICIAL_RUNTIME_HASH);
  assert.equal(keccak256(OFFICIAL_RUNTIME_BYTECODE), OFFICIAL_RUNTIME_HASH);
  assert.match(artifact.runtimeBytecode, /^0x(?:[0-9a-fA-F]{2})+$/);
  assert.doesNotMatch(artifact.bytecode, /__\$[0-9a-fA-F]{34}\$__/);
  assert.doesNotMatch(artifact.runtimeBytecode, /__\$[0-9a-fA-F]{34}\$__/);
});

test("contract attestation accepts only the exact published runtime", async () => {
  assert.equal(
    await assertCompatibleContract(
      {
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      CONTRACT,
      artifact,
    ),
    CONTRACT,
  );

  await assert.rejects(
    assertCompatibleContract(
      {
        async getBytecode() {
          return "0x6000";
        },
      },
      CONTRACT,
      artifact,
    ),
    { code: "INCOMPATIBLE_CONTRACT" },
  );
});

test("artifact loading rejects malformed or self-inconsistent runtime attestations", async () => {
  for (const malformed of [
    { ...artifact, schemaVersion: 1 },
    { ...artifact, runtimeBytecode: "0x600" },
    { ...artifact, runtimeBytecode: "0x6000" },
    { ...artifact, runtimeBytecodeHash: "0x1234" },
  ]) {
    await assert.rejects(
      loadPlatformArtifact(async () => ({
        ok: true,
        async json() {
          return malformed;
        },
      })),
      { code: "INVALID_ARTIFACT" },
    );
  }
});

test("published artifact is fetched and demo deployment is zero-price with bounded cap", async () => {
  const fetchCalls = [];
  const deployCalls = [];
  const sequence = [];
  const expectedDeployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [OWNER, "My demo", 0n, 128n],
  });
  const walletClient = {
    async deployContract(args) {
      sequence.push("wallet");
      deployCalls.push(args);
      return DEPLOY_HASH;
    },
  };
  const publicClient = {
    async estimateGas(args) {
      sequence.push("estimate");
      assert.deepEqual(args, {
        account: OWNER,
        data: expectedDeployData,
        value: 0n,
      });
      return 4_000_000n;
    },
    async waitForTransactionReceipt(args) {
      sequence.push("wait");
      assertReplacementWaitArgs(args, DEPLOY_HASH);
      return {
        status: "success",
        transactionHash: DEPLOY_HASH,
        to: null,
        contractAddress: CONTRACT,
      };
    },
    async getBytecode({ address }) {
      sequence.push("code");
      assert.equal(address, CONTRACT);
      return OFFICIAL_RUNTIME_BYTECODE;
    },
  };

  const loaded = await loadPlatformArtifact(artifactFetch(fetchCalls));
  assert.deepEqual(loaded.abi, artifact.abi);
  assert.equal(loaded.bytecode, artifact.bytecode);

  const deployment = await deployDemoPlatform({
    walletClient,
    publicClient,
    owner: OWNER,
    platformName: "My demo",
    maxPending: DEFAULT_DEMO_MAX_PENDING,
    fetchImpl: artifactFetch(fetchCalls),
    onTransactionHash(transactionHash) {
      sequence.push("hash");
      assert.equal(transactionHash, DEPLOY_HASH);
    },
  });

  assert.equal(DEFAULT_DEMO_MAX_PENDING, 128n);
  assert.equal(DEMO_MAX_PENDING_LIMIT, 256n);
  assert.equal(deployment.contractAddress, CONTRACT);
  assert.equal(deployment.transactionHash, DEPLOY_HASH);
  assert.deepEqual(deployCalls[0].args, [OWNER, "My demo", 0n, 128n]);
  assert.equal(deployCalls[0].bytecode, artifact.bytecode);
  assert.equal(deployCalls[0].account, OWNER);
  assert.equal(deployCalls[0].value, 0n);
  assert.equal(deployCalls[0].gas, 4_800_000n);
  assert.deepEqual(sequence, ["estimate", "wallet", "hash", "wait", "code"]);
  assert.equal(fetchCalls[0].url, "/contracts/PlatformRandomness.json");

  await assert.rejects(
    deployDemoPlatform({
      walletClient,
      publicClient,
      owner: OWNER,
      maxPending: 257n,
      fetchImpl: artifactFetch(),
    }),
    { code: "INVALID_PENDING_CAP" },
  );
});

test("deployment gas estimation failure and cap overflow never open the wallet", async () => {
  let walletCalls = 0;
  const walletClient = {
    async deployContract() {
      walletCalls += 1;
      return DEPLOY_HASH;
    },
  };

  await assert.rejects(
    deployDemoPlatform({
      walletClient,
      publicClient: {
        async estimateGas() {
          throw new Error("RPC estimate unavailable");
        },
      },
      owner: OWNER,
      fetchImpl: artifactFetch(),
    }),
    { code: "GAS_ESTIMATION_FAILED" },
  );
  assert.equal(walletCalls, 0);

  await assert.rejects(
    deployDemoPlatform({
      walletClient,
      publicClient: {
        async estimateGas() {
          return 5_000_001n;
        },
      },
      owner: OWNER,
      fetchImpl: artifactFetch(),
    }),
    { code: "GAS_LIMIT_EXCEEDED" },
  );
  assert.equal(walletCalls, 0);
});

test("deployment recovery waits three confirmations and verifies the deployed runtime without a wallet write", async () => {
  let walletWrites = 0;
  const recovery = await recoverDemoDeployment({
    publicClient: {
      async waitForTransactionReceipt(args) {
        assertReplacementWaitArgs(args, DEPLOY_HASH);
        return {
          status: "success",
          transactionHash: DEPLOY_HASH,
          to: null,
          contractAddress: CONTRACT,
        };
      },
      async getBytecode({ address }) {
        assert.equal(address, CONTRACT);
        return OFFICIAL_RUNTIME_BYTECODE;
      },
    },
    transactionHash: DEPLOY_HASH,
    artifact,
    walletClient: {
      async deployContract() {
        walletWrites += 1;
        return DEPLOY_HASH;
      },
    },
  });

  assert.deepEqual(recovery, {
    contractAddress: CONTRACT,
    transactionHash: DEPLOY_HASH,
  });
  assert.equal(walletWrites, 0);
});

test("deployment recovery rejects malformed, mismatched, or incompatible transactions", async () => {
  let receiptWaits = 0;
  await assert.rejects(
    recoverDemoDeployment({
      publicClient: {
        async waitForTransactionReceipt() {
          receiptWaits += 1;
          throw new Error("must not wait");
        },
      },
      transactionHash: "0x1234",
      artifact,
    }),
    { code: "INVALID_TRANSACTION_HASH" },
  );
  assert.equal(receiptWaits, 0);

  await assert.rejects(
    recoverDemoDeployment({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX1_HASH,
            contractAddress: CONTRACT,
          };
        },
      },
      transactionHash: DEPLOY_HASH,
      artifact,
    }),
    { code: "INVALID_TRANSACTION_HASH" },
  );

  await assert.rejects(
    recoverDemoDeployment({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: DEPLOY_HASH,
            to: CONTRACT,
            contractAddress: CONTRACT,
          };
        },
      },
      transactionHash: DEPLOY_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverDemoDeployment({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            contractAddress: CONTRACT,
          };
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      transactionHash: DEPLOY_HASH,
      artifact,
    }),
    { code: "INVALID_TRANSACTION_HASH" },
  );

  await assert.rejects(
    recoverDemoDeployment({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: DEPLOY_HASH,
            to: null,
            contractAddress: CONTRACT,
          };
        },
        async getBytecode() {
          return "0x6000";
        },
      },
      transactionHash: DEPLOY_HASH,
      artifact,
    }),
    { code: "INCOMPATIBLE_CONTRACT" },
  );
});

test("Tx1 reads the exact live platform price and decodes RandomnessRequested", async () => {
  const writeCalls = [];
  const sequence = [];
  const eventTopics = encodeEventTopics({
    abi: artifact.abi,
    eventName: "RandomnessRequested",
    args: { requestId: 7n, requester: REQUESTER },
  });
  const eventData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
    [100n, 108n, 124n, 140n, 9n],
  );
  const publicClient = {
    async getBytecode() {
      sequence.push("code");
      return OFFICIAL_RUNTIME_BYTECODE;
    },
    async readContract({ functionName, blockTag }) {
      sequence.push("price");
      assert.equal(functionName, "requestPrice");
      assert.equal(blockTag, "latest");
      return 9n;
    },
    async estimateContractGas(args) {
      sequence.push("estimate");
      assert.equal(args.account, REQUESTER);
      assert.equal(args.address, CONTRACT);
      assert.equal(args.functionName, "requestRandomness");
      assert.deepEqual(args.args, []);
      assert.equal(args.value, 9n);
      return 100_000n;
    },
    async waitForTransactionReceipt(args) {
      sequence.push("wait");
      assertReplacementWaitArgs(args, TX1_HASH);
      return {
        status: "success",
        transactionHash: TX1_HASH,
        to: CONTRACT,
        logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
      };
    },
  };
  const walletClient = {
    async writeContract(args) {
      sequence.push("wallet");
      writeCalls.push(args);
      return TX1_HASH;
    },
  };

  const requested = await requestRandomnessTx({
    publicClient,
    walletClient,
    account: REQUESTER,
    contractAddress: CONTRACT,
    fetchImpl: artifactFetch(),
    onTransactionHash(transactionHash) {
      sequence.push("hash");
      assert.equal(transactionHash, TX1_HASH);
    },
  });

  assert.equal(writeCalls[0].functionName, "requestRandomness");
  assert.equal(writeCalls[0].account, REQUESTER);
  assert.equal(writeCalls[0].value, 9n);
  assert.equal(writeCalls[0].gas, 120_000n);
  assert.deepEqual(sequence, ["code", "price", "estimate", "wallet", "hash", "wait"]);
  assert.equal(requested.requestId, 7n);
  assert.equal(requested.requester, REQUESTER);
  assert.deepEqual(requested.targetBlocks, [108n, 124n, 140n]);
  assert.equal(requested.transactionHash, TX1_HASH);
});

test("repriced Tx1 promotes the replacement hash and validates the replacement result", async () => {
  const observedHashes = [];
  const eventTopics = encodeEventTopics({
    abi: artifact.abi,
    eventName: "RandomnessRequested",
    args: { requestId: 7n, requester: REQUESTER },
  });
  const eventData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
    [100n, 108n, 124n, 140n, 9n],
  );
  const replacementReceipt = successfulReceipt({
    transactionHash: REPRICED_TX1_HASH,
    logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
  });

  const requested = await requestRandomnessTx({
    publicClient: {
      async getBytecode() {
        return OFFICIAL_RUNTIME_BYTECODE;
      },
      async readContract() {
        return 9n;
      },
      async estimateContractGas() {
        return 100_000n;
      },
      async waitForTransactionReceipt(args) {
        args.onReplaced({
          reason: "repriced",
          replacedTransaction: replacementTransaction({ hash: TX1_HASH }),
          transaction: replacementTransaction({ hash: REPRICED_TX1_HASH }),
          transactionReceipt: replacementReceipt,
        });
        return replacementReceipt;
      },
    },
    walletClient: {
      async writeContract() {
        return TX1_HASH;
      },
    },
    account: REQUESTER,
    contractAddress: CONTRACT,
    artifact,
    onTransactionHash(transactionHash) {
      observedHashes.push(transactionHash);
    },
  });

  assert.deepEqual(observedHashes, [TX1_HASH, REPRICED_TX1_HASH]);
  assert.equal(requested.transactionHash, REPRICED_TX1_HASH);
  assert.equal(requested.requestId, 7n);
  assert.equal(requested.requester, REQUESTER);
});

test("cancelled or different Tx1 replacement is safe to forget without accepting an action result", async () => {
  for (const reason of ["cancelled", "replaced"]) {
    let runtimeReads = 0;
    let replacementHashNotifications = 0;
    const replacementReceipt = successfulReceipt({
      transactionHash: REPRICED_TX1_HASH,
      to: reason === "cancelled" ? REQUESTER : OWNER,
    });

    await assert.rejects(
      recoverRandomnessRequestTx({
        publicClient: {
          async waitForTransactionReceipt(args) {
            args.onReplaced({
              reason,
              replacedTransaction: replacementTransaction({ hash: TX1_HASH }),
              transaction: replacementTransaction({
                hash: REPRICED_TX1_HASH,
                to: reason === "cancelled" ? REQUESTER : OWNER,
                input: reason === "cancelled" ? "0x" : "0xabcd",
                value: 0n,
              }),
              transactionReceipt: replacementReceipt,
            });
            return replacementReceipt;
          },
          async getBytecode() {
            runtimeReads += 1;
            return OFFICIAL_RUNTIME_BYTECODE;
          },
        },
        contractAddress: CONTRACT,
        transactionHash: TX1_HASH,
        expectedRequester: REQUESTER,
        artifact,
        onTransactionHash() {
          replacementHashNotifications += 1;
        },
      }),
      { code: "TRANSACTION_REPLACED" },
    );

    assert.equal(runtimeReads, 0);
    assert.equal(replacementHashNotifications, 0);
  }
});

test("Tx1 cap rejection never invokes the wallet", async () => {
  let walletCalls = 0;
  await assert.rejects(
    requestRandomnessTx({
      publicClient: {
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
        async readContract() {
          return 0n;
        },
        async estimateContractGas() {
          return 250_001n;
        },
      },
      walletClient: {
        async writeContract() {
          walletCalls += 1;
          return TX1_HASH;
        },
      },
      account: REQUESTER,
      contractAddress: CONTRACT,
      fetchImpl: artifactFetch(),
    }),
    { code: "GAS_LIMIT_EXCEEDED" },
  );
  assert.equal(walletCalls, 0);
});

test("broadcast hash callback runs before an injected receipt RPC failure", async () => {
  const sequence = [];

  await assert.rejects(
    requestRandomnessTx({
      publicClient: {
        async getBytecode() {
          sequence.push("code");
          return OFFICIAL_RUNTIME_BYTECODE;
        },
        async readContract() {
          sequence.push("price");
          return 0n;
        },
        async estimateContractGas() {
          sequence.push("estimate");
          return 100_000n;
        },
        async waitForTransactionReceipt() {
          sequence.push("wait");
          throw new Error("injected receipt RPC failure");
        },
      },
      walletClient: {
        async writeContract() {
          sequence.push("wallet");
          return TX1_HASH;
        },
      },
      account: REQUESTER,
      contractAddress: CONTRACT,
      fetchImpl: artifactFetch(),
      onTransactionHash(transactionHash) {
        sequence.push("hash");
        assert.equal(transactionHash, TX1_HASH);
      },
    }),
    { code: "UNKNOWN" },
  );

  assert.deepEqual(sequence, ["code", "price", "estimate", "wallet", "hash", "wait"]);
});

test("a hash callback failure cannot mask an already-broadcast transaction", async () => {
  const eventTopics = encodeEventTopics({
    abi: artifact.abi,
    eventName: "RandomnessRequested",
    args: { requestId: 7n, requester: REQUESTER },
  });
  const eventData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
    [100n, 108n, 124n, 140n, 0n],
  );
  const sequence = [];

  const requested = await requestRandomnessTx({
    publicClient: {
      async getBytecode() {
        return OFFICIAL_RUNTIME_BYTECODE;
      },
      async readContract() {
        return 0n;
      },
      async estimateContractGas() {
        return 100_000n;
      },
      async waitForTransactionReceipt() {
        sequence.push("wait");
        return {
          status: "success",
          transactionHash: TX1_HASH,
          to: CONTRACT,
          logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
        };
      },
    },
    walletClient: {
      async writeContract() {
        sequence.push("wallet");
        return TX1_HASH;
      },
    },
    account: REQUESTER,
    contractAddress: CONTRACT,
    artifact,
    onTransactionHash() {
      sequence.push("hash");
      throw new Error("injected observer failure");
    },
  });

  assert.equal(requested.transactionHash, TX1_HASH);
  assert.deepEqual(sequence, ["wallet", "hash", "wait"]);
});

test("Tx1 recovery decodes the exact event after three confirmations without rebroadcasting", async () => {
  const eventTopics = encodeEventTopics({
    abi: artifact.abi,
    eventName: "RandomnessRequested",
    args: { requestId: 7n, requester: REQUESTER },
  });
  const eventData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
    [100n, 108n, 124n, 140n, 9n],
  );
  let walletWrites = 0;

  const recovered = await recoverRandomnessRequestTx({
    publicClient: {
      async waitForTransactionReceipt(args) {
        assertReplacementWaitArgs(args, TX1_HASH);
        return {
          status: "success",
          transactionHash: TX1_HASH,
          to: CONTRACT,
          logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
        };
      },
      async getBytecode({ address }) {
        assert.equal(address, CONTRACT);
        return OFFICIAL_RUNTIME_BYTECODE;
      },
    },
    contractAddress: CONTRACT,
    transactionHash: TX1_HASH,
    expectedRequester: REQUESTER,
    artifact,
    walletClient: {
      async writeContract() {
        walletWrites += 1;
        return TX1_HASH;
      },
    },
  });

  assert.deepEqual(recovered, {
    transactionHash: TX1_HASH,
    requestId: 7n,
    requester: REQUESTER,
    requestBlock: 100n,
    targetBlocks: [108n, 124n, 140n],
    pricePaid: 9n,
  });
  assert.equal(walletWrites, 0);
});

test("Tx1 recovery rejects a receipt for another contract or requester", async () => {
  const makeLog = (requester) => ({
    address: CONTRACT,
    topics: encodeEventTopics({
      abi: artifact.abi,
      eventName: "RandomnessRequested",
      args: { requestId: 7n, requester },
    }),
    data: encodeAbiParameters(
      parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
      [100n, 108n, 124n, 140n, 9n],
    ),
  });

  await assert.rejects(
    recoverRandomnessRequestTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX1_HASH,
            to: OWNER,
            logs: [makeLog(REQUESTER)],
          };
        },
      },
      contractAddress: CONTRACT,
      transactionHash: TX1_HASH,
      expectedRequester: REQUESTER,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessRequestTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX1_HASH,
            logs: [makeLog(REQUESTER)],
          };
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      contractAddress: CONTRACT,
      transactionHash: TX1_HASH,
      expectedRequester: REQUESTER,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessRequestTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            status: "success",
            transactionHash: TX1_HASH,
            to: CONTRACT,
            logs: [makeLog(FINALIZER)],
          };
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      contractAddress: CONTRACT,
      transactionHash: TX1_HASH,
      expectedRequester: REQUESTER,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("a persisted Tx1 hash survives reload and recovers without another wallet write", async () => {
  const storage = memoryStorage();
  let walletWrites = 0;

  await assert.rejects(
    requestRandomnessTx({
      publicClient: {
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
        async readContract() {
          return 0n;
        },
        async estimateContractGas() {
          return 100_000n;
        },
        async waitForTransactionReceipt() {
          throw new Error("receipt RPC unavailable after broadcast");
        },
      },
      walletClient: {
        async writeContract() {
          walletWrites += 1;
          return TX1_HASH;
        },
      },
      account: REQUESTER,
      contractAddress: CONTRACT,
      artifact,
      onTransactionHash(transactionHash) {
        rememberPendingTransaction(storage, {
          kind: "request",
          chainId: 10_143,
          contractAddress: CONTRACT,
          requester: REQUESTER,
          transactionHash,
          createdAt: 1_234,
        });
      },
    }),
    { code: "UNKNOWN" },
  );
  assert.equal(walletWrites, 1);

  const reloadedStorage = memoryStorage({
    [LOCAL_STATE_KEY]: storage.dump(LOCAL_STATE_KEY),
  });
  const [pending] = readPendingTransactions(reloadedStorage, 10_143);
  assert.deepEqual(pending, {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requester: REQUESTER,
    transactionHash: TX1_HASH,
    createdAt: 1_234,
  });

  const eventTopics = encodeEventTopics({
    abi: artifact.abi,
    eventName: "RandomnessRequested",
    args: { requestId: 7n, requester: REQUESTER },
  });
  const eventData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256, uint256, uint256"),
    [100n, 108n, 124n, 140n, 0n],
  );
  const recovered = await recoverRandomnessRequestTx({
    publicClient: {
      async waitForTransactionReceipt() {
        return {
          status: "success",
          transactionHash: pending.transactionHash,
          to: pending.contractAddress,
          logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
        };
      },
      async getBytecode() {
        return OFFICIAL_RUNTIME_BYTECODE;
      },
    },
    contractAddress: pending.contractAddress,
    transactionHash: pending.transactionHash,
    expectedRequester: pending.requester,
    artifact,
  });

  assert.equal(recovered.requestId, 7n);
  assert.equal(walletWrites, 1);
  forgetPendingTransaction(reloadedStorage, pending.transactionHash);
  assert.deepEqual(readPendingTransactions(reloadedStorage), []);
});

test("raw-header retrieval sends exactly three debug_getRawHeader RPC calls", async () => {
  const calls = [];
  const headers = await fetchRawHeaders([108n, 124n, 140n], async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: body.id, result: `0xf90${body.id}` };
      },
    };
  });

  assert.deepEqual(headers, ["0xf901", "0xf902", "0xf903"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ url, body }) => ({ url, body })),
    [
      {
        url: MONAD_RPC_URL,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "debug_getRawHeader",
          params: ["0x6c"],
        },
      },
      {
        url: MONAD_RPC_URL,
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "debug_getRawHeader",
          params: ["0x7c"],
        },
      },
      {
        url: MONAD_RPC_URL,
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "debug_getRawHeader",
          params: ["0x8c"],
        },
      },
    ],
  );
});

test("raw headers accept a current-size even byte string and reject odd, empty, or oversized hex", async () => {
  const currentSizeHeader = `0x${"ab".repeat(647)}`;
  const accepted = await fetchRawHeaders([1n, 2n, 3n], async (_url, options) => {
    const { id } = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id, result: currentSizeHeader };
      },
    };
  });
  assert.equal(accepted[0], currentSizeHeader);

  for (const malformed of ["0x", "0xabc", `0x${"ab".repeat(4_097)}`]) {
    await assert.rejects(
      fetchRawHeaders([1n, 2n, 3n], async (_url, options) => {
        const { id } = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { jsonrpc: "2.0", id, result: malformed };
          },
        };
      }),
      { code: "RAW_HEADER_UNAVAILABLE" },
    );
  }
});

test("debug_getRawHeader method-not-found is scoped to the raw-header operation", async () => {
  await assert.rejects(
    fetchRawHeaders([1n, 2n, 3n], async (_url, options) => {
      const { id } = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "method not found" },
          };
        },
      };
    }),
    { code: "RAW_HEADER_UNAVAILABLE" },
  );
});

test("readiness covers every Tx2, rescue, and proof-expiry boundary", () => {
  const request = pendingRequest();
  assert.deepEqual(calculateReadiness(request, 141n, REQUESTER), {
    phase: "waiting",
    canFinalize: false,
    canExpire: false,
    blocksRemaining: 1n,
    requesterFinalizationBlock: 142n,
    permissionlessRescueBlock: 204n,
    lastProofValidBlock: 8_299n,
    firstExpiryBlock: 8_300n,
  });
  assert.equal(calculateReadiness(request, 142n, REQUESTER).phase, "requester");
  assert.equal(calculateReadiness(request, 142n, REQUESTER).canFinalize, true);
  assert.equal(calculateReadiness(request, 142n, FINALIZER).canFinalize, false);
  assert.equal(calculateReadiness(request, 203n, REQUESTER).phase, "requester");
  assert.equal(calculateReadiness(request, 204n, FINALIZER).phase, "permissionless");
  assert.equal(calculateReadiness(request, 204n, FINALIZER).canFinalize, true);
  assert.equal(calculateReadiness(request, 8_299n, FINALIZER).phase, "permissionless");
  assert.equal(calculateReadiness(request, 8_299n, FINALIZER).canFinalize, true);
  assert.equal(calculateReadiness(request, 8_300n, FINALIZER).phase, "proof-expired");
  assert.equal(calculateReadiness(request, 8_300n, FINALIZER).canFinalize, false);
  assert.equal(calculateReadiness(request, 8_300n, FINALIZER).canExpire, true);
});

test("Tx2 uses three headers then reads the permanent seed and 1-100 draw", async () => {
  const writeCalls = [];
  const sequence = [];
  const headers = ["0xf901", "0xf902", "0xf903"];
  const finalizedRequest = pendingRequest({
    finalizer: REQUESTER,
    result: RESULT,
    finalized: true,
  });
  const publicClient = {
    async getBytecode() {
      sequence.push("code");
      return OFFICIAL_RUNTIME_BYTECODE;
    },
    async estimateContractGas(args) {
      sequence.push("estimate");
      assert.equal(args.account, REQUESTER);
      assert.equal(args.address, CONTRACT);
      assert.equal(args.functionName, "finalizeRandomness");
      assert.deepEqual(args.args, [7n, ...headers]);
      assert.equal(args.value, 0n);
      return 600_000n;
    },
    async waitForTransactionReceipt(args) {
      sequence.push("wait");
      assertReplacementWaitArgs(args, TX2_HASH);
      return {
        status: "success",
        transactionHash: TX2_HASH,
        to: CONTRACT,
        logs: [finalizedEventLog({ finalizer: REQUESTER })],
      };
    },
    async readContract({ functionName, args, blockTag }) {
      sequence.push(functionName);
      assert.equal(blockTag, "finalized");
      if (functionName === "getRequest") {
        assert.deepEqual(args, [7n]);
        return finalizedRequest;
      }
      if (functionName === "draw") {
        assert.deepEqual(args, [7n, 100n]);
        return 41n;
      }
      throw new Error(`Unexpected read ${functionName}`);
    },
  };
  const walletClient = {
    async writeContract(args) {
      sequence.push("wallet");
      writeCalls.push(args);
      return TX2_HASH;
    },
  };

  const finalized = await finalizeRandomnessTx({
    publicClient,
    walletClient,
    account: REQUESTER,
    contractAddress: CONTRACT,
    requestId: 7n,
    headers,
    fetchImpl: artifactFetch(),
    onTransactionHash(transactionHash) {
      sequence.push("hash");
      assert.equal(transactionHash, TX2_HASH);
    },
  });

  assert.equal(writeCalls[0].functionName, "finalizeRandomness");
  assert.deepEqual(writeCalls[0].args, [7n, ...headers]);
  assert.equal(writeCalls[0].account, REQUESTER);
  assert.equal(writeCalls[0].value, 0n);
  assert.equal(writeCalls[0].gas, 720_000n);
  assert.deepEqual(sequence, [
    "code",
    "estimate",
    "wallet",
    "hash",
    "wait",
    "code",
    "getRequest",
    "draw",
  ]);
  assert.equal(finalized.transactionHash, TX2_HASH);
  assert.equal(finalized.request.result, RESULT);
  assert.equal(finalized.drawZeroBased, 41n);
  assert.equal(finalized.drawOneBased, 42);
  assert.equal(toOneBasedDraw(99n), 100);
});

test("Tx2 recovery verifies the exact event and permanent result without another wallet write", async () => {
  let walletWrites = 0;
  const finalizedRequest = pendingRequest({
    finalizer: FINALIZER,
    result: RESULT,
    finalized: true,
  });
  const recovered = await recoverRandomnessFinalizationTx({
    publicClient: {
      async waitForTransactionReceipt(args) {
        assertReplacementWaitArgs(args, TX2_HASH);
        return {
          status: "success",
          transactionHash: TX2_HASH,
          to: CONTRACT,
          logs: [finalizedEventLog()],
        };
      },
      async getBytecode() {
        return OFFICIAL_RUNTIME_BYTECODE;
      },
      async readContract({ functionName, args, blockTag }) {
        assert.equal(blockTag, "finalized");
        if (functionName === "getRequest") {
          assert.deepEqual(args, [7n]);
          return finalizedRequest;
        }
        if (functionName === "draw") {
          assert.deepEqual(args, [7n, 100n]);
          return 41n;
        }
        throw new Error(`Unexpected read ${functionName}`);
      },
    },
    contractAddress: CONTRACT,
    requestId: 7n,
    transactionHash: TX2_HASH,
    artifact,
    walletClient: {
      async writeContract() {
        walletWrites += 1;
        return TX2_HASH;
      },
    },
  });

  assert.equal(walletWrites, 0);
  assert.equal(recovered.transactionHash, TX2_HASH);
  assert.equal(recovered.request.finalized, true);
  assert.equal(recovered.request.result, RESULT);
  assert.equal(recovered.drawZeroBased, 41n);
  assert.equal(recovered.drawOneBased, 42);
});

test("Tx2 recovery rejects wrong destination, request event, or final state", async () => {
  const baseReceipt = {
    status: "success",
    transactionHash: TX2_HASH,
    to: CONTRACT,
    logs: [finalizedEventLog()],
  };

  await assert.rejects(
    recoverRandomnessFinalizationTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return { ...baseReceipt, to: OWNER };
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: TX2_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessFinalizationTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            ...baseReceipt,
            logs: [finalizedEventLog({ requestId: 8n })],
          };
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: TX2_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessFinalizationTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return baseReceipt;
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
        async readContract() {
          return pendingRequest();
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: TX2_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("permissionless expiry is unavailable before and available at the exact first block", async () => {
  let currentBlock = 8_299n;
  const writeCalls = [];
  let callbackObserved = false;
  const publicClient = {
    async getBytecode() {
      return OFFICIAL_RUNTIME_BYTECODE;
    },
    async getBlockNumber() {
      return currentBlock;
    },
    async readContract({ functionName, blockTag }) {
      assert.equal(functionName, "getRequest");
      if (blockTag === "latest") return pendingRequest();
      assert.equal(blockTag, "finalized");
      return pendingRequest({ expired: true });
    },
    async estimateContractGas(args) {
      assert.equal(args.account, FINALIZER);
      assert.equal(args.address, CONTRACT);
      assert.equal(args.functionName, "expireRequest");
      assert.deepEqual(args.args, [7n]);
      assert.equal(args.value, 0n);
      return 100_000n;
    },
    async waitForTransactionReceipt(args) {
      assert.equal(callbackObserved, true);
      assertReplacementWaitArgs(args, EXPIRE_HASH);
      return {
        status: "success",
        transactionHash: EXPIRE_HASH,
        to: CONTRACT,
        logs: [expiredEventLog()],
      };
    },
  };
  const walletClient = {
    async writeContract(args) {
      writeCalls.push(args);
      return EXPIRE_HASH;
    },
  };

  await assert.rejects(
    expireRandomnessRequest({
      publicClient,
      walletClient,
      account: FINALIZER,
      contractAddress: CONTRACT,
      requestId: 7n,
      fetchImpl: artifactFetch(),
    }),
    { code: "EXPIRY_NOT_READY" },
  );

  currentBlock = 8_300n;
  const expired = await expireRandomnessRequest({
    publicClient,
    walletClient,
    account: FINALIZER,
    contractAddress: CONTRACT,
    requestId: 7n,
    fetchImpl: artifactFetch(),
    onTransactionHash(transactionHash) {
      callbackObserved = true;
      assert.equal(transactionHash, EXPIRE_HASH);
    },
  });
  assert.equal(expired.transactionHash, EXPIRE_HASH);
  assert.equal(expired.request.expired, true);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].functionName, "expireRequest");
  assert.deepEqual(writeCalls[0].args, [7n]);
  assert.equal(writeCalls[0].account, FINALIZER);
  assert.equal(writeCalls[0].value, 0n);
  assert.equal(writeCalls[0].gas, 120_000n);
});

test("expiry recovery verifies the exact event and expired state without another wallet write", async () => {
  let walletWrites = 0;
  const recovered = await recoverRandomnessExpiryTx({
    publicClient: {
      async waitForTransactionReceipt(args) {
        assertReplacementWaitArgs(args, EXPIRE_HASH);
        return {
          status: "success",
          transactionHash: EXPIRE_HASH,
          to: CONTRACT,
          logs: [expiredEventLog()],
        };
      },
      async getBytecode() {
        return OFFICIAL_RUNTIME_BYTECODE;
      },
      async readContract({ functionName, args, blockTag }) {
        assert.equal(functionName, "getRequest");
        assert.deepEqual(args, [7n]);
        assert.equal(blockTag, "finalized");
        return pendingRequest({ expired: true });
      },
    },
    contractAddress: CONTRACT,
    requestId: 7n,
    transactionHash: EXPIRE_HASH,
    artifact,
    walletClient: {
      async writeContract() {
        walletWrites += 1;
        return EXPIRE_HASH;
      },
    },
  });

  assert.equal(walletWrites, 0);
  assert.equal(recovered.transactionHash, EXPIRE_HASH);
  assert.equal(recovered.request.expired, true);
});

test("expiry recovery rejects wrong destination, request event, or non-expired state", async () => {
  const baseReceipt = {
    status: "success",
    transactionHash: EXPIRE_HASH,
    to: CONTRACT,
    logs: [expiredEventLog()],
  };

  await assert.rejects(
    recoverRandomnessExpiryTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return { ...baseReceipt, to: OWNER };
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: EXPIRE_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessExpiryTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return {
            ...baseReceipt,
            logs: [expiredEventLog({ requestId: 8n })],
          };
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: EXPIRE_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );

  await assert.rejects(
    recoverRandomnessExpiryTx({
      publicClient: {
        async waitForTransactionReceipt() {
          return baseReceipt;
        },
        async getBytecode() {
          return OFFICIAL_RUNTIME_BYTECODE;
        },
        async readContract() {
          return pendingRequest();
        },
      },
      contractAddress: CONTRACT,
      requestId: 7n,
      transactionHash: EXPIRE_HASH,
      artifact,
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("expiry precheck maps finalized and expired requests to duplicate state", async () => {
  let walletCalls = 0;
  for (const request of [
    pendingRequest({ finalized: true, finalizer: FINALIZER, result: RESULT }),
    pendingRequest({ expired: true }),
  ]) {
    await assert.rejects(
      expireRandomnessRequest({
        publicClient: {
          async getBytecode() {
            return OFFICIAL_RUNTIME_BYTECODE;
          },
          async getBlockNumber() {
            return 8_300n;
          },
          async readContract() {
            return request;
          },
        },
        walletClient: {
          async writeContract() {
            walletCalls += 1;
            return EXPIRE_HASH;
          },
        },
        account: FINALIZER,
        contractAddress: CONTRACT,
        requestId: 7n,
        fetchImpl: artifactFetch(),
      }),
      { code: "DUPLICATE_STATE" },
    );
  }
  assert.equal(walletCalls, 0);
});

test("read-only result lookup needs no wallet and formats request and draw", async () => {
  const reads = [];
  const publicClient = {
    async getBytecode() {
      return OFFICIAL_RUNTIME_BYTECODE;
    },
    async readContract(args) {
      reads.push(args);
      assert.equal(args.blockTag, "finalized");
      if (args.functionName === "getRequest") {
        return pendingRequest({ finalized: true, result: RESULT, finalizer: FINALIZER });
      }
      if (args.functionName === "draw") return 0n;
      throw new Error("unexpected read");
    },
  };

  const result = await readRandomnessResult({
    publicClient,
    contractAddress: CONTRACT,
    requestId: 1n,
    fetchImpl: artifactFetch(),
  });
  assert.equal(reads.length, 2);
  assert.equal(result.request.requestBlock, 100n);
  assert.equal(result.drawZeroBased, 0n);
  assert.equal(result.drawOneBased, 1);
});

test("stable client errors map wallet, MON, RPC, proof, and duplicate failures", () => {
  const rejected = Object.assign(new Error("User rejected"), { code: 4001 });
  assert.deepEqual(mapClientError(rejected), {
    code: "WALLET_REJECTED",
    message: "지갑에서 요청이 취소됐어요.",
  });
  assert.equal(mapClientError(new Error("insufficient funds for gas")).code, "MISSING_MON");
  assert.equal(
    mapClientError(Object.assign(new Error("method not found"), { code: -32601 })).code,
    "UNKNOWN",
  );
  assert.equal(
    mapClientError(viemExecutionError("RequestProofExpired", [8_300n, 8_299n])).code,
    "PROOF_EXPIRED",
  );
  for (const errorName of ["AlreadyFinalized", "AlreadyExpired", "RequestExpired"]) {
    assert.equal(mapClientError(viemExecutionError(errorName)).code, "DUPLICATE_STATE");
  }
  const chainMismatch = new ChainMismatchError({ chain: monadTestnet, currentChainId: 1 });
  assert.equal(mapClientError(chainMismatch).code, "WRONG_NETWORK");
  assert.equal(
    mapClientError(new Error("outer wallet failure", { cause: chainMismatch })).code,
    "WRONG_NETWORK",
  );
  assert.ok(new RandomnessClientError("NO_WALLET", "지갑 없음") instanceof Error);
});

test("device storage migrates legacy fields in memory and persists only the safe schema on mutation", () => {
  const legacy = {
    version: 1,
    chainId: 10_143,
    demoContract: CONTRACT,
    privateKey: "never-store-me",
    mnemonic: "never-store-me",
    signature: "never-store-me",
    extra: "never-store-me",
    recentRequests: [
      {
        chainId: 10_143,
        contractAddress: CONTRACT,
        requestId: "7",
        tx1Hash: TX1_HASH,
        expiryHash: EXPIRE_HASH,
        signedTransaction: "never-store-me",
      },
    ],
  };
  const legacySerialized = JSON.stringify(legacy);
  const storage = memoryStorage({ [LOCAL_STATE_KEY]: legacySerialized });
  const migrated = loadStoredState(storage);

  assert.deepEqual(migrated, {
    version: 2,
    demoContracts: [{ chainId: 10_143, contractAddress: CONTRACT }],
    recentRequests: [
      {
        chainId: 10_143,
        contractAddress: CONTRACT,
        requestId: "7",
        tx1Hash: TX1_HASH,
        expiryHash: EXPIRE_HASH,
      },
    ],
    pendingTransactions: [],
  });
  assert.doesNotMatch(JSON.stringify(migrated), /privateKey|signature|signedTransaction|never-store-me/);
  assert.equal(storage.dump(LOCAL_STATE_KEY), legacySerialized);

  rememberDemoContract(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    deploymentTxHash: DEPLOY_HASH,
    privateKey: "ignored",
  });
  rememberRequest(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 8n,
    tx1Hash: TX1_HASH,
    tx2Hash: TX2_HASH,
    expiryHash: EXPIRE_HASH,
    signature: "ignored",
  });

  const serialized = storage.dump(LOCAL_STATE_KEY);
  assert.doesNotMatch(serialized, /privateKey|signature|ignored/);
  const stored = JSON.parse(serialized);
  assert.deepEqual(Object.keys(stored).sort(), [
    "demoContracts",
    "pendingTransactions",
    "recentRequests",
    "version",
  ]);
  assert.equal(stored.demoContracts[0].deploymentTxHash, DEPLOY_HASH);
  assert.equal(stored.recentRequests[0].requestId, "8");
  assert.equal(stored.recentRequests[0].tx2Hash, TX2_HASH);
  assert.equal(stored.recentRequests[0].expiryHash, EXPIRE_HASH);
});

test("request storage merges partial transaction hashes without erasing prior safe fields", () => {
  const storage = memoryStorage();
  rememberRequest(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 9n,
    tx1Hash: TX1_HASH,
  });
  rememberRequest(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 9n,
    tx2Hash: TX2_HASH,
  });
  rememberRequest(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 9n,
    expiryHash: EXPIRE_HASH,
  });

  assert.deepEqual(loadStoredState(storage).recentRequests[0], {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: "9",
    tx1Hash: TX1_HASH,
    tx2Hash: TX2_HASH,
    expiryHash: EXPIRE_HASH,
  });
});

test("pending transaction storage is sanitized, deduplicated, reloadable, and forgettable", () => {
  const storage = memoryStorage();
  rememberPendingTransaction(storage, {
    kind: "deployment",
    chainId: 10_143,
    transactionHash: DEPLOY_HASH,
    createdAt: 100,
    privateKey: "never-store-me",
  });
  rememberPendingTransaction(storage, {
    kind: "deployment",
    chainId: 10_143,
    transactionHash: DEPLOY_HASH.toUpperCase().replace("0X", "0x"),
    createdAt: 200,
    mnemonic: "never-store-me",
  });
  rememberPendingTransaction(storage, {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT.toLowerCase(),
    requester: REQUESTER.toLowerCase(),
    transactionHash: TX1_HASH,
    createdAt: 300,
    signedTransaction: "never-store-me",
  });
  rememberPendingTransaction(storage, {
    kind: "finalization",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 7n,
    transactionHash: TX2_HASH,
    createdAt: 400,
    privateKey: "never-store-me",
  });
  rememberPendingTransaction(storage, {
    kind: "finalization",
    chainId: 10_143,
    contractAddress: CONTRACT.toLowerCase(),
    requestId: "7",
    transactionHash: TX2_HASH,
    createdAt: 450,
    mnemonic: "never-store-me",
  });
  rememberPendingTransaction(storage, {
    kind: "expiry",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 7n,
    transactionHash: EXPIRE_HASH,
    createdAt: 500,
    signedTransaction: "never-store-me",
  });

  const serialized = storage.dump(LOCAL_STATE_KEY);
  assert.doesNotMatch(
    serialized,
    /privateKey|mnemonic|signedTransaction|never-store-me/,
  );
  const reloadedStorage = memoryStorage({ [LOCAL_STATE_KEY]: serialized });
  assert.deepEqual(readPendingTransactions(reloadedStorage), [
    {
      kind: "expiry",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requestId: "7",
      transactionHash: EXPIRE_HASH,
      createdAt: 500,
    },
    {
      kind: "finalization",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requestId: "7",
      transactionHash: TX2_HASH,
      createdAt: 450,
    },
    {
      kind: "request",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requester: REQUESTER,
      transactionHash: TX1_HASH,
      createdAt: 300,
    },
    {
      kind: "deployment",
      chainId: 10_143,
      transactionHash: DEPLOY_HASH,
      createdAt: 200,
    },
  ]);

  forgetPendingTransaction(reloadedStorage, TX1_HASH);
  assert.deepEqual(readPendingTransactions(reloadedStorage), [
    {
      kind: "expiry",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requestId: "7",
      transactionHash: EXPIRE_HASH,
      createdAt: 500,
    },
    {
      kind: "finalization",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requestId: "7",
      transactionHash: TX2_HASH,
      createdAt: 450,
    },
    {
      kind: "deployment",
      chainId: 10_143,
      transactionHash: DEPLOY_HASH,
      createdAt: 200,
    },
  ]);
});

test("remembering a replacement hash removes the prior hash for that exact pending action", () => {
  const storage = memoryStorage();
  rememberPendingTransaction(storage, {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requester: REQUESTER,
    transactionHash: TX1_HASH,
    createdAt: 100,
  });
  rememberPendingTransaction(storage, {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requester: REQUESTER,
    transactionHash: REPRICED_TX1_HASH,
    createdAt: 200,
  });

  assert.deepEqual(readPendingTransactions(storage), [
    {
      kind: "request",
      chainId: 10_143,
      contractAddress: CONTRACT,
      requester: REQUESTER,
      transactionHash: REPRICED_TX1_HASH,
      createdAt: 200,
    },
  ]);
});

test("unavailable or busy Web Lock never invokes the write callback", async () => {
  assert.equal(typeof storageClient.runWithPendingWriteLock, "function");
  const storage = memoryStorage();
  const action = {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requester: REQUESTER,
  };
  let writes = 0;
  const write = async () => {
    writes += 1;
    return TX1_HASH;
  };

  assert.deepEqual(
    await storageClient.runWithPendingWriteLock({
      lockManager: undefined,
      storage,
      action,
      write,
    }),
    { status: "unavailable" },
  );
  const busy = await storageClient.runWithPendingWriteLock({
    lockManager: {
      async request(name, options, callback) {
        assert.match(name, /^monad-rnd:write:v1:/);
        assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
        return callback(null);
      },
    },
    storage,
    action,
    write,
  });
  assert.deepEqual(busy, { status: "busy" });
  assert.equal(writes, 0);
});

test("a pending action discovered while holding its Web Lock blocks the write callback", async () => {
  assert.equal(typeof storageClient.runWithPendingWriteLock, "function");
  const storage = memoryStorage();
  const action = {
    kind: "request",
    chainId: 10_143,
    contractAddress: CONTRACT,
    requester: REQUESTER,
  };
  let writes = 0;

  const result = await storageClient.runWithPendingWriteLock({
    lockManager: {
      async request(name, options, callback) {
        rememberPendingTransaction(storage, {
          ...action,
          transactionHash: TX1_HASH,
          createdAt: 300,
        });
        return callback({ name, mode: options.mode });
      },
    },
    storage,
    action,
    async write() {
      writes += 1;
      return REPRICED_TX1_HASH;
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.pending.transactionHash, TX1_HASH);
  assert.equal(writes, 0);
});

test("different action mutations share one serialized storage lock and preserve both pending records", async () => {
  assert.equal(typeof storageClient.runWithStoredStateMutationLock, "function");
  const storage = memoryStorage();
  const requests = [];
  let active = 0;
  let maxActive = 0;
  let tail = Promise.resolve();
  const lockManager = {
    request(name, options, callback) {
      requests.push({ name, options });
      const result = tail.then(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await callback({ name, mode: options.mode });
        } finally {
          active -= 1;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };

  await Promise.all([
    storageClient.runWithStoredStateMutationLock({
      lockManager,
      mutate: () =>
        rememberPendingTransaction(storage, {
          kind: "request",
          chainId: 10_143,
          contractAddress: CONTRACT,
          requester: REQUESTER,
          transactionHash: TX1_HASH,
          createdAt: 100,
        }),
    }),
    storageClient.runWithStoredStateMutationLock({
      lockManager,
      mutate: () =>
        rememberPendingTransaction(storage, {
          kind: "expiry",
          chainId: 10_143,
          contractAddress: CONTRACT,
          requestId: 7n,
          transactionHash: EXPIRE_HASH,
          createdAt: 200,
        }),
    }),
  ]);

  assert.equal(maxActive, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].name, requests[1].name);
  assert.match(requests[0].name, /^monad-rnd:state-mutation:v1$/);
  assert.deepEqual(requests.map(({ options }) => options), [
    { mode: "exclusive" },
    { mode: "exclusive" },
  ]);
  assert.deepEqual(
    readPendingTransactions(storage).map(({ kind, transactionHash }) => ({
      kind,
      transactionHash,
    })),
    [
      { kind: "expiry", transactionHash: EXPIRE_HASH },
      { kind: "request", transactionHash: TX1_HASH },
    ],
  );

  let fallbackMutations = 0;
  const fallback = await storageClient.runWithStoredStateMutationLock({
    lockManager: undefined,
    mutate: () => {
      fallbackMutations += 1;
      return "manual recovery remains available";
    },
  });
  assert.equal(fallback, "manual recovery remains available");
  assert.equal(fallbackMutations, 1);
});

test("stored-state subscription applies matching storage events and removes its listener", () => {
  assert.equal(typeof storageClient.subscribeToStoredState, "function");
  const storage = memoryStorage();
  const listeners = new Set();
  const target = {
    addEventListener(type, listener) {
      assert.equal(type, "storage");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "storage");
      listeners.delete(listener);
    },
    dispatch(event) {
      for (const listener of listeners) listener(event);
    },
  };
  const observed = [];
  const unsubscribe = storageClient.subscribeToStoredState(
    target,
    storage,
    (state) => observed.push(state),
  );

  assert.equal(listeners.size, 1);
  rememberPendingTransaction(storage, {
    kind: "deployment",
    chainId: 10_143,
    transactionHash: DEPLOY_HASH,
    createdAt: 400,
  });
  target.dispatch({ key: "another-key" });
  assert.equal(observed.length, 0);
  target.dispatch({ key: LOCAL_STATE_KEY });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].pendingTransactions[0].transactionHash, DEPLOY_HASH);

  unsubscribe();
  assert.equal(listeners.size, 0);
  target.dispatch({ key: LOCAL_STATE_KEY });
  assert.equal(observed.length, 1);
});

test("pending transaction storage is bounded in memory and canonicalizes on mutation", () => {
  const pendingTransactions = Array.from(
    { length: MAX_PENDING_TRANSACTIONS + 5 },
    (_, index) => ({
      kind: "deployment",
      chainId: 10_143,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      createdAt: index,
      secret: "drop-me",
    }),
  );
  pendingTransactions.splice(2, 0, {
    kind: "deployment",
    chainId: -1,
    transactionHash: "not-a-hash",
    createdAt: -1,
    secret: "drop-me",
  });
  const storage = memoryStorage({
    [LOCAL_STATE_KEY]: JSON.stringify({
      version: 2,
      demoContracts: [],
      recentRequests: [],
      pendingTransactions: pendingTransactions.reverse(),
      privateKey: "drop-me",
    }),
  });

  const loaded = loadStoredState(storage);
  assert.equal(loaded.pendingTransactions.length, MAX_PENDING_TRANSACTIONS);
  assert.equal(loaded.pendingTransactions[0].createdAt, MAX_PENDING_TRANSACTIONS + 4);
  assert.equal(loaded.pendingTransactions.at(-1).createdAt, 5);
  assert.match(storage.dump(LOCAL_STATE_KEY), /secret|privateKey|drop-me|not-a-hash/);

  rememberRequest(storage, {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: 99n,
    tx1Hash: TX1_HASH,
  });
  assert.doesNotMatch(storage.dump(LOCAL_STATE_KEY), /secret|privateKey|drop-me|not-a-hash/);
});

test("loadStoredState is read-only even while sanitizing legacy or malformed data", () => {
  const serialized = JSON.stringify({
    chainId: 10_143,
    demoContract: CONTRACT,
    privateKey: "must-not-escape",
  });
  let writes = 0;
  const loaded = loadStoredState({
    getItem() {
      return serialized;
    },
    setItem() {
      writes += 1;
    },
  });

  assert.deepEqual(loaded, {
    version: 2,
    demoContracts: [{ chainId: 10_143, contractAddress: CONTRACT }],
    recentRequests: [],
    pendingTransactions: [],
  });
  assert.equal(writes, 0);
});

test("device storage read failures and malformed data remain nonfatal without rewriting", () => {
  const malformedStorage = memoryStorage({ [LOCAL_STATE_KEY]: "{not-json" });
  assert.deepEqual(loadStoredState(malformedStorage), {
    version: 2,
    demoContracts: [],
    recentRequests: [],
    pendingTransactions: [],
  });
  assert.equal(malformedStorage.dump(LOCAL_STATE_KEY), "{not-json");

  assert.deepEqual(
    loadStoredState({
      getItem() {
        throw new Error("read denied");
      },
      setItem() {
        throw new Error("write denied");
      },
    }),
    {
      version: 2,
      demoContracts: [],
      recentRequests: [],
      pendingTransactions: [],
    },
  );

  const serialized = JSON.stringify({
    chainId: 10_143,
    demoContract: CONTRACT,
    privateKey: "must-not-escape",
  });
  assert.deepEqual(
    loadStoredState({
      getItem() {
        return serialized;
      },
      setItem() {
        throw new Error("write denied");
      },
    }),
    {
      version: 2,
      demoContracts: [{ chainId: 10_143, contractAddress: CONTRACT }],
      recentRequests: [],
      pendingTransactions: [],
    },
  );

  assert.doesNotThrow(() =>
    rememberRequest(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("write denied");
        },
      },
      {
        chainId: 10_143,
        contractAddress: CONTRACT,
        requestId: 1n,
        tx1Hash: TX1_HASH,
      },
    ),
  );
});
