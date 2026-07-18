import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
} from "viem";
import type { Address, EIP1193Provider, Hash } from "viem";

export const MONAD_TESTNET_CHAIN_ID = 10_143;
export const MONAD_TESTNET_CHAIN_HEX = "0x279f";
export const MONAD_RPC_URL = "https://testnet-rpc.monad.xyz";
export const MONAD_EXPLORER_URL = "https://testnet.monadscan.com";
export const MONAD_FAUCET_URL = "https://faucet.monad.xyz";

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: {
    name: "Monad",
    symbol: "MON",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [MONAD_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Monadscan",
      url: MONAD_EXPLORER_URL,
    },
  },
  testnet: true,
});

export type RandomnessErrorCode =
  | "NO_WALLET"
  | "WALLET_REJECTED"
  | "WRONG_NETWORK"
  | "MISSING_MON"
  | "RAW_HEADER_UNAVAILABLE"
  | "PROOF_EXPIRED"
  | "DUPLICATE_STATE"
  | "CONTRACT_NOT_FOUND"
  | "INVALID_ADDRESS"
  | "INVALID_TRANSACTION_HASH"
  | "INVALID_ARTIFACT"
  | "INVALID_PENDING_CAP"
  | "INVALID_REQUEST"
  | "INVALID_DRAW"
  | "INVALID_TARGETS"
  | "EXPIRY_NOT_READY"
  | "TRANSACTION_REVERTED"
  | "UNKNOWN";

export class RandomnessClientError extends Error {
  readonly code: RandomnessErrorCode;

  constructor(code: RandomnessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RandomnessClientError";
    this.code = code;
  }
}

export interface InjectedWalletProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

const ERROR_MESSAGES: Record<RandomnessErrorCode, string> = {
  NO_WALLET: "브라우저 지갑을 찾지 못했어요.",
  WALLET_REJECTED: "지갑에서 요청이 취소됐어요.",
  WRONG_NETWORK: "Monad 테스트넷으로 전환하지 못했어요.",
  MISSING_MON: "가스비로 사용할 테스트넷 MON이 부족해요.",
  RAW_HEADER_UNAVAILABLE: "RPC가 Monad 원본 블록 헤더를 제공하지 못했어요.",
  PROOF_EXPIRED: "블록 증명 보관 기간이 지나 Tx2를 실행할 수 없어요.",
  DUPLICATE_STATE: "이미 확정되거나 만료된 요청이에요.",
  CONTRACT_NOT_FOUND: "해당 주소에서 배포된 컨트랙트를 찾지 못했어요.",
  INVALID_ADDRESS: "올바른 EVM 컨트랙트 주소를 입력해 주세요.",
  INVALID_TRANSACTION_HASH: "올바른 거래 해시가 아니에요.",
  INVALID_ARTIFACT: "배포용 컨트랙트 파일을 불러오지 못했어요.",
  INVALID_PENDING_CAP: "동시 대기 한도는 1개부터 256개 사이여야 해요.",
  INVALID_REQUEST: "컨트랙트의 난수 요청 데이터를 읽지 못했어요.",
  INVALID_DRAW: "컨트랙트가 올바르지 않은 추첨 값을 반환했어요.",
  INVALID_TARGETS: "난수 확정에는 정확히 세 개의 대상 블록이 필요해요.",
  EXPIRY_NOT_READY: "아직 이 요청을 만료 처리할 수 없어요.",
  TRANSACTION_REVERTED: "거래가 체인에서 실패했어요.",
  UNKNOWN: "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
};

function errorCandidates(error: unknown): unknown[] {
  const candidates: unknown[] = [];
  let current = error;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    candidates.push(current);
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }

  return candidates;
}

function propertyFromError(error: unknown, property: "code" | "errorName"): unknown {
  for (const candidate of errorCandidates(error)) {
    if (typeof candidate === "object" && candidate && property in candidate) {
      return (candidate as Record<string, unknown>)[property];
    }
  }
  return undefined;
}

function errorText(error: unknown): string {
  return errorCandidates(error)
    .map((candidate) => {
      if (candidate instanceof Error) return candidate.message;
      if (typeof candidate === "string") return candidate;
      if (typeof candidate === "object" && candidate && "message" in candidate) {
        return String((candidate as { message?: unknown }).message ?? "");
      }
      return "";
    })
    .join(" ")
    .toLowerCase();
}

