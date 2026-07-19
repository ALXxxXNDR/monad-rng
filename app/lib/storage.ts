import { getAddress } from "viem";
import type { Address, Hash } from "viem";

// Keep the original browser namespace frozen so existing deployments, pending
// transactions, and older open tabs remain recoverable after the RNG rename.
const LEGACY_BROWSER_NAMESPACE = "monad-rnd";
export const LOCAL_STATE_KEY = `${LEGACY_BROWSER_NAMESPACE}:state:v1`;
const MAX_RECENT_REQUESTS = 20;
export const MAX_PENDING_TRANSACTIONS = 20;

export interface StoredDemoContract {
  chainId: number;
  contractAddress: Address;
  deploymentTxHash?: Hash;
}

export interface StoredRequestReference {
  chainId: number;
  contractAddress: Address;
  requestId: string;
  tx1Hash?: Hash;
  tx2Hash?: Hash;
  expiryHash?: Hash;
}

export interface StoredPendingDeployment {
  kind: "deployment";
  chainId: number;
  transactionHash: Hash;
  createdAt: number;
}

export interface StoredPendingRequest {
  kind: "request";
  chainId: number;
  contractAddress: Address;
  requester?: Address;
  transactionHash: Hash;
  createdAt: number;
}

export interface StoredPendingRequestAction {
  kind: "finalization" | "expiry";
  chainId: number;
  contractAddress: Address;
  requestId: string;
  transactionHash: Hash;
  createdAt: number;
}

export type StoredPendingTransaction =
  | StoredPendingDeployment
  | StoredPendingRequest
  | StoredPendingRequestAction;

export type PendingTransactionInput =
  | {
      kind: "deployment";
      chainId: number;
      transactionHash: string;
      createdAt?: number;
    }
  | {
      kind: "request";
      chainId: number;
      contractAddress: string;
      requester?: string;
      transactionHash: string;
      createdAt?: number;
    }
  | {
      kind: "finalization" | "expiry";
      chainId: number;
      contractAddress: string;
      requestId: bigint | string;
      transactionHash: string;
      createdAt?: number;
    };

export type PendingWriteAction =
  | {
      kind: "deployment";
      chainId: number;
    }
  | {
      kind: "request";
      chainId: number;
      contractAddress: string;
      requester: string;
    }
  | {
      kind: "finalization" | "expiry";
      chainId: number;
      contractAddress: string;
      requestId: bigint | string;
    };

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: true },
    callback: (
      lock: { name: string; mode: "exclusive" | "shared" } | null,
    ) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface StorageChangeEventLike {
  key: string | null;
}

export interface StorageEventTargetLike {
  addEventListener(
    type: "storage",
    listener: (event: StorageChangeEventLike) => void,
  ): void;
  removeEventListener(
    type: "storage",
    listener: (event: StorageChangeEventLike) => void,
  ): void;
}

export interface StoredLocalState {
  version: 2;
  demoContracts: StoredDemoContract[];
  recentRequests: StoredRequestReference[];
  pendingTransactions: StoredPendingTransaction[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function emptyState(): StoredLocalState {
  return {
    version: 2,
    demoContracts: [],
    recentRequests: [],
    pendingTransactions: [],
  };
}

function browserStorage(): StorageLike | undefined {
  return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
}

function validChainId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safeAddress(value: unknown): Address | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

function safeHash(value: unknown): Hash | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? (value.toLowerCase() as Hash)
    : undefined;
}

function safeTimestamp(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function safeRequestId(value: unknown): string | undefined {
  const normalized = typeof value === "bigint" ? value.toString() : value;
  return typeof normalized === "string" && /^(0|[1-9][0-9]*)$/.test(normalized)
    ? normalized
    : undefined;
}

function sanitizeDemo(value: unknown): StoredDemoContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!validChainId(candidate.chainId)) return undefined;
  const contractAddress = safeAddress(candidate.contractAddress);
  if (!contractAddress) return undefined;
  const deploymentTxHash = safeHash(candidate.deploymentTxHash);

  return {
    chainId: candidate.chainId,
    contractAddress,
    ...(deploymentTxHash ? { deploymentTxHash } : {}),
  };
}

