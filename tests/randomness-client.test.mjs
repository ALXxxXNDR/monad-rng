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
  encodeAbiParameters,
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
  const provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === "eth_requestAccounts") return [OWNER];
      if (payload.method === "eth_chainId") return "0x1";
      if (payload.method === "wallet_switchEthereumChain") return null;
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
  ]);
});

test("unknown Monad chain is added with exact public network metadata", async () => {
  const requests = [];
  const provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === "eth_chainId") return "0x1";
      if (payload.method === "wallet_switchEthereumChain") {
        const error = new Error("unknown chain");
        error.code = 4902;
        throw error;
      }
      if (payload.method === "wallet_addEthereumChain") return null;
      throw new Error(`Unexpected method ${payload.method}`);
    },
  };

  await ensureMonadTestnet(provider);
  assert.deepEqual(requests.at(-1), {
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
  const walletClient = {
    async deployContract(args) {
      deployCalls.push(args);
      return DEPLOY_HASH;
    },
  };
  const publicClient = {
    async waitForTransactionReceipt({ hash }) {
      assert.equal(hash, DEPLOY_HASH);
      return { status: "success", contractAddress: CONTRACT };
    },
    async getBytecode({ address }) {
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

test("Tx1 reads the exact live platform price and decodes RandomnessRequested", async () => {
  const writeCalls = [];
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
      return "0x6000";
    },
    async readContract({ functionName }) {
      assert.equal(functionName, "requestPrice");
      return 9n;
    },
    async waitForTransactionReceipt({ hash }) {
      assert.equal(hash, TX1_HASH);
      return {
        status: "success",
        logs: [{ address: CONTRACT, topics: eventTopics, data: eventData }],
      };
    },
  };
  const walletClient = {
    async writeContract(args) {
      writeCalls.push(args);
      return TX1_HASH;
    },
  };

  const requested = await requestRandomnessTx({
    publicClient,
    walletClient,
    contractAddress: CONTRACT,
    fetchImpl: artifactFetch(),
  });

  assert.equal(writeCalls[0].functionName, "requestRandomness");
  assert.equal(writeCalls[0].value, 9n);
  assert.equal(requested.requestId, 7n);
  assert.equal(requested.requester, REQUESTER);
  assert.deepEqual(requested.targetBlocks, [108n, 124n, 140n]);
  assert.equal(requested.transactionHash, TX1_HASH);
});

test("raw-header retrieval sends exactly three debug_getRawHeader RPC calls", async () => {
  const calls = [];
  const headers = await fetchRawHeaders([108n, 124n, 140n], async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: body.id, result: `0xf9${body.id}` };
      },
    };
  });

  assert.deepEqual(headers, ["0xf91", "0xf92", "0xf93"]);
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
  const finalizedRequest = pendingRequest({
    finalizer: FINALIZER,
    result: RESULT,
    finalized: true,
  });
  const publicClient = {
    async getBytecode() {
      return "0x6000";
    },
    async waitForTransactionReceipt({ hash }) {
      assert.equal(hash, TX2_HASH);
      return { status: "success", logs: [] };
    },
    async readContract({ functionName, args }) {
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
      writeCalls.push(args);
      return TX2_HASH;
    },
  };

  const finalized = await finalizeRandomnessTx({
    publicClient,
    walletClient,
    contractAddress: CONTRACT,
    requestId: 7n,
    headers: ["0xf91", "0xf92", "0xf93"],
    fetchImpl: artifactFetch(),
  });

  assert.equal(writeCalls[0].functionName, "finalizeRandomness");
  assert.deepEqual(writeCalls[0].args, [7n, "0xf91", "0xf92", "0xf93"]);
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
    async readContract() {
      return pendingRequest();
    },
    async waitForTransactionReceipt({ hash }) {
      assert.equal(hash, EXPIRE_HASH);
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
    contractAddress: CONTRACT,
    requestId: 7n,
    fetchImpl: artifactFetch(),
  });
  assert.equal(expired.transactionHash, EXPIRE_HASH);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].functionName, "expireRequest");
  assert.deepEqual(writeCalls[0].args, [7n]);
});

test("read-only result lookup needs no wallet and formats request and draw", async () => {
  const reads = [];
  const publicClient = {
    async getBytecode() {
      return "0x6000";
    },
    async readContract(args) {
      reads.push(args);
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
  assert.equal(mapClientError(Object.assign(new Error("method not found"), { code: -32601 })).code, "RAW_HEADER_UNAVAILABLE");
  assert.equal(mapClientError({ errorName: "RequestProofExpired" }).code, "PROOF_EXPIRED");
  assert.equal(mapClientError({ errorName: "AlreadyFinalized" }).code, "DUPLICATE_STATE");
  assert.ok(new RandomnessClientError("NO_WALLET", "지갑 없음") instanceof Error);
});

test("device storage migrates legacy fields and persists only the safe schema", () => {
  const legacy = {
    chainId: 10_143,
    demoContract: CONTRACT,
    privateKey: "never-store-me",
    signature: "never-store-me",
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