export function mapClientError(error: unknown): {
  code: RandomnessErrorCode;
  message: string;
} {
  if (error instanceof RandomnessClientError) {
    return { code: error.code, message: error.message };
  }

  const code = propertyFromError(error, "code");
  const errorName = String(propertyFromError(error, "errorName") ?? "");
  const text = errorText(error);

  if (code === 4001 || code === "ACTION_REJECTED" || text.includes("user rejected")) {
    return { code: "WALLET_REJECTED", message: ERROR_MESSAGES.WALLET_REJECTED };
  }
  if (
    text.includes("insufficient funds") ||
    text.includes("insufficient balance") ||
    text.includes("exceeds the balance")
  ) {
    return { code: "MISSING_MON", message: ERROR_MESSAGES.MISSING_MON };
  }
  if (
    code === -32601 ||
    text.includes("debug_getrawheader") ||
    text.includes("method not found")
  ) {
    return {
      code: "RAW_HEADER_UNAVAILABLE",
      message: ERROR_MESSAGES.RAW_HEADER_UNAVAILABLE,
    };
  }
  if (errorName === "RequestProofExpired" || errorName === "RequestExpired") {
    return { code: "PROOF_EXPIRED", message: ERROR_MESSAGES.PROOF_EXPIRED };
  }
  if (
    errorName === "AlreadyFinalized" ||
    errorName === "AlreadyExpired" ||
    text.includes("already finalized") ||
    text.includes("already expired")
  ) {
    return { code: "DUPLICATE_STATE", message: ERROR_MESSAGES.DUPLICATE_STATE };
  }

  return { code: "UNKNOWN", message: ERROR_MESSAGES.UNKNOWN };
}

export function asRandomnessClientError(
  error: unknown,
  fallbackCode: RandomnessErrorCode = "UNKNOWN",
): RandomnessClientError {
  if (error instanceof RandomnessClientError) return error;
  const mapped = mapClientError(error);
  const chosen =
    mapped.code === "UNKNOWN"
      ? { code: fallbackCode, message: ERROR_MESSAGES[fallbackCode] }
      : mapped;
  return new RandomnessClientError(chosen.code, chosen.message, { cause: error });
}

export function getInjectedProvider(): InjectedWalletProvider {
  const ethereum = (globalThis as { ethereum?: InjectedWalletProvider }).ethereum;
  if (!ethereum?.request) {
    throw new RandomnessClientError("NO_WALLET", ERROR_MESSAGES.NO_WALLET);
  }
  return ethereum;
}

export async function ensureMonadTestnet(provider: InjectedWalletProvider): Promise<void> {
  try {
    const currentChain = await provider.request({ method: "eth_chainId" });
    if (String(currentChain).toLowerCase() === MONAD_TESTNET_CHAIN_HEX) return;

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_TESTNET_CHAIN_HEX }],
      });
    } catch (error) {
      if (propertyFromError(error, "code") !== 4902) {
        throw asRandomnessClientError(error, "WRONG_NETWORK");
      }

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: MONAD_TESTNET_CHAIN_HEX,
            chainName: monadTestnet.name,
            nativeCurrency: monadTestnet.nativeCurrency,
            rpcUrls: [MONAD_RPC_URL],
            blockExplorerUrls: [MONAD_EXPLORER_URL],
          },
        ],
      });
    }
  } catch (error) {
    throw asRandomnessClientError(error, "WRONG_NETWORK");
  }
}

export async function connectMonadWallet(
  provider: InjectedWalletProvider = getInjectedProvider(),
): Promise<Address> {
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new RandomnessClientError("NO_WALLET", ERROR_MESSAGES.NO_WALLET);
    }
    const account = getAddress(accounts[0]);
    await ensureMonadTestnet(provider);
    return account;
  } catch (error) {
    throw asRandomnessClientError(error);
  }
}

export function createMonadPublicClient() {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });
}

export function createMonadWalletClient(provider: InjectedWalletProvider, account: Address) {
  return createWalletClient({
    account,
    chain: monadTestnet,
    transport: custom(provider as EIP1193Provider),
  });
}

export type MonadPublicClient = ReturnType<typeof createMonadPublicClient>;
export type MonadWalletClient = ReturnType<typeof createMonadWalletClient>;

export function requireContractAddress(value: string): Address {
  try {
    return getAddress(value);
  } catch (error) {
    throw new RandomnessClientError("INVALID_ADDRESS", ERROR_MESSAGES.INVALID_ADDRESS, {
      cause: error,
    });
  }
}

function requireTransactionHash(value: string): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RandomnessClientError(
      "INVALID_TRANSACTION_HASH",
      ERROR_MESSAGES.INVALID_TRANSACTION_HASH,
    );
  }
  return value as Hash;
}

export function addressExplorerUrl(address: string): string {
  return `${MONAD_EXPLORER_URL}/address/${requireContractAddress(address)}`;
}

export function transactionExplorerUrl(transactionHash: string): string {
  return `${MONAD_EXPLORER_URL}/tx/${requireTransactionHash(transactionHash)}`;
}
