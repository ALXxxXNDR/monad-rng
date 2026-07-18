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
  calculateReadiness,
  deployDemoPlatform,
  expireRandomnessRequest,
  fetchRawHeaders,
  finalizeRandomnessTx,
  loadPlatformArtifact,
  readRandomnessResult,
  requestRandomnessTx,
  toOneBasedDraw,
} from "../app/lib/randomness.ts";
import {
  LOCAL_STATE_KEY,
  loadStoredState,
  rememberDemoContract,
  rememberRequest,
} from "../app/lib/storage.ts";
import {
  ChainMismatchError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeDeployData,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
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
const RESULT = `0x${"ab".repeat(32)}`;

const artifact = JSON.parse(
  await readFile(new URL("../public/contracts/PlatformRandomness.json", import.meta.url), "utf8"),
);

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
      assert.deepEqual(args, { hash: DEPLOY_HASH, confirmations: 3 });
      return { status: "success", contractAddress: CONTRACT };
    },
    async getBytecode({ address }) {
      sequence.push("code");
      assert.equal(address, CONTRACT);
      return "0x6000";
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
  assert.deepEqual(sequence, ["estimate", "wallet", "wait", "code"]);
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
      return "0x6000";
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
      assert.deepEqual(args, { hash: TX1_HASH, confirmations: 3 });
      return {
        status: "success",
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
  });

  assert.equal(writeCalls[0].functionName, "requestRandomness");
  assert.equal(writeCalls[0].account, REQUESTER);
  assert.equal(writeCalls[0].value, 9n);
  assert.equal(writeCalls[0].gas, 120_000n);
  assert.deepEqual(sequence, ["code", "price", "estimate", "wallet", "wait"]);
  assert.equal(requested.requestId, 7n);
  assert.equal(requested.requester, REQUESTER);
  assert.deepEqual(requested.targetBlocks, [108n, 124n, 140n]);
  assert.equal(requested.transactionHash, TX1_HASH);
});

test("Tx1 cap rejection never invokes the wallet", async () => {
  let walletCalls = 0;
  await assert.rejects(
    requestRandomnessTx({
      publicClient: {
        async getBytecode() {
          return "0x6000";
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
    finalizer: FINALIZER,
    result: RESULT,
    finalized: true,
  });
  const publicClient = {
    async getBytecode() {
      sequence.push("code");
      return "0x6000";
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
      assert.deepEqual(args, { hash: TX2_HASH, confirmations: 3 });
      return { status: "success", logs: [] };
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

test("permissionless expiry is unavailable before and available at the exact first block", async () => {
  let currentBlock = 8_299n;
  const writeCalls = [];
  const publicClient = {
    async getBytecode() {
      return "0x6000";
    },
    async getBlockNumber() {
      return currentBlock;
    },
    async readContract({ blockTag }) {
      assert.equal(blockTag, "latest");
      return pendingRequest();
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
      assert.deepEqual(args, { hash: EXPIRE_HASH, confirmations: 3 });
      return { status: "success" };
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
  });
  assert.equal(expired.transactionHash, EXPIRE_HASH);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].functionName, "expireRequest");
  assert.deepEqual(writeCalls[0].args, [7n]);
  assert.equal(writeCalls[0].account, FINALIZER);
  assert.equal(writeCalls[0].value, 0n);
  assert.equal(writeCalls[0].gas, 120_000n);
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
            return "0x6000";
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
      return "0x6000";
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

test("device storage migrates legacy fields and persists only the safe schema", () => {
  const legacy = {
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
        signedTransaction: "never-store-me",
      },
    ],
  };
  const storage = memoryStorage({ [LOCAL_STATE_KEY]: JSON.stringify(legacy) });
  const migrated = loadStoredState(storage);

  assert.deepEqual(migrated, {
    version: 1,
    demoContracts: [{ chainId: 10_143, contractAddress: CONTRACT }],
    recentRequests: [
      {
        chainId: 10_143,
        contractAddress: CONTRACT,
        requestId: "7",
        tx1Hash: TX1_HASH,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(migrated), /privateKey|signature|signedTransaction|never-store-me/);
  assert.deepEqual(JSON.parse(storage.dump(LOCAL_STATE_KEY)), migrated);
  assert.doesNotMatch(
    storage.dump(LOCAL_STATE_KEY),
    /privateKey|mnemonic|signature|signedTransaction|extra|never-store-me/,
  );

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
    signature: "ignored",
  });

  const serialized = storage.dump(LOCAL_STATE_KEY);
  assert.doesNotMatch(serialized, /privateKey|signature|ignored/);
  const stored = JSON.parse(serialized);
  assert.deepEqual(Object.keys(stored).sort(), ["demoContracts", "recentRequests", "version"]);
  assert.equal(stored.demoContracts[0].deploymentTxHash, DEPLOY_HASH);
  assert.equal(stored.recentRequests[0].requestId, "8");
  assert.equal(stored.recentRequests[0].tx2Hash, TX2_HASH);
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

  assert.deepEqual(loadStoredState(storage).recentRequests[0], {
    chainId: 10_143,
    contractAddress: CONTRACT,
    requestId: "9",
    tx1Hash: TX1_HASH,
    tx2Hash: TX2_HASH,
  });
});

test("device storage read and canonical rewrite failures remain nonfatal", () => {
  const malformedStorage = memoryStorage({ [LOCAL_STATE_KEY]: "{not-json" });
  assert.deepEqual(loadStoredState(malformedStorage), {
    version: 1,
    demoContracts: [],
    recentRequests: [],
  });
  assert.equal(
    malformedStorage.dump(LOCAL_STATE_KEY),
    JSON.stringify({ version: 1, demoContracts: [], recentRequests: [] }),
  );

  assert.deepEqual(
    loadStoredState({
      getItem() {
        throw new Error("read denied");
      },
      setItem() {
        throw new Error("write denied");
      },
    }),
    { version: 1, demoContracts: [], recentRequests: [] },
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
      version: 1,
      demoContracts: [{ chainId: 10_143, contractAddress: CONTRACT }],
      recentRequests: [],
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
