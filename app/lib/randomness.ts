import {
  encodeDeployData,
  getAddress,
  isHex,
  keccak256,
  numberToHex,
  parseEventLogs,
} from "viem";
import type { Abi, Address, Hash, Hex, Log } from "viem";

import {
  MONAD_RPC_URL,
  RandomnessClientError,
  asRandomnessClientError,
  requireContractAddress,
} from "#monad-network";
import type {
  MonadPublicClient,
  MonadWalletClient,
  RandomnessErrorCode,
} from "#monad-network";

export const PLATFORM_ARTIFACT_URL = "/contracts/PlatformRandomness.json";
export const DEFAULT_DEMO_MAX_PENDING = BigInt(128);
export const DEMO_MAX_PENDING_LIMIT = BigInt(256);
export const TRANSACTION_CONFIRMATIONS = 3;

export interface PlatformArtifact {
  schemaVersion: 2;
  abi: Abi;
  bytecode: Hex;
  runtimeBytecode: Hex;
  runtimeBytecodeHash: Hash;
  contractName: "PlatformRandomness";
}

export interface RandomnessRequest {
  requester: Address;
  requestBlock: bigint;
  firstTargetBlock: bigint;
  secondTargetBlock: bigint;
  thirdTargetBlock: bigint;
  pricePaid: bigint;
  finalizer: Address;
  result: Hex;
  finalized: boolean;
  expired: boolean;
}

export type ReadinessPhase =
  | "waiting"
  | "requester"
  | "permissionless"
  | "proof-expired"
  | "finalized"
  | "expired";

export interface RequestReadiness {
  phase: ReadinessPhase;
  canFinalize: boolean;
  canExpire: boolean;
  blocksRemaining: bigint;
  requesterFinalizationBlock: bigint;
  permissionlessRescueBlock: bigint;
  lastProofValidBlock: bigint;
  firstExpiryBlock: bigint;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}>;

export type TransactionHashCallback = (
  transactionHash: Hash,
) => void | Promise<void>;

export interface DemoDeploymentResult {
  contractAddress: Address;
  transactionHash: Hash;
}

export interface RandomnessRequestTransactionResult {
  transactionHash: Hash;
  requestId: bigint;
  requester: Address;
  requestBlock: bigint;
  targetBlocks: [bigint, bigint, bigint];
  pricePaid: bigint;
}

export interface RandomnessFinalizationTransactionResult {
  transactionHash: Hash;
  request: RandomnessRequest;
  drawZeroBased: bigint;
  drawOneBased: number;
}

export interface RandomnessExpiryTransactionResult {
  transactionHash: Hash;
  request: RandomnessRequest;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_RESULT = `0x${"00".repeat(32)}` as Hex;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const DRAW_UPPER_BOUND = BigInt(100);
const GAS_MARGIN_NUMERATOR = BigInt(120);
const GAS_MARGIN_DENOMINATOR = BigInt(100);
const DEPLOY_GAS_CAP = BigInt(6_000_000);
const TX1_GAS_CAP = BigInt(300_000);
const TX2_GAS_CAP = BigInt(1_000_000);
const EXPIRY_GAS_CAP = BigInt(150_000);
const MAX_RAW_HEADER_BYTES = 4_096;

function fail(
  code: RandomnessErrorCode,
  message: string,
  cause?: unknown,
): RandomnessClientError {
  return new RandomnessClientError(code, message, cause === undefined ? undefined : { cause });
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw fail("INVALID_ARTIFACT", "배포용 컨트랙트 파일을 불러오지 못했어요.");
  }
  return globalThis.fetch.bind(globalThis);
}

function isBytecode(value: unknown): value is Hex {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
    isHex(value)
  );
}

function isArtifact(value: unknown): value is PlatformArtifact {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 2 ||
    candidate.contractName !== "PlatformRandomness" ||
    !Array.isArray(candidate.abi) ||
    !isBytecode(candidate.bytecode) ||
    !isBytecode(candidate.runtimeBytecode) ||
    typeof candidate.runtimeBytecodeHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(candidate.runtimeBytecodeHash)
  ) {
    return false;
  }

  return (
    keccak256(candidate.runtimeBytecode).toLowerCase() ===
    candidate.runtimeBytecodeHash.toLowerCase()
  );
}

