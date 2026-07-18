import { getAddress } from "viem";
import type { Address, Hash } from "viem";

export const LOCAL_STATE_KEY = "monad-rnd:state:v1";
const MAX_RECENT_REQUESTS = 20;

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
}

export interface StoredLocalState {
  version: 1;
  demoContracts: StoredDemoContract[];
  recentRequests: StoredRequestReference[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EMPTY_STATE: StoredLocalState = {
  version: 1,
  demoContracts: [],
  recentRequests: [],
};

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
    ? (value as Hash)
    : undefined;
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

  return {
    chainId: candidate.chainId,
    contractAddress,
    requestId,
    ...(tx1Hash ? { tx1Hash } : {}),
    ...(tx2Hash ? { tx2Hash } : {}),
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

function sanitizeState(value: unknown): StoredLocalState {
  if (!value || typeof value !== "object") return { ...EMPTY_STATE };
  const candidate = value as Record<string, unknown>;
  const demoInputs = Array.isArray(candidate.demoContracts) ? candidate.demoContracts : [];
  const requestInputs = Array.isArray(candidate.recentRequests) ? candidate.recentRequests : [];

  const legacyDemo =
    validChainId(candidate.chainId) && typeof candidate.demoContract === "string"
      ? sanitizeDemo({
          chainId: candidate.chainId,
          contractAddress: candidate.demoContract,
          deploymentTxHash: candidate.deploymentTxHash,
        })
      : undefined;

  return {
    version: 1,
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
  };
}

export function loadStoredState(storage: StorageLike | undefined = browserStorage()): StoredLocalState {
  if (!storage) return { ...EMPTY_STATE };

  try {
    const serialized = storage.getItem(LOCAL_STATE_KEY);
    if (!serialized) return { ...EMPTY_STATE };
    return sanitizeState(JSON.parse(serialized));
  } catch {
    return { ...EMPTY_STATE };
  }
}

function persistState(storage: StorageLike | undefined, state: StoredLocalState): StoredLocalState {
  if (storage) storage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
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
    version: 1,
    demoContracts: [demo, ...current.demoContracts.filter((item) => item.chainId !== demo.chainId)],
    recentRequests: current.recentRequests,
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
  },
): StoredLocalState {
  const request = sanitizeRequest(value);
  const current = loadStoredState(storage);
  if (!request) return current;
  const key = `${request.chainId}:${request.contractAddress}:${request.requestId}`;

  return persistState(storage, {
    version: 1,
    demoContracts: current.demoContracts,
    recentRequests: deduplicateRequests([
      request,
      ...current.recentRequests.filter(
        (item) => `${item.chainId}:${item.contractAddress}:${item.requestId}` !== key,
      ),
    ]),
  });
}