function sanitizeRequest(value: unknown): StoredRequestReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!validChainId(candidate.chainId)) return undefined;
  const contractAddress = safeAddress(candidate.contractAddress);
  const requestId = safeRequestId(candidate.requestId);
  if (!contractAddress || requestId === undefined) return undefined;
  const tx1Hash = safeHash(candidate.tx1Hash);
  const tx2Hash = safeHash(candidate.tx2Hash);
  const expiryHash = safeHash(candidate.expiryHash);

  return {
    chainId: candidate.chainId,
    contractAddress,
    requestId,
    ...(tx1Hash ? { tx1Hash } : {}),
    ...(tx2Hash ? { tx2Hash } : {}),
    ...(expiryHash ? { expiryHash } : {}),
  };
}

function sanitizePending(
  value: unknown,
  fallbackTimestamp = 0,
): StoredPendingTransaction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!validChainId(candidate.chainId)) return undefined;
  const transactionHash = safeHash(candidate.transactionHash);
  if (!transactionHash) return undefined;
  const createdAt = safeTimestamp(candidate.createdAt, fallbackTimestamp);

  if (candidate.kind === "deployment") {
    return {
      kind: "deployment",
      chainId: candidate.chainId,
      transactionHash,
      createdAt,
    };
  }
  if (candidate.kind === "finalization" || candidate.kind === "expiry") {
    const contractAddress = safeAddress(candidate.contractAddress);
    const requestId = safeRequestId(candidate.requestId);
    if (!contractAddress || requestId === undefined) return undefined;
    return {
      kind: candidate.kind,
      chainId: candidate.chainId,
      contractAddress,
      requestId,
      transactionHash,
      createdAt,
    };
  }
  if (candidate.kind !== "request") return undefined;
  const contractAddress = safeAddress(candidate.contractAddress);
  if (!contractAddress) return undefined;
  const requester = safeAddress(candidate.requester);
  return {
    kind: "request",
    chainId: candidate.chainId,
    contractAddress,
    ...(requester ? { requester } : {}),
    transactionHash,
    createdAt,
  };
}

function deduplicateDemos(demos: StoredDemoContract[]): StoredDemoContract[] {
  const seen = new Set<number>();
  return demos.filter((demo) => {
    if (seen.has(demo.chainId)) return false;
    seen.add(demo.chainId);
    return true;
  });
}