export async function loadPlatformArtifact(
  fetchImpl: FetchLike = defaultFetch(),
): Promise<PlatformArtifact> {
  try {
    const response = await fetchImpl(PLATFORM_ARTIFACT_URL, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Artifact HTTP ${response.status ?? "error"}`);
    }
    const value = await response.json();
    if (!isArtifact(value)) {
      throw new Error("Artifact ABI or bytecode is missing");
    }
    return value;
  } catch (error) {
    throw fail("INVALID_ARTIFACT", "배포용 컨트랙트 파일을 불러오지 못했어요.", error);
  }
}

async function resolvedArtifact(
  artifact: PlatformArtifact | undefined,
  fetchImpl: FetchLike | undefined,
): Promise<PlatformArtifact> {
  if (artifact) {
    if (!isArtifact(artifact)) {
      throw fail("INVALID_ARTIFACT", "배포용 컨트랙트 파일을 불러오지 못했어요.");
    }
    return artifact;
  }
  return loadPlatformArtifact(fetchImpl);
}

function requireSuccessfulReceipt(receipt: { status?: string }): void {
  if (receipt.status !== "success") {
    throw fail("TRANSACTION_REVERTED", "거래가 체인에서 실패했어요.");
  }
}

function requireTransactionHash(value: unknown): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw fail("INVALID_TRANSACTION_HASH", "올바른 거래 해시가 아니에요.");
  }
  return value as Hash;
}

function requireMatchingReceiptHash(
  receipt: { transactionHash?: unknown },
  transactionHash: Hash,
): void {
  if (
    typeof receipt.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
    receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
  ) {
    throw fail("INVALID_TRANSACTION_HASH", "요청한 거래와 다른 영수증을 받았어요.");
  }
}

function requireReceiptDestination(
  receipt: { to?: unknown },
  contractAddress: Address,
): void {
  try {
    if (
      typeof receipt.to !== "string" ||
      getAddress(receipt.to) !== contractAddress
    ) {
      throw new Error("Receipt destination mismatch");
    }
  } catch (error) {
    throw fail("INVALID_REQUEST", "거래 영수증의 컨트랙트 주소가 일치하지 않아요.", error);
  }
}

function requireDeploymentReceipt(receipt: {
  to?: unknown;
  contractAddress?: unknown;
}): string {
  if (receipt.to !== null || typeof receipt.contractAddress !== "string") {
    throw fail("INVALID_REQUEST", "올바른 컨트랙트 배포 영수증이 아니에요.");
  }
  return receipt.contractAddress;
}

async function notifyTransactionHash(
  callback: TransactionHashCallback | undefined,
  transactionHash: Hash,
): Promise<void> {
  try {
    await callback?.(transactionHash);
  } catch {
    // An observer failure must not disguise or interrupt an already-broadcast transaction.
  }
}

async function waitForAuthoritativeReceipt(
  publicClient: MonadPublicClient,
  transactionHash: Hash,
  onTransactionHash?: TransactionHashCallback,
): Promise<{
  receipt: Awaited<
    ReturnType<MonadPublicClient["waitForTransactionReceipt"]>
  >;
  transactionHash: Hash;
}> {
  const replacement = {
    current: undefined as
      | {
          reason: "cancelled" | "replaced" | "repriced";
          transactionHash: Hash;
        }
      | undefined,
  };
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    checkReplacement: true,
    confirmations: TRANSACTION_CONFIRMATIONS,
    onReplaced(response) {
      const sameIntent =
        response.transaction.from.toLowerCase() ===
          response.replacedTransaction.from.toLowerCase() &&
        response.transaction.nonce === response.replacedTransaction.nonce &&
        response.transaction.to?.toLowerCase() ===
          response.replacedTransaction.to?.toLowerCase() &&
        response.transaction.value === response.replacedTransaction.value &&
        response.transaction.input.toLowerCase() ===
          response.replacedTransaction.input.toLowerCase();
      replacement.current = {
        reason:
          response.reason === "repriced" && !sameIntent
            ? "replaced"
            : response.reason,
        transactionHash: requireTransactionHash(response.transaction.hash),
      };
    },
  });
  const observedReplacement = replacement.current;
  if (
    observedReplacement &&
    observedReplacement.reason !== "repriced"
  ) {
    throw fail(
      "TRANSACTION_REPLACED",
      "제출한 거래가 취소되었거나 다른 거래로 교체되었어요. 같은 작업을 다시 제출해도 안전해요.",
    );
  }
  const authoritativeHash =
    observedReplacement?.transactionHash ?? transactionHash;
  if (observedReplacement) {
    await notifyTransactionHash(onTransactionHash, authoritativeHash);
  }
  requireMatchingReceiptHash(receipt, authoritativeHash);
  return { receipt, transactionHash: authoritativeHash };
}

async function gasWithSafetyMargin(
  estimate: () => Promise<bigint>,
  hardCap: bigint,
): Promise<bigint> {
  let estimated: bigint;
  try {
    estimated = await estimate();
  } catch (error) {
    throw asRandomnessClientError(error, "GAS_ESTIMATION_FAILED");
  }
  if (estimated <= BIGINT_ZERO) {
    throw fail(
      "GAS_ESTIMATION_FAILED",
      "안전한 가스 한도를 계산하지 못해 거래를 열지 않았어요.",
    );
  }

  const padded =
    (estimated * GAS_MARGIN_NUMERATOR + GAS_MARGIN_DENOMINATOR - BIGINT_ONE) /
    GAS_MARGIN_DENOMINATOR;
  if (padded > hardCap) {
    throw fail("GAS_LIMIT_EXCEEDED", "예상 가스가 이 작업의 안전 한도를 초과했어요.");
  }
  return padded;
}

export async function assertCompatibleContract(
  publicClient: MonadPublicClient,
  contractAddress: string,
  artifact?: PlatformArtifact,
  fetchImpl?: FetchLike,
): Promise<Address> {
  const address = requireContractAddress(contractAddress);
  const published = await resolvedArtifact(artifact, fetchImpl);
  const bytecode = await publicClient.getBytecode({ address });
  if (!bytecode || bytecode === "0x") {
    throw fail("CONTRACT_NOT_FOUND", "해당 주소에서 배포된 컨트랙트를 찾지 못했어요.");
  }
  if (
    !isBytecode(bytecode) ||
    keccak256(bytecode).toLowerCase() !== published.runtimeBytecodeHash.toLowerCase()
  ) {
    throw fail(
      "INCOMPATIBLE_CONTRACT",
      "공식 PlatformRandomness 컨트랙트와 일치하지 않는 주소예요.",
    );
  }
  return address;
}

export async function recoverDemoDeployment({
  publicClient,
  transactionHash: untrustedTransactionHash,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  transactionHash: string;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<DemoDeploymentResult> {
  try {
    const transactionHash = requireTransactionHash(untrustedTransactionHash);
    const published = await resolvedArtifact(artifact, fetchImpl);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    const deployedAddress = requireDeploymentReceipt(receipt);
    const contractAddress = await assertCompatibleContract(
      publicClient,
      deployedAddress,
      published,
    );
    return { contractAddress, transactionHash: confirmed.transactionHash };
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function deployDemoPlatform({
  walletClient,
  publicClient,
  owner,
  platformName = "Monad RNG personal demo",
  maxPending = DEFAULT_DEMO_MAX_PENDING,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  walletClient: MonadWalletClient;
  publicClient: MonadPublicClient;
  owner: Address;
  platformName?: string;
  maxPending?: bigint;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<DemoDeploymentResult> {
  if (maxPending < BIGINT_ONE || maxPending > DEMO_MAX_PENDING_LIMIT) {
    throw fail(
      "INVALID_PENDING_CAP",
      "동시 대기 한도는 1개부터 256개 사이여야 해요.",
    );
  }

  try {
    const published = await resolvedArtifact(artifact, fetchImpl);
    const account = getAddress(owner);
    const constructorArgs = [
      account,
      platformName.trim() || "Monad RNG personal demo",
      BIGINT_ZERO,
      maxPending,
    ] as const;
    const deployData = encodeDeployData({
      abi: published.abi,
      bytecode: published.bytecode,
      args: constructorArgs,
    });
    const gas = await gasWithSafetyMargin(
      () =>
        publicClient.estimateGas({
          account,
          data: deployData,
          value: BIGINT_ZERO,
        }),
      DEPLOY_GAS_CAP,
    );
    const deployContract = walletClient.deployContract as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Hash>;
    const transactionHash = requireTransactionHash(
      await deployContract({
        account,
        abi: published.abi,
        bytecode: published.bytecode,
        args: constructorArgs,
        gas,
        value: BIGINT_ZERO,
      }),
    );
    await notifyTransactionHash(onTransactionHash, transactionHash);
    return await recoverDemoDeployment({
      publicClient,
      transactionHash,
      artifact: published,
      onTransactionHash,
    });
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

function normalizeBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw fail("INVALID_REQUEST", "컨트랙트의 난수 요청 데이터를 읽지 못했어요.");
}

function normalizeHex32(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw fail("INVALID_REQUEST", "컨트랙트의 난수 요청 데이터를 읽지 못했어요.");
  }
  return value as Hex;
}

export function normalizeRequest(value: unknown): RandomnessRequest {
  const candidate = Array.isArray(value)
    ? {
        requester: value[0],
        requestBlock: value[1],
        firstTargetBlock: value[2],
        secondTargetBlock: value[3],
        thirdTargetBlock: value[4],
        pricePaid: value[5],
        finalizer: value[6],
        result: value[7],
        finalized: value[8],
        expired: value[9],
      }
    : (value as Record<string, unknown> | null);

  if (!candidate || typeof candidate !== "object") {
    throw fail("INVALID_REQUEST", "컨트랙트의 난수 요청 데이터를 읽지 못했어요.");
  }

  try {
    return {
      requester: getAddress(String(candidate.requester)),
      requestBlock: normalizeBigInt(candidate.requestBlock),
      firstTargetBlock: normalizeBigInt(candidate.firstTargetBlock),
      secondTargetBlock: normalizeBigInt(candidate.secondTargetBlock),
      thirdTargetBlock: normalizeBigInt(candidate.thirdTargetBlock),
      pricePaid: normalizeBigInt(candidate.pricePaid),
      finalizer: getAddress(String(candidate.finalizer ?? ZERO_ADDRESS)),
      result: normalizeHex32(candidate.result ?? ZERO_RESULT),
      finalized: candidate.finalized === true,
      expired: candidate.expired === true,
    };
  } catch (error) {
    if (error instanceof RandomnessClientError) throw error;
    throw fail("INVALID_REQUEST", "컨트랙트의 난수 요청 데이터를 읽지 못했어요.", error);
  }
}

function decodedRequestEvent(
  abi: Abi,
  logs: readonly Log[],
  contractAddress: Address,
  expectedRequester?: Address,
): {
  requestId: bigint;
  requester: Address;
  requestBlock: bigint;
  firstTargetBlock: bigint;
  secondTargetBlock: bigint;
  thirdTargetBlock: bigint;
  pricePaid: bigint;
} {
  try {
    const parsed = parseEventLogs({
      abi,
      logs: [...logs],
      eventName: "RandomnessRequested",
      strict: true,
    });
    const event = parsed.find(
      (log) =>
        getAddress(log.address) === contractAddress &&
        log.eventName === "RandomnessRequested",
    );
    if (!event || !event.args || typeof event.args !== "object") {
      throw fail("INVALID_REQUEST", "Tx1 영수증에서 난수 요청 번호를 찾지 못했어요.");
    }
    const args = event.args as Record<string, unknown>;
    const requester = getAddress(String(args.requester));
    if (expectedRequester && requester !== expectedRequester) {
      throw fail("INVALID_REQUEST", "Tx1 영수증의 요청자 주소가 일치하지 않아요.");
    }

    return {
      requestId: normalizeBigInt(args.requestId),
      requester,
      requestBlock: normalizeBigInt(args.requestBlock),
      firstTargetBlock: normalizeBigInt(args.firstTargetBlock),
      secondTargetBlock: normalizeBigInt(args.secondTargetBlock),
      thirdTargetBlock: normalizeBigInt(args.thirdTargetBlock),
      pricePaid: normalizeBigInt(args.pricePaid),
    };
  } catch (error) {
    if (error instanceof RandomnessClientError) throw error;
    throw fail("INVALID_REQUEST", "Tx1 영수증의 난수 요청 이벤트가 올바르지 않아요.", error);
  }
}

function decodedFinalizationEvent(
  abi: Abi,
  logs: readonly Log[],
  contractAddress: Address,
  expectedRequestId: bigint,
  expectedFinalizer?: Address,
): {
  requestId: bigint;
  requester: Address;
  finalizer: Address;
  result: Hex;
} {
  try {
    const parsed = parseEventLogs({
      abi,
      logs: [...logs],
      eventName: "RandomnessFinalized",
      strict: true,
    });
    const event = parsed.find(
      (log) =>
        getAddress(log.address) === contractAddress &&
        log.eventName === "RandomnessFinalized",
    );
    if (!event || !event.args || typeof event.args !== "object") {
      throw fail("INVALID_REQUEST", "Tx2 영수증에서 난수 확정 이벤트를 찾지 못했어요.");
    }
    const args = event.args as Record<string, unknown>;
    const requestId = normalizeBigInt(args.requestId);
    const requester = getAddress(String(args.requester));
    const finalizer = getAddress(String(args.finalizer));
    const result = normalizeHex32(args.result);
    if (
      requestId !== expectedRequestId ||
      (expectedFinalizer !== undefined && finalizer !== expectedFinalizer)
    ) {
      throw fail("INVALID_REQUEST", "Tx2 영수증의 요청 정보가 일치하지 않아요.");
    }
    return { requestId, requester, finalizer, result };
  } catch (error) {
    if (error instanceof RandomnessClientError) throw error;
    throw fail("INVALID_REQUEST", "Tx2 영수증의 난수 확정 이벤트가 올바르지 않아요.", error);
  }
}

function decodedExpiryEvent(
  abi: Abi,
  logs: readonly Log[],
  contractAddress: Address,
  expectedRequestId: bigint,
  expectedExpirer?: Address,
): {
  requestId: bigint;
  requester: Address;
  expirer: Address;
} {
  try {
    const parsed = parseEventLogs({
      abi,
      logs: [...logs],
      eventName: "RandomnessRequestExpired",
      strict: true,
    });
    const event = parsed.find(
      (log) =>
        getAddress(log.address) === contractAddress &&
        log.eventName === "RandomnessRequestExpired",
    );
    if (!event || !event.args || typeof event.args !== "object") {
      throw fail("INVALID_REQUEST", "만료 영수증에서 요청 만료 이벤트를 찾지 못했어요.");
    }
    const args = event.args as Record<string, unknown>;
    const requestId = normalizeBigInt(args.requestId);
    const requester = getAddress(String(args.requester));
    const expirer = getAddress(String(args.expirer));
    if (
      requestId !== expectedRequestId ||
      (expectedExpirer !== undefined && expirer !== expectedExpirer)
    ) {
      throw fail("INVALID_REQUEST", "만료 영수증의 요청 정보가 일치하지 않아요.");
    }
    return { requestId, requester, expirer };
  } catch (error) {
    if (error instanceof RandomnessClientError) throw error;
    throw fail("INVALID_REQUEST", "만료 영수증의 요청 만료 이벤트가 올바르지 않아요.", error);
  }
}

function requestTransactionResult(
  transactionHash: Hash,
  requested: ReturnType<typeof decodedRequestEvent>,
): RandomnessRequestTransactionResult {
  return {
    transactionHash,
    requestId: requested.requestId,
    requester: requested.requester,
    requestBlock: requested.requestBlock,
    targetBlocks: [
      requested.firstTargetBlock,
      requested.secondTargetBlock,
      requested.thirdTargetBlock,
    ],
    pricePaid: requested.pricePaid,
  };
}

export async function recoverRandomnessRequestTx({
  publicClient,
  contractAddress,
  transactionHash: untrustedTransactionHash,
  expectedRequester,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  contractAddress: string;
  transactionHash: string;
  expectedRequester?: string;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessRequestTransactionResult> {
  try {
    const transactionHash = requireTransactionHash(untrustedTransactionHash);
    const address = requireContractAddress(contractAddress);
    const requester =
      expectedRequester === undefined
        ? undefined
        : requireContractAddress(expectedRequester);
    const published = await resolvedArtifact(artifact, fetchImpl);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    await assertCompatibleContract(publicClient, address, published);
    const requested = decodedRequestEvent(
      published.abi,
      receipt.logs,
      address,
      requester,
    );
    return requestTransactionResult(confirmed.transactionHash, requested);
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function requestRandomnessTx({
  publicClient,
  walletClient,
  account,
  contractAddress,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  walletClient: MonadWalletClient;
  account: Address;
  contractAddress: string;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessRequestTransactionResult> {
  try {
    const published = await resolvedArtifact(artifact, fetchImpl);
    const address = await assertCompatibleContract(publicClient, contractAddress, published);
    const signer = getAddress(account);
    const requestPrice = (await publicClient.readContract({
      address,
      abi: published.abi,
      functionName: "requestPrice",
      blockTag: "latest",
    })) as bigint;
    const estimateContractGas = publicClient.estimateContractGas as unknown as (
      args: Record<string, unknown>,
    ) => Promise<bigint>;
    const transaction = {
      account: signer,
      address,
      abi: published.abi,
      functionName: "requestRandomness",
      args: [],
      value: requestPrice,
    };
    const gas = await gasWithSafetyMargin(
      () => estimateContractGas(transaction),
      TX1_GAS_CAP,
    );
    const writeContract = walletClient.writeContract as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Hash>;
    const transactionHash = requireTransactionHash(
      await writeContract({
        ...transaction,
        gas,
      }),
    );
    await notifyTransactionHash(onTransactionHash, transactionHash);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    const requested = decodedRequestEvent(
      published.abi,
      receipt.logs,
      address,
      signer,
    );
    return requestTransactionResult(confirmed.transactionHash, requested);
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function fetchRawHeaders(
  targetBlocks: readonly bigint[],
  fetchImpl: FetchLike = defaultFetch(),
): Promise<[Hex, Hex, Hex]> {
  if (targetBlocks.length !== 3) {
    throw fail("INVALID_TARGETS", "난수 확정에는 정확히 세 개의 대상 블록이 필요해요.");
  }

  try {
    const results = await Promise.all(
      targetBlocks.map(async (blockNumber, index) => {
        const response = await fetchImpl(MONAD_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "debug_getRawHeader",
            params: [numberToHex(blockNumber)],
          }),
        });
        const payload = (await response.json()) as {
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (!response.ok || payload.error || typeof payload.result !== "string") {
          const rpcError = new Error(
            payload.error?.message ?? `Raw header HTTP ${response.status ?? "error"}`,
          ) as Error & { code?: number };
          rpcError.code = payload.error?.code;
          throw rpcError;
        }
        const encodedLength = payload.result.length - 2;
        if (
          !/^0x(?:[0-9a-fA-F]{2})+$/.test(payload.result) ||
          encodedLength / 2 > MAX_RAW_HEADER_BYTES
        ) {
          throw new Error("RPC returned a malformed raw header");
        }
        return payload.result as Hex;
      }),
    );
    return results as [Hex, Hex, Hex];
  } catch (error) {
    throw fail(
      "RAW_HEADER_UNAVAILABLE",
      "RPC가 Monad 원본 블록 헤더를 제공하지 못했어요.",
      error,
    );
  }
}

export function calculateReadiness(
  request: RandomnessRequest,
  currentBlock: bigint,
  caller?: string,
): RequestReadiness {
  const requesterFinalizationBlock = request.thirdTargetBlock + BigInt(2);
  const permissionlessRescueBlock = request.thirdTargetBlock + BigInt(64);
  const lastProofValidBlock = request.firstTargetBlock + BigInt(8_191);
  const firstExpiryBlock = lastProofValidBlock + BIGINT_ONE;
  const fixed = {
    requesterFinalizationBlock,
    permissionlessRescueBlock,
    lastProofValidBlock,
    firstExpiryBlock,
  };

  if (request.finalized) {
    return {
      phase: "finalized",
      canFinalize: false,
      canExpire: false,
      blocksRemaining: BIGINT_ZERO,
      ...fixed,
    };
  }
  if (request.expired) {
    return {
      phase: "expired",
      canFinalize: false,
      canExpire: false,
      blocksRemaining: BIGINT_ZERO,
      ...fixed,
    };
  }
  if (currentBlock >= firstExpiryBlock) {
    return {
      phase: "proof-expired",
      canFinalize: false,
      canExpire: true,
      blocksRemaining: BIGINT_ZERO,
      ...fixed,
    };
  }
  if (currentBlock >= permissionlessRescueBlock) {
    return {
      phase: "permissionless",
      canFinalize: true,
      canExpire: false,
      blocksRemaining: BIGINT_ZERO,
      ...fixed,
    };
  }
  if (currentBlock >= requesterFinalizationBlock) {
    const normalizedCaller =
      caller === undefined
        ? undefined
        : (() => {
            try {
              return getAddress(caller);
            } catch {
              return undefined;
            }
          })();
    return {
      phase: "requester",
      canFinalize: normalizedCaller === request.requester,
      canExpire: false,
      blocksRemaining: BIGINT_ZERO,
      ...fixed,
    };
  }
  return {
    phase: "waiting",
    canFinalize: false,
    canExpire: false,
    blocksRemaining: requesterFinalizationBlock - currentBlock,
    ...fixed,
  };
}

async function readRequestWithArtifact(
  publicClient: MonadPublicClient,
  address: Address,
  requestId: bigint,
  artifact: PlatformArtifact,
  blockTag: "latest" | "finalized" = "finalized",
): Promise<RandomnessRequest> {
  const value = await publicClient.readContract({
    address,
    abi: artifact.abi,
    functionName: "getRequest",
    args: [requestId],
    blockTag,
  });
  return normalizeRequest(value);
}

export function toOneBasedDraw(value: bigint): number {
  if (value < BIGINT_ZERO || value >= DRAW_UPPER_BOUND) {
    throw fail("INVALID_DRAW", "컨트랙트가 올바르지 않은 추첨 값을 반환했어요.");
  }
  return Number(value) + 1;
}

export async function readRandomnessResult({
  publicClient,
  contractAddress,
  requestId,
  artifact,
  fetchImpl,
}: {
  publicClient: MonadPublicClient;
  contractAddress: string;
  requestId: bigint;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
}): Promise<{
  contractAddress: Address;
  requestId: bigint;
  request: RandomnessRequest;
  drawZeroBased?: bigint;
  drawOneBased?: number;
}> {
  try {
    const published = await resolvedArtifact(artifact, fetchImpl);
    const address = await assertCompatibleContract(publicClient, contractAddress, published);
    const request = await readRequestWithArtifact(publicClient, address, requestId, published);
    if (!request.finalized) {
      return { contractAddress: address, requestId, request };
    }
    const drawZeroBased = (await publicClient.readContract({
      address,
      abi: published.abi,
      functionName: "draw",
      args: [requestId, DRAW_UPPER_BOUND],
      blockTag: "finalized",
    })) as bigint;
    return {
      contractAddress: address,
      requestId,
      request,
      drawZeroBased,
      drawOneBased: toOneBasedDraw(drawZeroBased),
    };
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

async function finalizedTransactionResult(
  publicClient: MonadPublicClient,
  address: Address,
  requestId: bigint,
  transactionHash: Hash,
  published: PlatformArtifact,
  finalizedEvent: ReturnType<typeof decodedFinalizationEvent>,
): Promise<RandomnessFinalizationTransactionResult> {
  const permanent = await readRandomnessResult({
    publicClient,
    contractAddress: address,
    requestId,
    artifact: published,
  });
  if (
    !permanent.request.finalized ||
    permanent.request.expired ||
    permanent.drawZeroBased === undefined ||
    permanent.drawOneBased === undefined ||
    permanent.request.requester !== finalizedEvent.requester ||
    permanent.request.finalizer !== finalizedEvent.finalizer ||
    permanent.request.result.toLowerCase() !== finalizedEvent.result.toLowerCase()
  ) {
    throw fail("INVALID_REQUEST", "Tx2 이후 영구 난수 결과가 영수증과 일치하지 않아요.");
  }
  return {
    transactionHash,
    request: permanent.request,
    drawZeroBased: permanent.drawZeroBased,
    drawOneBased: permanent.drawOneBased,
  };
}

async function expiredTransactionResult(
  publicClient: MonadPublicClient,
  address: Address,
  requestId: bigint,
  transactionHash: Hash,
  published: PlatformArtifact,
  expiryEvent: ReturnType<typeof decodedExpiryEvent>,
): Promise<RandomnessExpiryTransactionResult> {
  const permanent = await readRandomnessResult({
    publicClient,
    contractAddress: address,
    requestId,
    artifact: published,
  });
  if (
    permanent.request.finalized ||
    !permanent.request.expired ||
    permanent.request.requester !== expiryEvent.requester
  ) {
    throw fail("INVALID_REQUEST", "만료 이후 요청 상태가 영수증과 일치하지 않아요.");
  }
  return { transactionHash, request: permanent.request };
}

export async function recoverRandomnessFinalizationTx({
  publicClient,
  contractAddress,
  requestId,
  transactionHash: untrustedTransactionHash,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  contractAddress: string;
  requestId: bigint;
  transactionHash: string;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessFinalizationTransactionResult> {
  try {
    const transactionHash = requireTransactionHash(untrustedTransactionHash);
    const address = requireContractAddress(contractAddress);
    const published = await resolvedArtifact(artifact, fetchImpl);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    await assertCompatibleContract(publicClient, address, published);
    const finalizedEvent = decodedFinalizationEvent(
      published.abi,
      receipt.logs,
      address,
      requestId,
    );
    return await finalizedTransactionResult(
      publicClient,
      address,
      requestId,
      confirmed.transactionHash,
      published,
      finalizedEvent,
    );
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function recoverRandomnessExpiryTx({
  publicClient,
  contractAddress,
  requestId,
  transactionHash: untrustedTransactionHash,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  contractAddress: string;
  requestId: bigint;
  transactionHash: string;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessExpiryTransactionResult> {
  try {
    const transactionHash = requireTransactionHash(untrustedTransactionHash);
    const address = requireContractAddress(contractAddress);
    const published = await resolvedArtifact(artifact, fetchImpl);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    await assertCompatibleContract(publicClient, address, published);
    const expiryEvent = decodedExpiryEvent(
      published.abi,
      receipt.logs,
      address,
      requestId,
    );
    return await expiredTransactionResult(
      publicClient,
      address,
      requestId,
      confirmed.transactionHash,
      published,
      expiryEvent,
    );
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function finalizeRandomnessTx({
  publicClient,
  walletClient,
  account,
  contractAddress,
  requestId,
  headers,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  walletClient: MonadWalletClient;
  account: Address;
  contractAddress: string;
  requestId: bigint;
  headers: readonly [Hex, Hex, Hex];
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessFinalizationTransactionResult> {
  try {
    if (headers.length !== 3) {
      throw fail("INVALID_TARGETS", "난수 확정에는 정확히 세 개의 대상 블록이 필요해요.");
    }
    const published = await resolvedArtifact(artifact, fetchImpl);
    const address = await assertCompatibleContract(publicClient, contractAddress, published);
    const signer = getAddress(account);
    const estimateContractGas = publicClient.estimateContractGas as unknown as (
      args: Record<string, unknown>,
    ) => Promise<bigint>;
    const transaction = {
      account: signer,
      address,
      abi: published.abi,
      functionName: "finalizeRandomness",
      args: [requestId, headers[0], headers[1], headers[2]],
      value: BIGINT_ZERO,
    };
    const gas = await gasWithSafetyMargin(
      () => estimateContractGas(transaction),
      TX2_GAS_CAP,
    );
    const writeContract = walletClient.writeContract as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Hash>;
    const transactionHash = requireTransactionHash(
      await writeContract({
        ...transaction,
        gas,
      }),
    );
    await notifyTransactionHash(onTransactionHash, transactionHash);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    const finalizedEvent = decodedFinalizationEvent(
      published.abi,
      receipt.logs,
      address,
      requestId,
      signer,
    );
    return await finalizedTransactionResult(
      publicClient,
      address,
      requestId,
      confirmed.transactionHash,
      published,
      finalizedEvent,
    );
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export async function expireRandomnessRequest({
  publicClient,
  walletClient,
  account,
  contractAddress,
  requestId,
  artifact,
  fetchImpl,
  onTransactionHash,
}: {
  publicClient: MonadPublicClient;
  walletClient: MonadWalletClient;
  account: Address;
  contractAddress: string;
  requestId: bigint;
  artifact?: PlatformArtifact;
  fetchImpl?: FetchLike;
  onTransactionHash?: TransactionHashCallback;
}): Promise<RandomnessExpiryTransactionResult> {
  try {
    const published = await resolvedArtifact(artifact, fetchImpl);
    const address = await assertCompatibleContract(publicClient, contractAddress, published);
    const [request, currentBlock] = await Promise.all([
      readRequestWithArtifact(publicClient, address, requestId, published, "latest"),
      publicClient.getBlockNumber(),
    ]);
    if (request.finalized || request.expired) {
      throw fail("DUPLICATE_STATE", "이미 확정되거나 만료된 요청이에요.");
    }
    const readiness = calculateReadiness(request, currentBlock);
    if (!readiness.canExpire) {
      throw fail("EXPIRY_NOT_READY", "아직 이 요청을 만료 처리할 수 없어요.");
    }
    const signer = getAddress(account);
    const estimateContractGas = publicClient.estimateContractGas as unknown as (
      args: Record<string, unknown>,
    ) => Promise<bigint>;
    const transaction = {
      account: signer,
      address,
      abi: published.abi,
      functionName: "expireRequest",
      args: [requestId],
      value: BIGINT_ZERO,
    };
    const gas = await gasWithSafetyMargin(
      () => estimateContractGas(transaction),
      EXPIRY_GAS_CAP,
    );
    const writeContract = walletClient.writeContract as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Hash>;
    const transactionHash = requireTransactionHash(
      await writeContract({
        ...transaction,
        gas,
      }),
    );
    await notifyTransactionHash(onTransactionHash, transactionHash);
    const confirmed = await waitForAuthoritativeReceipt(
      publicClient,
      transactionHash,
      onTransactionHash,
    );
    const { receipt } = confirmed;
    requireSuccessfulReceipt(receipt);
    requireReceiptDestination(receipt, address);
    const expiryEvent = decodedExpiryEvent(
      published.abi,
      receipt.logs,
      address,
      requestId,
      signer,
    );
    return await expiredTransactionResult(
      publicClient,
      address,
      requestId,
      confirmed.transactionHash,
      published,
      expiryEvent,
    );
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}