function deduplicateRequests(requests: StoredRequestReference[]): StoredRequestReference[] {
  const seen = new Set<string>();
  return requests
    .filter((request) => {
      const key = `${request.chainId}:${request.contractAddress}:${request.requestId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RECENT_REQUESTS);
}

function deduplicatePending(
  pendingTransactions: StoredPendingTransaction[],
): StoredPendingTransaction[] {
  const seen = new Set<string>();
  return pendingTransactions
    .filter((pending) => {
      const key = `${pending.chainId}:${pending.transactionHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PENDING_TRANSACTIONS);
}

function samePendingAction(
  left: StoredPendingTransaction,
  right: StoredPendingTransaction,
): boolean {
  if (left.kind !== right.kind || left.chainId !== right.chainId) return false;
  if (left.kind === "deployment" || right.kind === "deployment") return true;
  if (
    left.contractAddress.toLowerCase() !==
    right.contractAddress.toLowerCase()
  ) {
    return false;
  }
  if (left.kind === "request" && right.kind === "request") {
    return (
      left.requester?.toLowerCase() === right.requester?.toLowerCase()
    );
  }
  if (left.kind === "request" || right.kind === "request") return false;
  return left.requestId === right.requestId;
}

function pendingMatchesWriteAction(
  pending: StoredPendingTransaction,
  action: PendingWriteAction,
): boolean {
  if (pending.kind !== action.kind || pending.chainId !== action.chainId) {
    return false;
  }
  if (pending.kind === "deployment" || action.kind === "deployment") {
    return true;
  }
  if (
    pending.contractAddress.toLowerCase() !==
    action.contractAddress.toLowerCase()
  ) {
    return false;
  }
  if (pending.kind === "request" && action.kind === "request") {
    return (
      pending.requester === undefined ||
      pending.requester.toLowerCase() === action.requester.toLowerCase()
    );
  }
  if (pending.kind === "request" || action.kind === "request") return false;
  return pending.requestId === action.requestId.toString();
}

function pendingWriteLockName(action: PendingWriteAction): string {
  const prefix = `${LEGACY_BROWSER_NAMESPACE}:write:v1:${action.chainId}:${action.kind}`;
  if (action.kind === "deployment") return prefix;
  if (action.kind === "request") {
    return `${prefix}:${action.contractAddress.toLowerCase()}:${action.requester.toLowerCase()}`;
  }
  return `${prefix}:${action.contractAddress.toLowerCase()}:${action.requestId.toString()}`;
}

function sanitizeState(value: unknown): StoredLocalState {
  if (!value || typeof value !== "object") return emptyState();
  const candidate = value as Record<string, unknown>;
  const demoInputs = Array.isArray(candidate.demoContracts) ? candidate.demoContracts : [];
  const requestInputs = Array.isArray(candidate.recentRequests) ? candidate.recentRequests : [];
  const pendingInputs = Array.isArray(candidate.pendingTransactions)
    ? candidate.pendingTransactions
    : [];

  const legacyDemo =
    validChainId(candidate.chainId) && typeof candidate.demoContract === "string"
      ? sanitizeDemo({
          chainId: candidate.chainId,
          contractAddress: candidate.demoContract,
          deploymentTxHash: candidate.deploymentTxHash,
        })
      : undefined;

  return {
    version: 2,
    demoContracts: deduplicateDemos(
      [legacyDemo, ...demoInputs.map(sanitizeDemo)].filter(
        (demo): demo is StoredDemoContract => Boolean(demo),
      ),
    ),
    recentRequests: deduplicateRequests(
      requestInputs
        .map(sanitizeRequest)
        .filter((request): request is StoredRequestReference => Boolean(request)),
    ),
    pendingTransactions: deduplicatePending(
      pendingInputs
        .map((pending) => sanitizePending(pending))
        .filter(
          (pending): pending is StoredPendingTransaction => Boolean(pending),
        ),
    ),
  };
}

export function loadStoredState(storage: StorageLike | undefined = browserStorage()): StoredLocalState {
  if (!storage) return emptyState();

  let serialized: string | null;
  try {
    serialized = storage.getItem(LOCAL_STATE_KEY);
  } catch {
    return emptyState();
  }
  if (!serialized) return emptyState();

  let state: StoredLocalState;
  try {
    state = sanitizeState(JSON.parse(serialized));
  } catch {
    state = emptyState();
  }
  return state;
}

function persistState(storage: StorageLike | undefined, state: StoredLocalState): StoredLocalState {
  try {
    storage?.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // The on-chain state stays authoritative when local persistence is unavailable.
  }
  return state;
}

export function rememberDemoContract(
  storage: StorageLike | undefined,
  value: {
    chainId: number;
    contractAddress: string;
    deploymentTxHash?: string;
  },
): StoredLocalState {
  const demo = sanitizeDemo(value);
  const current = loadStoredState(storage);
  if (!demo) return current;

  return persistState(storage, {
    version: 2,
    demoContracts: [demo, ...current.demoContracts.filter((item) => item.chainId !== demo.chainId)],
    recentRequests: current.recentRequests,
    pendingTransactions: current.pendingTransactions,
  });
}

export function rememberRequest(
  storage: StorageLike | undefined,
  value: {
    chainId: number;
    contractAddress: string;
    requestId: bigint | string;
    tx1Hash?: string;
    tx2Hash?: string;
    expiryHash?: string;
  },
): StoredLocalState {
  const request = sanitizeRequest(value);
  const current = loadStoredState(storage);
  if (!request) return current;
  const key = `${request.chainId}:${request.contractAddress}:${request.requestId}`;
  const existing = current.recentRequests.find(
    (item) => `${item.chainId}:${item.contractAddress}:${item.requestId}` === key,
  );
  const merged = existing ? { ...existing, ...request } : request;

  return persistState(storage, {
    version: 2,
    demoContracts: current.demoContracts,
    recentRequests: deduplicateRequests([
      merged,
      ...current.recentRequests.filter(
        (item) => `${item.chainId}:${item.contractAddress}:${item.requestId}` !== key,
      ),
    ]),
    pendingTransactions: current.pendingTransactions,
  });
}

export function rememberPendingTransaction(
  storage: StorageLike | undefined,
  value: PendingTransactionInput,
): StoredLocalState {
  const pending = sanitizePending(value, Date.now());
  const current = loadStoredState(storage);
  if (!pending) return current;
  const key = `${pending.chainId}:${pending.transactionHash}`;

  return persistState(storage, {
    version: 2,
    demoContracts: current.demoContracts,
    recentRequests: current.recentRequests,
    pendingTransactions: deduplicatePending([
      pending,
      ...current.pendingTransactions.filter(
        (item) =>
          `${item.chainId}:${item.transactionHash}` !== key &&
          !samePendingAction(item, pending),
      ),
    ]),
  });
}

export function forgetPendingTransaction(
  storage: StorageLike | undefined,
  transactionHash: string,
): StoredLocalState {
  const safeTransactionHash = safeHash(transactionHash);
  const current = loadStoredState(storage);
  if (!safeTransactionHash) return current;

  return persistState(storage, {
    version: 2,
    demoContracts: current.demoContracts,
    recentRequests: current.recentRequests,
    pendingTransactions: current.pendingTransactions.filter(
      (item) => item.transactionHash !== safeTransactionHash,
    ),
  });
}

export function readPendingTransactions(
  storage: StorageLike | undefined = browserStorage(),
  chainId?: number,
): StoredPendingTransaction[] {
  const pending = loadStoredState(storage).pendingTransactions;
  if (chainId === undefined) return pending;
  if (!validChainId(chainId)) return [];
  return pending.filter((item) => item.chainId === chainId);
}

export type PendingWriteLockResult<T> =
  | { status: "completed"; value: T }
  | { status: "busy" }
  | { status: "pending"; pending: StoredPendingTransaction }
  | { status: "unavailable" };

const STORED_STATE_MUTATION_LOCK_NAME = `${LEGACY_BROWSER_NAMESPACE}:state-mutation:v1`;

export async function runWithStoredStateMutationLock<T>({
  lockManager,
  mutate,
}: {
  lockManager: LockManagerLike | undefined;
  mutate: () => T;
}): Promise<T> {
  if (!lockManager || typeof lockManager.request !== "function") {
    return mutate();
  }

  let mutationStarted = false;
  try {
    return await lockManager.request(
      STORED_STATE_MUTATION_LOCK_NAME,
      { mode: "exclusive" },
      () => {
        mutationStarted = true;
        return mutate();
      },
    );
  } catch (error) {
    if (mutationStarted) throw error;
    return mutate();
  }
}

export async function runWithPendingWriteLock<T>({
  lockManager,
  storage,
  action,
  write,
}: {
  lockManager: LockManagerLike | undefined;
  storage: StorageLike | undefined;
  action: PendingWriteAction;
  write: () => Promise<T>;
}): Promise<PendingWriteLockResult<T>> {
  if (!lockManager || typeof lockManager.request !== "function") {
    return { status: "unavailable" };
  }

  let writeStarted = false;
  try {
    return await lockManager.request(
      pendingWriteLockName(action),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return { status: "busy" } as const;
        const pending = readPendingTransactions(storage, action.chainId).find(
          (item) => pendingMatchesWriteAction(item, action),
        );
        if (pending) return { status: "pending", pending } as const;
        writeStarted = true;
        return { status: "completed", value: await write() } as const;
      },
    );
  } catch (error) {
    if (writeStarted) throw error;
    return { status: "unavailable" };
  }
}

export function subscribeToStoredState(
  target: StorageEventTargetLike,
  storage: StorageLike | undefined,
  listener: (state: StoredLocalState) => void,
): () => void {
  const handleStorage = (event: StorageChangeEventLike) => {
    if (event.key !== LOCAL_STATE_KEY) return;
    listener(loadStoredState(storage));
  };
  target.addEventListener("storage", handleStorage);
  return () => target.removeEventListener("storage", handleStorage);
}
