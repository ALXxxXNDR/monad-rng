"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, getAddress } from "viem";
import type { Address, Hash } from "viem";

import {
  MONAD_EXPLORER_URL,
  MONAD_FAUCET_URL,
  MONAD_TESTNET_CHAIN_ID,
  addressExplorerUrl,
  connectMonadWallet,
  createMonadPublicClient,
  createMonadWalletClient,
  ensureMonadTestnet,
  getInjectedProvider,
  mapClientError,
  transactionExplorerUrl,
} from "../lib/network";
import type { InjectedWalletProvider } from "../lib/network";
import {
  assertCompatibleContract,
  calculateReadiness,
  deployDemoPlatform,
  expireRandomnessRequest,
  fetchRawHeaders,
  finalizeRandomnessTx,
  readRandomnessResult,
  recoverDemoDeployment,
  recoverRandomnessExpiryTx,
  recoverRandomnessFinalizationTx,
  recoverRandomnessRequestTx,
  requestRandomnessTx,
} from "../lib/randomness";
import type {
  RandomnessRequest,
  RequestReadiness,
} from "../lib/randomness";
import {
  forgetPendingTransaction,
  loadStoredState,
  readPendingTransactions,
  rememberDemoContract,
  rememberPendingTransaction,
  rememberRequest,
  runWithPendingWriteLock,
  runWithStoredStateMutationLock,
  subscribeToStoredState,
} from "../lib/storage";
import type {
  LockManagerLike,
  PendingWriteLockResult,
  StorageEventTargetLike,
  StoredLocalState,
  StoredPendingTransaction,
  StoredRequestReference,
} from "../lib/storage";

type FlowState =
  | "disconnected"
  | "wrong-network"
  | "ready"
  | "deploying"
  | "requesting"
  | "waiting"
  | "finalizing"
  | "rescue-ready"
  | "safety-cutoff"
  | "submitted"
  | "busy"
  | "proof-expired"
  | "expiring"
  | "expired"
  | "finalized"
  | "error";
type ResultRead = Awaited<ReturnType<typeof readRandomnessResult>>;
type WalletEventName = "accountsChanged" | "chainChanged" | "disconnect";
type WalletEventListener = (...args: unknown[]) => void;
type WalletEventProvider = InjectedWalletProvider & {
  on?: (event: WalletEventName, listener: WalletEventListener) => void;
  removeListener?: (
    event: WalletEventName,
    listener: WalletEventListener,
  ) => void;
};
export interface WorkspaceOperationIdentity {
  epoch: number;
  contractAddress?: string;
  requestId?: string;
}
export interface PendingActionIdentity {
  kind: StoredPendingTransaction["kind"];
  chainId: number;
  contractAddress?: string;
  requestId?: string;
  requester?: string;
}
export interface VisibleTransactionHashes {
  deploymentHash?: Hash;
  tx1Hash?: Hash;
  tx2Hash?: Hash;
  expiryHash?: Hash;
}

const EMPTY_LOCAL_STATE: StoredLocalState = {
  version: 2,
  demoContracts: [],
  recentRequests: [],
  pendingTransactions: [],
};
const BLOCK_TIME_ESTIMATE_SECONDS = 0.3;
export const BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS = BigInt(64);

export function proofSafetyCutoffBlock(
  lastProofValidBlock: bigint,
): bigint {
  return lastProofValidBlock > BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS
    ? lastProofValidBlock - BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS
    : BigInt(0);
}

export function isBrowserProofCutoff(
  readiness: Pick<
    RequestReadiness,
    "phase" | "lastProofValidBlock" | "firstExpiryBlock"
  >,
  currentBlock: bigint | undefined,
): boolean {
  if (
    currentBlock === undefined ||
    readiness.phase === "finalized" ||
    readiness.phase === "expired" ||
    readiness.phase === "proof-expired" ||
    currentBlock >= readiness.firstExpiryBlock
  ) {
    return false;
  }
  return currentBlock >= proofSafetyCutoffBlock(readiness.lastProofValidBlock);
}

export function preferredScrollBehavior(
  prefersReducedMotion: boolean,
): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

export function workspaceOperationMatches(
  captured: WorkspaceOperationIdentity,
  current: WorkspaceOperationIdentity,
): boolean {
  return (
    captured.epoch === current.epoch &&
    captured.contractAddress === current.contractAddress &&
    captured.requestId === current.requestId
  );
}

export function recoveryWorkspaceMayApply(
  capturedSelectionEpoch: number,
  currentSelectionEpoch: number,
  capturedWorkspace: WorkspaceOperationIdentity,
  currentWorkspace: WorkspaceOperationIdentity,
): boolean {
  return (
    capturedSelectionEpoch === currentSelectionEpoch &&
    workspaceOperationMatches(capturedWorkspace, currentWorkspace)
  );
}

export function pendingMatchesAction(
  pending: StoredPendingTransaction,
  action: PendingActionIdentity,
): boolean {
  if (pending.kind !== action.kind || pending.chainId !== action.chainId) {
    return false;
  }
  if (pending.kind === "deployment") return true;
  if (
    !action.contractAddress ||
    pending.contractAddress.toLowerCase() !==
      action.contractAddress.toLowerCase()
  ) {
    return false;
  }
  if (pending.kind === "request") {
    if (!pending.requester || !action.requester) return true;
    return pending.requester.toLowerCase() === action.requester.toLowerCase();
  }
  return pending.requestId === action.requestId;
}

export function pendingFailureDisposition(
  errorCode: string,
): "forget" | "retain" {
  return errorCode === "TRANSACTION_REVERTED" ||
    errorCode === "TRANSACTION_REPLACED"
    ? "forget"
    : "retain";
}

export function visibleHashesAfterConfirmedRevert(
  kind: StoredPendingTransaction["kind"],
  visible: VisibleTransactionHashes,
  saved: VisibleTransactionHashes,
): VisibleTransactionHashes {
  if (kind === "deployment") {
    return { ...visible, deploymentHash: saved.deploymentHash };
  }
  if (kind === "request") {
    return { ...visible, tx1Hash: saved.tx1Hash };
  }
  if (kind === "finalization") {
    return { ...visible, tx2Hash: saved.tx2Hash };
  }
  return { ...visible, expiryHash: saved.expiryHash };
}

function normalizedWorkspaceIdentity(
  epoch: number,
  contractAddress?: string,
  requestId?: bigint,
): WorkspaceOperationIdentity {
  return {
    epoch,
    contractAddress: contractAddress?.toLowerCase(),
    requestId: requestId?.toString(),
  };
}

function walletAccountFrom(value: unknown): Address | undefined {
  if (!Array.isArray(value) || typeof value[0] !== "string") return undefined;
  try {
    return getAddress(value[0]);
  } catch {
    return undefined;
  }
}

function isMonadChainValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return BigInt(value) === BigInt(MONAD_TESTNET_CHAIN_ID);
  } catch {
    return false;
  }
}

function shorten(value: string, start = 7, end = 5): string {
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function formatBlock(value: bigint | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function formatPrice(value: bigint | undefined): string {
  if (value === undefined) return "—";
  return `${formatEther(value)} MON`;
}

function blockExplorerUrl(blockNumber: bigint): string {
  return `${MONAD_EXPLORER_URL}/block/${blockNumber}`;
}

function localStorageOrUndefined(): Storage | undefined {
  return typeof globalThis.localStorage === "undefined"
    ? undefined
    : globalThis.localStorage;
}

function browserLockManager(): LockManagerLike | undefined {
  return typeof navigator === "undefined" || !navigator.locks
    ? undefined
    : (navigator.locks as unknown as LockManagerLike);
}

function findLocalReference(
  localState: StoredLocalState,
  contractAddress: string,
  requestId: bigint,
): StoredRequestReference | undefined {
  return localState.recentRequests.find(
    (item) =>
      item.chainId === MONAD_TESTNET_CHAIN_ID &&
      item.contractAddress.toLowerCase() === contractAddress.toLowerCase() &&
      item.requestId === requestId.toString(),
  );
}

function flowFromReadiness(
  readiness: RequestReadiness,
  hasRequesterAccess: boolean,
  currentBlock?: bigint,
): FlowState {
  if (readiness.phase === "finalized") return "finalized";
  if (readiness.phase === "expired") return "expired";
  if (readiness.phase === "proof-expired") return "proof-expired";
  if (isBrowserProofCutoff(readiness, currentBlock)) return "safety-cutoff";
  if (readiness.phase === "permissionless") return "rescue-ready";
  if (
    readiness.phase === "requester" &&
    readiness.canFinalize &&
    hasRequesterAccess
  ) {
    return "ready";
  }
  return "waiting";
}

function flowForWalletSnapshot(
  request: RandomnessRequest | undefined,
  currentBlock: bigint | undefined,
  account: Address | undefined,
  isMonadChain: boolean,
): FlowState {
  if (!account) return "disconnected";
  if (!isMonadChain) return "wrong-network";
  if (!request || currentBlock === undefined) return "ready";
  const readiness = calculateReadiness(request, currentBlock, account);
  return flowFromReadiness(
    readiness,
    account.toLowerCase() === request.requester.toLowerCase(),
    currentBlock,
  );
}

function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button className="copy-button" type="button" onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

function DataValue({
  label,
  value,
  copyValue,
  href,
}: {
  label: string;
  value: string;
  copyValue?: string;
  href?: string;
}) {
  return (
    <div className="data-value">
      <dt>{label}</dt>
      <dd>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
            <span aria-hidden="true"> ↗</span>
          </a>
        ) : (
          <span>{value}</span>
        )}
        {copyValue ? <CopyButton value={copyValue} /> : null}
      </dd>
    </div>
  );
}

function ResultCard({
  idPrefix,
  title,
  result,
  tx1Hash,
  tx2Hash,
  expiryHash,
}: {
  idPrefix: string;
  title: string;
  result?: ResultRead;
  tx1Hash?: Hash;
  tx2Hash?: Hash;
  expiryHash?: Hash;
}) {
  const emptyTitleId = `${idPrefix}-result-title`;
  const expiredTitleId = `${idPrefix}-expired-title`;
  const pendingTitleId = `${idPrefix}-pending-title`;
  const verifiedTitleId = `${idPrefix}-verified-title`;

  if (!result) {
    return (
      <section
        className="result-card result-card--empty"
        aria-labelledby={emptyTitleId}
      >
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Permanent output</p>
            <h3 id={emptyTitleId}>{title}</h3>
          </div>
          <span className="status-pill status-pill--idle">Awaiting Tx2</span>
        </div>
        <p className="muted">
          No result is shown until three canonical headers are authenticated and
          Tx2 stores the seed on-chain.
        </p>
        <dl className="result-anatomy">
          <DataValue label="32-byte seed" value="Available after Tx2" />
          <DataValue label="1–100 draw" value="Unbiased on-chain draw" />
          <DataValue label="Requester" value="Locked by Tx1" />
          <DataValue label="Finalizer" value="Recorded by Tx2" />
        </dl>
      </section>
    );
  }

  const { request, contractAddress, requestId } = result;
  if (request.expired) {
    return (
      <section
        className="result-card result-card--expired"
        aria-labelledby={expiredTitleId}
      >
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Permanent status</p>
            <h3 id={expiredTitleId}>Expired — no result exists</h3>
          </div>
          <span className="status-pill status-pill--expired">Expired</span>
        </div>
        <p>
          The first target left the proof window before Tx2. The contract released
          one pending slot for this platform, with no refund or cleanup reward. It
          did not fabricate a seed or draw.
        </p>
        <dl className="result-grid">
          <DataValue
            label="Contract"
            value={shorten(contractAddress)}
            copyValue={contractAddress}
            href={addressExplorerUrl(contractAddress)}
          />
          <DataValue label="Request ID" value={requestId.toString()} />
          <DataValue
            label="Requester"
            value={shorten(request.requester)}
            copyValue={request.requester}
            href={addressExplorerUrl(request.requester)}
          />
          <DataValue
            label="Expiry transaction"
            value={expiryHash ? shorten(expiryHash) : "Not saved on this device"}
            copyValue={expiryHash}
            href={expiryHash ? transactionExplorerUrl(expiryHash) : undefined}
          />
        </dl>
      </section>
    );
  }

  if (!request.finalized) {
    return (
      <section
        className="result-card result-card--pending"
        aria-labelledby={pendingTitleId}
      >
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Locked request</p>
            <h3 id={pendingTitleId}>
              Request #{requestId.toString()} is pending
            </h3>
          </div>
          <span className="status-pill status-pill--waiting">Waiting</span>
        </div>
        <p className="muted">
          The requester and all three target blocks are fixed. The future result
          cannot be known from this pending record.
        </p>
        <dl className="result-grid">
          <DataValue
            label="Contract"
            value={shorten(contractAddress)}
            copyValue={contractAddress}
            href={addressExplorerUrl(contractAddress)}
          />
          <DataValue
            label="Requester"
            value={shorten(request.requester)}
            copyValue={request.requester}
          />
          <DataValue label="Price locked" value={formatPrice(request.pricePaid)} />
          <DataValue
            label="Target blocks"
            value={`${formatBlock(request.firstTargetBlock)} · ${formatBlock(
              request.secondTargetBlock,
            )} · ${formatBlock(request.thirdTargetBlock)}`}
            copyValue={`${request.firstTargetBlock},${request.secondTargetBlock},${request.thirdTargetBlock}`}
          />
        </dl>
      </section>
    );
  }

  return (
    <section
      className="result-card result-card--verified"
      aria-labelledby={verifiedTitleId}
    >
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Permanent on-chain result</p>
          <h3 id={verifiedTitleId}>{title}</h3>
        </div>
        <span className="status-pill status-pill--verified">
          <span aria-hidden="true">✓</span> Canonical headers verified
        </span>
      </div>

      <div className="draw-display">
        <span>1–100 draw</span>
        <strong>{result.drawOneBased ?? "—"}</strong>
        <small>deterministic rejection sampling</small>
      </div>

      <dl className="result-grid">
        <DataValue
          label="32-byte seed"
          value={request.result}
          copyValue={request.result}
        />
        <DataValue label="Request ID" value={requestId.toString()} />
        <DataValue
          label="Requester"
          value={shorten(request.requester)}
          copyValue={request.requester}
          href={addressExplorerUrl(request.requester)}
        />
        <DataValue
          label="Finalizer"
          value={shorten(request.finalizer)}
          copyValue={request.finalizer}
          href={addressExplorerUrl(request.finalizer)}
        />
        <DataValue
          label="Contract"
          value={shorten(contractAddress)}
          copyValue={contractAddress}
          href={addressExplorerUrl(contractAddress)}
        />
        <DataValue label="Chain" value="Monad testnet · 10143" />
        <DataValue
          label="Target 01"
          value={formatBlock(request.firstTargetBlock)}
          copyValue={request.firstTargetBlock.toString()}
          href={blockExplorerUrl(request.firstTargetBlock)}
        />
        <DataValue
          label="Target 02"
          value={formatBlock(request.secondTargetBlock)}
          copyValue={request.secondTargetBlock.toString()}
          href={blockExplorerUrl(request.secondTargetBlock)}
        />
        <DataValue
          label="Target 03"
          value={formatBlock(request.thirdTargetBlock)}
          copyValue={request.thirdTargetBlock.toString()}
          href={blockExplorerUrl(request.thirdTargetBlock)}
        />
        <DataValue
          label="Request transaction"
          value={tx1Hash ? shorten(tx1Hash) : "Not saved on this device"}
          copyValue={tx1Hash}
          href={tx1Hash ? transactionExplorerUrl(tx1Hash) : undefined}
        />
        <DataValue
          label="Finalization transaction"
          value={tx2Hash ? shorten(tx2Hash) : "Not saved on this device"}
          copyValue={tx2Hash}
          href={tx2Hash ? transactionExplorerUrl(tx2Hash) : undefined}
        />
        <DataValue label="Verification status" value="Stored once · immutable result" />
      </dl>
    </section>
  );
}

function StateBanner({
  flowState,
  request,
  readiness,
  currentBlock,
  errorMessage,
}: {
  flowState: FlowState;
  request?: RandomnessRequest;
  readiness?: RequestReadiness;
  currentBlock?: bigint;
  errorMessage?: string;
}) {
  const copy: Record<FlowState, { title: string; body: string }> = {
    disconnected: {
      title: "Connect a wallet to write",
      body: "The public result explorer below remains available without a wallet.",
    },
    "wrong-network": {
      title: "Switch to Monad testnet",
      body: "The wallet can add chain 10143 automatically if it is missing.",
    },
    ready: {
      title: request ? "Requester Tx2 window is open" : "Platform is ready",
      body: request
        ? "Fetch the three canonical raw headers and store the result."
        : "Submit Tx1 to lock one request and three future block targets.",
    },
    deploying: {
      title: "Deploying your isolated instance",
      body: "Confirm the transaction in your wallet. You pay only Monad network gas.",
    },
    requesting: {
      title: "Locking Tx1",
      body: "The current platform price, requester, and targets are being committed.",
    },
    waiting: {
      title: "Future blocks are still arriving",
      body: readiness
        ? `${readiness.blocksRemaining.toString()} blocks remain before requester Tx2.`
        : "The page follows the current block from the public Monad RPC.",
    },
    finalizing: {
      title: "Authenticating three headers",
      body: "Tx2 will store one permanent seed if every header matches the canonical chain.",
    },
    "rescue-ready": {
      title: "Permissionless rescue is open",
      body: "Anyone may submit Tx2 now. The original requester and resulting seed cannot change.",
    },
    "safety-cutoff": {
      title: "Demo Tx2 safety stop",
      body: readiness
        ? `This demo stops Tx2 64 blocks early to avoid a paid revert. On-chain proof remains valid through exact block ${formatBlock(
            readiness.lastProofValidBlock,
          )}. Advanced callers may use the contract directly.`
        : "This demo stops Tx2 64 blocks early to avoid a paid revert. Advanced callers may use the contract directly while the on-chain proof remains valid.",
    },
    submitted: {
      title: "Transaction submitted",
      body: "Its hash is saved in this browser. Check the submitted transaction before sending the same action again.",
    },
    busy: {
      title: "This action is open in another tab",
      body: "Wait for that tab to save its transaction hash, then check the submitted action or try again.",
    },
    "proof-expired": {
      title: "The proof window has closed",
      body: "No result can be authenticated. Anyone may mark this request expired without a refund or reward.",
    },
    expiring: {
      title: "Releasing this platform's pending slot",
      body: "The expiry transaction records no seed and transfers no value.",
    },
    expired: {
      title: "Expired permanently",
      body: "The local pending slot is released. There is no random result to redeem.",
    },
    finalized: {
      title: "Result stored permanently",
      body: "The seed and unbiased bounded draw remain readable after the header history window closes.",
    },
    error: {
      title: "The last action did not complete",
      body: errorMessage ?? "Review the message and retry the same safe action.",
    },
  };

  return (
    <div className={`state-banner state-banner--${flowState}`}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <span className="state-dot" aria-hidden="true" />
        <strong>{copy[flowState].title}</strong>
      </div>
      <p>{copy[flowState].body}</p>
      <span className="block-readout">
        Current block <b>{formatBlock(currentBlock)}</b>
      </span>
    </div>
  );
}

export function RandomnessDemo() {
  const publicClient = useMemo(() => createMonadPublicClient(), []);
  const [flowState, setFlowState] = useState<FlowState>("disconnected");
  const [provider, setProvider] = useState<InjectedWalletProvider>();
  const [account, setAccount] = useState<Address>();
  const [isMonadChain, setIsMonadChain] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [contractInput, setContractInput] = useState("");
  const [activeContract, setActiveContract] = useState<Address>();
  const [deploymentHash, setDeploymentHash] = useState<Hash>();
  const [requestId, setRequestId] = useState<bigint>();
  const [request, setRequest] = useState<RandomnessRequest>();
  const [activeResult, setActiveResult] = useState<ResultRead>();
  const [tx1Hash, setTx1Hash] = useState<Hash>();
  const [tx2Hash, setTx2Hash] = useState<Hash>();
  const [expiryHash, setExpiryHash] = useState<Hash>();
  const [currentBlock, setCurrentBlock] = useState<bigint>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [localState, setLocalState] =
    useState<StoredLocalState>(EMPTY_LOCAL_STATE);
  const [explorerContract, setExplorerContract] = useState("");
  const [explorerRequestId, setExplorerRequestId] = useState("");
  const [explorerResult, setExplorerResult] = useState<ResultRead>();
  const [explorerError, setExplorerError] = useState<string>();
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [submittedTransactionHash, setSubmittedTransactionHash] =
    useState<Hash>();
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const accountRef = useRef<Address | undefined>(undefined);
  const isMonadChainRef = useRef(false);
  const requestRef = useRef<RandomnessRequest | undefined>(undefined);
  const currentBlockRef = useRef<bigint | undefined>(undefined);
  const writeBusyRef = useRef(false);
  const selectionEpochRef = useRef(0);
  const explorerEpochRef = useRef(0);
  const recoveryBusyRef = useRef(false);
  const workspaceIdentityRef = useRef<WorkspaceOperationIdentity>(
    normalizedWorkspaceIdentity(0),
  );

  const latestLocalRequest = useMemo(
    () =>
      localState.recentRequests.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      ),
    [localState],
  );

  const monadPendingTransactions = useMemo(
    () =>
      localState.pendingTransactions.filter(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      ),
    [localState.pendingTransactions],
  );
  const submittedPending = useMemo(
    () =>
      monadPendingTransactions.find(
        (item) => item.transactionHash === submittedTransactionHash,
      ) ?? monadPendingTransactions[0],
    [monadPendingTransactions, submittedTransactionHash],
  );
  const pendingDeployment = useMemo(
    () =>
      monadPendingTransactions.find((item) =>
        pendingMatchesAction(item, {
          kind: "deployment",
          chainId: MONAD_TESTNET_CHAIN_ID,
        }),
      ),
    [monadPendingTransactions],
  );
  const pendingRequest = useMemo(
    () =>
      activeContract
        ? monadPendingTransactions.find((item) =>
            pendingMatchesAction(item, {
              kind: "request",
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: activeContract,
              requester: account,
            }),
          )
        : undefined,
    [account, activeContract, monadPendingTransactions],
  );
  const pendingFinalization = useMemo(
    () =>
      activeContract && requestId !== undefined
        ? monadPendingTransactions.find((item) =>
            pendingMatchesAction(item, {
              kind: "finalization",
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: activeContract,
              requestId: requestId.toString(),
            }),
          )
        : undefined,
    [activeContract, monadPendingTransactions, requestId],
  );
  const pendingExpiry = useMemo(
    () =>
      activeContract && requestId !== undefined
        ? monadPendingTransactions.find((item) =>
            pendingMatchesAction(item, {
              kind: "expiry",
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: activeContract,
              requestId: requestId.toString(),
            }),
          )
        : undefined,
    [activeContract, monadPendingTransactions, requestId],
  );

  const readiness = useMemo(
    () =>
      request && currentBlock !== undefined
        ? calculateReadiness(request, currentBlock, account)
        : undefined,
    [account, currentBlock, request],
  );

  const estimatedSeconds =
    readiness?.blocksRemaining && readiness.blocksRemaining > BigInt(0)
      ? Math.ceil(
          Number(
            readiness.blocksRemaining > BigInt(10_000)
              ? BigInt(10_000)
              : readiness.blocksRemaining,
          ) * BLOCK_TIME_ESTIMATE_SECONDS,
        )
      : 0;

  const handleFailure = useCallback(
    (error: unknown, identity?: WorkspaceOperationIdentity) => {
      if (
        identity &&
        !workspaceOperationMatches(identity, workspaceIdentityRef.current)
      ) {
        return;
      }
      const mapped = mapClientError(error);
      const message =
        mapped.code === "UNKNOWN" && error instanceof Error
          ? error.message
          : mapped.message;
      if (mapped.code === "WRONG_NETWORK") {
        isMonadChainRef.current = false;
        setIsMonadChain(false);
      }
      setErrorMessage(message);
      setFlowState(
        mapped.code === "WRONG_NETWORK" ||
          (accountRef.current && !isMonadChainRef.current)
          ? "wrong-network"
          : !accountRef.current
            ? "disconnected"
            : "error",
      );
    },
    [],
  );

  function beginWrite(): boolean {
    if (writeBusyRef.current || recoveryBusyRef.current) return false;
    writeBusyRef.current = true;
    selectionEpochRef.current += 1;
    explorerEpochRef.current += 1;
    setWriteBusy(true);
    setExplorerLoading(false);
    return true;
  }

  function finishWrite(): void {
    writeBusyRef.current = false;
    setWriteBusy(false);
  }

  function applyLocalState(
    next: StoredLocalState,
    preferredTransactionHash?: Hash,
  ): void {
    setLocalState(next);
    const nextSubmitted =
      next.pendingTransactions.find(
        (item) =>
          item.chainId === MONAD_TESTNET_CHAIN_ID &&
          item.transactionHash === preferredTransactionHash,
      ) ??
      next.pendingTransactions.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
    setSubmittedTransactionHash(nextSubmitted?.transactionHash);
  }

  useEffect(() => subscribeToStoredState(
    globalThis as unknown as StorageEventTargetLike,
    localStorageOrUndefined(),
    (next) => {
      setLocalState(next);
      const nextPending = next.pendingTransactions.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
      setSubmittedTransactionHash((current) =>
        next.pendingTransactions.some(
          (item) =>
            item.chainId === MONAD_TESTNET_CHAIN_ID &&
            item.transactionHash === current,
        )
          ? current
          : nextPending?.transactionHash,
      );
      if (writeBusyRef.current || recoveryBusyRef.current) return;
      setFlowState((current) =>
        nextPending
          ? "submitted"
          : current === "submitted"
            ? flowForWalletSnapshot(
                requestRef.current,
                currentBlockRef.current,
                accountRef.current,
                isMonadChainRef.current,
              )
            : current,
      );
    },
  ), []);

  function handleBlockedWrite(
    result: Exclude<
      PendingWriteLockResult<unknown>,
      { status: "completed"; value: unknown }
    >,
  ): void {
    if (result.status === "pending") {
      const latest = loadStoredState(localStorageOrUndefined());
      applyLocalState(latest, result.pending.transactionHash);
      setErrorMessage(
        "This exact action is already submitted in another tab. Check the saved transaction before submitting it again.",
      );
      setFlowState("submitted");
      return;
    }
    if (result.status === "busy") {
      setErrorMessage(
        "Another tab is already preparing this exact action. Wait for that tab to save its transaction hash, then try again.",
      );
      setFlowState("busy");
      return;
    }
    setErrorMessage(
      "This browser cannot safely coordinate paid transactions across tabs. Read-only exploration and saved-transaction recovery remain available; use a browser with Web Locks to submit.",
    );
    setFlowState("error");
  }

  async function handleSubmittedFailure(
    error: unknown,
    transactionHash: Hash,
    identity?: WorkspaceOperationIdentity,
  ): Promise<void> {
    if (
      identity &&
      !workspaceOperationMatches(identity, workspaceIdentityRef.current)
    ) {
      return;
    }
    const mapped = mapClientError(error);
    if (pendingFailureDisposition(mapped.code) === "forget") {
      const storage = localStorageOrUndefined();
      const { storedBeforeForget, next } =
        await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () => {
            const storedBeforeForget = loadStoredState(storage);
            const next = forgetPendingTransaction(storage, transactionHash);
            return { storedBeforeForget, next };
          },
        });
      const revertedPending = storedBeforeForget.pendingTransactions.find(
        (item) => item.transactionHash === transactionHash,
      );
      applyLocalState(next);
      let restoreKind: StoredPendingTransaction["kind"] | undefined;
      let savedHashes: VisibleTransactionHashes = {};
      if (revertedPending?.kind === "deployment") {
        const currentContract = workspaceIdentityRef.current.contractAddress;
        const savedDemo = storedBeforeForget.demoContracts.find(
          (item) =>
            item.chainId === MONAD_TESTNET_CHAIN_ID &&
            item.contractAddress.toLowerCase() === currentContract,
        );
        restoreKind = revertedPending.kind;
        savedHashes = { deploymentHash: savedDemo?.deploymentTxHash };
      } else if (
        revertedPending &&
        workspaceIdentityRef.current.contractAddress ===
          revertedPending.contractAddress.toLowerCase()
      ) {
        const currentRequestId = workspaceIdentityRef.current.requestId;
        const savedReference =
          currentRequestId === undefined
            ? undefined
            : findLocalReference(
                storedBeforeForget,
                revertedPending.contractAddress,
                BigInt(currentRequestId),
              );
        if (revertedPending.kind === "request") {
          restoreKind = revertedPending.kind;
          savedHashes = { tx1Hash: savedReference?.tx1Hash };
        } else if (revertedPending.requestId === currentRequestId) {
          restoreKind = revertedPending.kind;
          savedHashes =
            revertedPending.kind === "finalization"
              ? { tx2Hash: savedReference?.tx2Hash }
              : { expiryHash: savedReference?.expiryHash };
        }
      }
      if (restoreKind) {
        const restored = visibleHashesAfterConfirmedRevert(
          restoreKind,
          { deploymentHash, tx1Hash, tx2Hash, expiryHash },
          savedHashes,
        );
        if (restoreKind === "deployment") {
          setDeploymentHash(restored.deploymentHash);
        } else if (restoreKind === "request") {
          setTx1Hash(restored.tx1Hash);
        } else if (restoreKind === "finalization") {
          setTx2Hash(restored.tx2Hash);
        } else {
          setExpiryHash(restored.expiryHash);
        }
      }
      setErrorMessage(
        mapped.code === "TRANSACTION_REPLACED"
          ? "The submitted transaction was confirmed as cancelled or replaced by a different transaction. This exact action is safe to submit again."
          : "The submitted transaction was confirmed as reverted. This exact action is safe to submit again.",
      );
      setFlowState(
        next.pendingTransactions.some(
          (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
        )
          ? "submitted"
          : flowForWalletSnapshot(
              requestRef.current,
              currentBlockRef.current,
              accountRef.current,
              isMonadChainRef.current,
            ),
      );
      return;
    }
    setSubmittedTransactionHash(transactionHash);
    setErrorMessage(
      `${mapped.message} The submitted hash remains saved; check it before sending the same action again.`,
    );
    setFlowState("submitted");
  }

  async function prepareWalletWrite(
    walletProvider: InjectedWalletProvider,
  ): Promise<Address> {
    await ensureMonadTestnet(walletProvider);
    const accounts = await walletProvider.request({ method: "eth_accounts" });
    const currentAccount = walletAccountFrom(accounts);
    if (!currentAccount) {
      accountRef.current = undefined;
      setAccount(undefined);
      throw new Error("Reconnect your wallet before writing.");
    }
    accountRef.current = currentAccount;
    isMonadChainRef.current = true;
    setProvider(walletProvider);
    setAccount(currentAccount);
    setIsMonadChain(true);
    return currentAccount;
  }

  useEffect(() => {
    const hydrationTimer = globalThis.setTimeout(() => {
      const storage = localStorageOrUndefined();
      const stored = loadStoredState(storage);
      const pending = readPendingTransactions(
        storage,
        MONAD_TESTNET_CHAIN_ID,
      );
      const restoredPending = pending[0];
      setLocalState(stored);
      setSubmittedTransactionHash(restoredPending?.transactionHash);
      const saved = stored.demoContracts.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
      const newestMonadRequest = stored.recentRequests.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
      const pendingContract =
        restoredPending && restoredPending.kind !== "deployment"
          ? restoredPending.contractAddress
          : undefined;
      const restoredContract = pendingContract ?? saved?.contractAddress;
      const restoredRequestId =
        restoredPending?.kind === "finalization" ||
        restoredPending?.kind === "expiry"
          ? BigInt(restoredPending.requestId)
          : undefined;
      if (restoredContract && !writeBusyRef.current) {
        workspaceIdentityRef.current = normalizedWorkspaceIdentity(
          workspaceIdentityRef.current.epoch + 1,
          restoredContract,
          restoredRequestId,
        );
        setActiveContract(restoredContract);
        setContractInput(restoredContract);
        setRequestId(restoredRequestId);
        requestRef.current = undefined;
        setRequest(undefined);
        setActiveResult(undefined);
        const restoredReference =
          restoredRequestId === undefined
            ? undefined
            : findLocalReference(
                stored,
                restoredContract,
                restoredRequestId,
              );
        setTx1Hash(
          restoredPending?.kind === "request"
            ? restoredPending.transactionHash
            : restoredReference?.tx1Hash,
        );
        setTx2Hash(
          restoredPending?.kind === "finalization"
            ? restoredPending.transactionHash
            : restoredReference?.tx2Hash,
        );
        setExpiryHash(
          restoredPending?.kind === "expiry"
            ? restoredPending.transactionHash
            : restoredReference?.expiryHash,
        );
        setDeploymentHash(
          restoredPending?.kind === "deployment"
            ? restoredPending.transactionHash
            : saved?.contractAddress === restoredContract
              ? saved.deploymentTxHash
              : undefined,
        );
      } else if (restoredPending?.kind === "deployment") {
        setDeploymentHash(restoredPending.transactionHash);
      }
      if (newestMonadRequest) {
        setExplorerContract(newestMonadRequest.contractAddress);
        setExplorerRequestId(newestMonadRequest.requestId);
      }
      if (restoredPending) setFlowState("submitted");
    }, 0);
    return () => globalThis.clearTimeout(hydrationTimer);
  }, []);

  useEffect(() => {
    if (!provider) return;
    const eventProvider = provider as WalletEventProvider;
    let live = true;

    const handleAccountsChanged: WalletEventListener = () => {
      void (async () => {
        try {
          const accounts = await provider.request({ method: "eth_accounts" });
          if (!live) return;
          const currentAccount = walletAccountFrom(accounts);
          accountRef.current = currentAccount;
          setAccount(currentAccount);
          setErrorMessage(undefined);
          setFlowState(
            flowForWalletSnapshot(
              requestRef.current,
              currentBlockRef.current,
              currentAccount,
              isMonadChainRef.current,
            ),
          );
        } catch {
          if (!live) return;
          accountRef.current = undefined;
          setAccount(undefined);
          setFlowState("disconnected");
        }
      })();
    };
    const handleChainChanged: WalletEventListener = (chainValue) => {
      if (!live) return;
      const onMonad = isMonadChainValue(chainValue);
      isMonadChainRef.current = onMonad;
      setIsMonadChain(onMonad);
      if (onMonad) setErrorMessage(undefined);
      setFlowState(
        flowForWalletSnapshot(
          requestRef.current,
          currentBlockRef.current,
          accountRef.current,
          onMonad,
        ),
      );
    };
    const handleDisconnect: WalletEventListener = () => {
      if (!live) return;
      accountRef.current = undefined;
      isMonadChainRef.current = false;
      setProvider(undefined);
      setAccount(undefined);
      setIsMonadChain(false);
      setErrorMessage(undefined);
      setFlowState("disconnected");
    };

    eventProvider.on?.("accountsChanged", handleAccountsChanged);
    eventProvider.on?.("chainChanged", handleChainChanged);
    eventProvider.on?.("disconnect", handleDisconnect);
    return () => {
      live = false;
      eventProvider.removeListener?.("accountsChanged", handleAccountsChanged);
      eventProvider.removeListener?.("chainChanged", handleChainChanged);
      eventProvider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [provider]);

  useEffect(() => {
    let live = true;

    async function pollBlock() {
      try {
        const block = await publicClient.getBlockNumber();
        if (live) {
          currentBlockRef.current = block;
          setCurrentBlock(block);
        }
      } catch {
        // A transient public-RPC failure should not erase the last good block.
      }
    }

    void pollBlock();
    const interval = globalThis.setInterval(pollBlock, 1_500);
    return () => {
      live = false;
      globalThis.clearInterval(interval);
    };
  }, [publicClient]);

  useEffect(() => {
    if (!activeContract || requestId === undefined || currentBlock === undefined) {
      return;
    }
    const contractAddress = activeContract;
    const activeRequestId = requestId;
    const observedBlock = currentBlock;
    const operationIdentity = { ...workspaceIdentityRef.current };
    let live = true;

    async function refreshActiveRequest() {
      try {
        const latest = await readRandomnessResult({
          publicClient,
          contractAddress,
          requestId: activeRequestId,
        });
        if (
          !live ||
          !workspaceOperationMatches(
            operationIdentity,
            workspaceIdentityRef.current,
          )
        ) {
          return;
        }
        requestRef.current = latest.request;
        setRequest(latest.request);
        setActiveResult(latest);
        setErrorMessage(undefined);
        setFlowState((current) => {
          if (writeBusyRef.current) return current;
          return flowForWalletSnapshot(
            latest.request,
            observedBlock,
            accountRef.current,
            isMonadChainRef.current,
          );
        });
      } catch {
        // Keep the last on-chain snapshot during transient polling failures.
      }
    }

    void refreshActiveRequest();
    return () => {
      live = false;
    };
  }, [account, activeContract, currentBlock, publicClient, requestId]);

  async function handleConnect() {
    setErrorMessage(undefined);
    try {
      const injected = getInjectedProvider();
      setProvider(injected);
      const connected = await connectMonadWallet(injected);
      accountRef.current = connected;
      isMonadChainRef.current = true;
      setAccount(connected);
      setIsMonadChain(true);
      setFlowState(
        flowForWalletSnapshot(
          requestRef.current,
          currentBlockRef.current,
          connected,
          true,
        ),
      );
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleSwitchNetwork() {
    if (!provider) {
      await handleConnect();
      return;
    }
    setErrorMessage(undefined);
    try {
      await ensureMonadTestnet(provider);
      const accounts = await provider.request({ method: "eth_accounts" });
      const currentAccount =
        walletAccountFrom(accounts) ?? (await connectMonadWallet(provider));
      accountRef.current = currentAccount;
      isMonadChainRef.current = true;
      setAccount(currentAccount);
      setIsMonadChain(true);
      setFlowState(
        flowForWalletSnapshot(
          requestRef.current,
          currentBlockRef.current,
          currentAccount,
          true,
        ),
      );
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleUseContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeBusyRef.current) return;
    const selectionEpoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = selectionEpoch;
    const submittedContract = contractInput;
    setErrorMessage(undefined);
    try {
      const address = await assertCompatibleContract(
        publicClient,
        submittedContract,
      );
      if (
        selectionEpoch !== selectionEpochRef.current ||
        writeBusyRef.current
      ) {
        return;
      }
      workspaceIdentityRef.current = normalizedWorkspaceIdentity(
        workspaceIdentityRef.current.epoch + 1,
        address,
      );
      setActiveContract(address);
      setContractInput(address);
      setDeploymentHash(undefined);
      setRequestId(undefined);
      requestRef.current = undefined;
      setRequest(undefined);
      setActiveResult(undefined);
      setTx1Hash(undefined);
      setTx2Hash(undefined);
      setExpiryHash(undefined);
      const storage = localStorageOrUndefined();
      const next = await runWithStoredStateMutationLock({
        lockManager: browserLockManager(),
        mutate: () =>
          rememberDemoContract(storage, {
            chainId: MONAD_TESTNET_CHAIN_ID,
            contractAddress: address,
          }),
      });
      setLocalState(next);
      setFlowState(
        flowForWalletSnapshot(
          undefined,
          currentBlockRef.current,
          accountRef.current,
          isMonadChainRef.current,
        ),
      );
    } catch (error) {
      if (selectionEpoch !== selectionEpochRef.current) return;
      handleFailure(error);
    }
  }

  async function handleDeploy() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (pendingDeployment) {
      setSubmittedTransactionHash(pendingDeployment.transactionHash);
      setFlowState("submitted");
      return;
    }
    if (!beginWrite()) return;
    const operationIdentity = { ...workspaceIdentityRef.current };
    let broadcastHash: Hash | undefined;
    setErrorMessage(undefined);
    setFlowState("deploying");
    try {
      const currentAccount = await prepareWalletWrite(provider);
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const walletClient = createMonadWalletClient(provider, currentAccount);
      const storage = localStorageOrUndefined();
      const writeResult = await runWithPendingWriteLock({
        lockManager: browserLockManager(),
        storage,
        action: {
          kind: "deployment",
          chainId: MONAD_TESTNET_CHAIN_ID,
        },
        write: async () =>
          await deployDemoPlatform({
            walletClient,
            publicClient,
            revenueRecipient: currentAccount,
            onTransactionHash: async (transactionHash) => {
              broadcastHash = transactionHash;
              setDeploymentHash(transactionHash);
              const pendingState = await runWithStoredStateMutationLock({
                lockManager: browserLockManager(),
                mutate: () =>
                  rememberPendingTransaction(storage, {
                    kind: "deployment",
                    chainId: MONAD_TESTNET_CHAIN_ID,
                    transactionHash,
                  }),
              });
              applyLocalState(pendingState, transactionHash);
              setFlowState("submitted");
            },
          }),
      });
      if (writeResult.status !== "completed") {
        handleBlockedWrite(writeResult);
        return;
      }
      const deployed = writeResult.value;
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      workspaceIdentityRef.current = normalizedWorkspaceIdentity(
        operationIdentity.epoch + 1,
        deployed.contractAddress,
      );
      setActiveContract(deployed.contractAddress);
      setContractInput(deployed.contractAddress);
      setDeploymentHash(deployed.transactionHash);
      setRequestId(undefined);
      requestRef.current = undefined;
      setRequest(undefined);
      setActiveResult(undefined);
      setTx1Hash(undefined);
      setTx2Hash(undefined);
      setExpiryHash(undefined);
      const confirmedState = await runWithStoredStateMutationLock({
        lockManager: browserLockManager(),
        mutate: () => {
          rememberDemoContract(storage, {
            chainId: MONAD_TESTNET_CHAIN_ID,
            contractAddress: deployed.contractAddress,
            deploymentTxHash: deployed.transactionHash,
          });
          return forgetPendingTransaction(storage, deployed.transactionHash);
        },
      });
      applyLocalState(confirmedState);
      setErrorMessage(undefined);
      setFlowState(
        flowForWalletSnapshot(
          undefined,
          currentBlockRef.current,
          accountRef.current,
          isMonadChainRef.current,
        ),
      );
    } catch (error) {
      if (broadcastHash) {
        await handleSubmittedFailure(error, broadcastHash, operationIdentity);
      } else {
        handleFailure(error, operationIdentity);
      }
    } finally {
      finishWrite();
    }
  }

  async function handleRequest() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract) {
      setErrorMessage(
        "Deploy your own instance or paste the exact published PlatformRandomness contract first.",
      );
      setFlowState("error");
      return;
    }
    if (pendingRequest) {
      setSubmittedTransactionHash(pendingRequest.transactionHash);
      setFlowState("submitted");
      return;
    }
    if (!beginWrite()) return;
    const contractAddress = activeContract;
    const operationIdentity = { ...workspaceIdentityRef.current };
    let broadcastHash: Hash | undefined;
    setErrorMessage(undefined);
    setFlowState("requesting");
    try {
      const currentAccount = await prepareWalletWrite(provider);
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const walletClient = createMonadWalletClient(provider, currentAccount);
      const storage = localStorageOrUndefined();
      const writeResult = await runWithPendingWriteLock({
        lockManager: browserLockManager(),
        storage,
        action: {
          kind: "request",
          chainId: MONAD_TESTNET_CHAIN_ID,
          contractAddress,
          requester: currentAccount,
        },
        write: async () =>
          await requestRandomnessTx({
            publicClient,
            walletClient,
            account: currentAccount,
            contractAddress,
            onTransactionHash: async (transactionHash) => {
              broadcastHash = transactionHash;
              setTx1Hash(transactionHash);
              const pendingState = await runWithStoredStateMutationLock({
                lockManager: browserLockManager(),
                mutate: () =>
                  rememberPendingTransaction(storage, {
                    kind: "request",
                    chainId: MONAD_TESTNET_CHAIN_ID,
                    contractAddress,
                    requester: currentAccount,
                    transactionHash,
                  }),
              });
              applyLocalState(pendingState, transactionHash);
              setFlowState("submitted");
            },
          }),
      });
      if (writeResult.status !== "completed") {
        handleBlockedWrite(writeResult);
        return;
      }
      const locked = writeResult.value;
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const pending = await readRandomnessResult({
        publicClient,
        contractAddress,
        requestId: locked.requestId,
      });
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      workspaceIdentityRef.current = normalizedWorkspaceIdentity(
        operationIdentity.epoch + 1,
        contractAddress,
        locked.requestId,
      );
      setRequestId(locked.requestId);
      requestRef.current = pending.request;
      setRequest(pending.request);
      setActiveResult(pending);
      setTx1Hash(locked.transactionHash);
      setTx2Hash(undefined);
      setExpiryHash(undefined);
      const confirmedState = await runWithStoredStateMutationLock({
        lockManager: browserLockManager(),
        mutate: () => {
          rememberRequest(storage, {
            chainId: MONAD_TESTNET_CHAIN_ID,
            contractAddress,
            requestId: locked.requestId,
            tx1Hash: locked.transactionHash,
          });
          return forgetPendingTransaction(storage, locked.transactionHash);
        },
      });
      applyLocalState(confirmedState);
      setErrorMessage(undefined);
      setFlowState(
        flowForWalletSnapshot(
          pending.request,
          currentBlockRef.current,
          accountRef.current,
          isMonadChainRef.current,
        ),
      );
    } catch (error) {
      if (broadcastHash) {
        await handleSubmittedFailure(error, broadcastHash, operationIdentity);
      } else {
        handleFailure(error, operationIdentity);
      }
    } finally {
      finishWrite();
    }
  }

  async function handleFinalize() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract || requestId === undefined || !request) return;

    if (pendingFinalization) {
      setSubmittedTransactionHash(pendingFinalization.transactionHash);
      setFlowState("submitted");
      return;
    }
    if (!beginWrite()) return;
    const contractAddress = activeContract;
    const activeRequestId = requestId;
    const activeRequest = request;
    const storedTx1Hash = tx1Hash ?? activeReference?.tx1Hash;
    const operationIdentity = { ...workspaceIdentityRef.current };
    let broadcastHash: Hash | undefined;
    setErrorMessage(undefined);
    setFlowState("finalizing");
    try {
      const initialHead = await publicClient.getBlockNumber();
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      currentBlockRef.current = initialHead;
      setCurrentBlock(initialHead);
      const initialReadiness = calculateReadiness(
        activeRequest,
        initialHead,
        accountRef.current,
      );
      if (initialReadiness.phase === "proof-expired") {
        setFlowState(
          flowForWalletSnapshot(
            activeRequest,
            initialHead,
            accountRef.current,
            isMonadChainRef.current,
          ),
        );
        return;
      }
      if (isBrowserProofCutoff(initialReadiness, initialHead)) {
        setFlowState(
          flowForWalletSnapshot(
            activeRequest,
            initialHead,
            accountRef.current,
            isMonadChainRef.current,
          ),
        );
        return;
      }
      const targetBlocks = [
        activeRequest.firstTargetBlock,
        activeRequest.secondTargetBlock,
        activeRequest.thirdTargetBlock,
      ] as const;
      const headers = await fetchRawHeaders(targetBlocks);
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const writeHead = await publicClient.getBlockNumber();
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      currentBlockRef.current = writeHead;
      setCurrentBlock(writeHead);
      const readinessBeforeWrite = calculateReadiness(
        activeRequest,
        writeHead,
        accountRef.current,
      );
      if (readinessBeforeWrite.phase === "proof-expired") {
        setFlowState(
          flowForWalletSnapshot(
            activeRequest,
            writeHead,
            accountRef.current,
            isMonadChainRef.current,
          ),
        );
        return;
      }
      if (isBrowserProofCutoff(readinessBeforeWrite, writeHead)) {
        setFlowState(
          flowForWalletSnapshot(
            activeRequest,
            writeHead,
            accountRef.current,
            isMonadChainRef.current,
          ),
        );
        return;
      }
      const currentAccount = await prepareWalletWrite(provider);
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const signerReadiness = calculateReadiness(
        activeRequest,
        writeHead,
        currentAccount,
      );
      if (!signerReadiness.canFinalize) {
        setFlowState(
          flowForWalletSnapshot(
            activeRequest,
            writeHead,
            currentAccount,
            true,
          ),
        );
        return;
      }
      const walletClient = createMonadWalletClient(provider, currentAccount);
      const storage = localStorageOrUndefined();
      const writeResult = await runWithPendingWriteLock({
        lockManager: browserLockManager(),
        storage,
        action: {
          kind: "finalization",
          chainId: MONAD_TESTNET_CHAIN_ID,
          contractAddress,
          requestId: activeRequestId,
        },
        write: async () =>
          await finalizeRandomnessTx({
            publicClient,
            walletClient,
            account: currentAccount,
            contractAddress,
            requestId: activeRequestId,
            headers,
            onTransactionHash: async (transactionHash) => {
              broadcastHash = transactionHash;
              setTx2Hash(transactionHash);
              const pendingState = await runWithStoredStateMutationLock({
                lockManager: browserLockManager(),
                mutate: () =>
                  rememberPendingTransaction(storage, {
                    kind: "finalization",
                    chainId: MONAD_TESTNET_CHAIN_ID,
                    contractAddress,
                    requestId: activeRequestId,
                    transactionHash,
                  }),
              });
              applyLocalState(pendingState, transactionHash);
              setFlowState("submitted");
            },
          }),
      });
      if (writeResult.status !== "completed") {
        handleBlockedWrite(writeResult);
        return;
      }
      const finalized = writeResult.value;
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const permanent: ResultRead = {
        contractAddress,
        requestId: activeRequestId,
        request: finalized.request,
        drawZeroBased: finalized.drawZeroBased,
        drawOneBased: finalized.drawOneBased,
      };
      requestRef.current = finalized.request;
      setRequest(finalized.request);
      setActiveResult(permanent);
      setTx2Hash(finalized.transactionHash);
      const confirmedState = await runWithStoredStateMutationLock({
        lockManager: browserLockManager(),
        mutate: () => {
          rememberRequest(storage, {
            chainId: MONAD_TESTNET_CHAIN_ID,
            contractAddress,
            requestId: activeRequestId,
            tx1Hash: storedTx1Hash,
            tx2Hash: finalized.transactionHash,
          });
          return forgetPendingTransaction(storage, finalized.transactionHash);
        },
      });
      applyLocalState(confirmedState);
      setErrorMessage(undefined);
      setFlowState(
        flowForWalletSnapshot(
          finalized.request,
          currentBlockRef.current,
          accountRef.current,
          isMonadChainRef.current,
        ),
      );
    } catch (error) {
      if (broadcastHash) {
        await handleSubmittedFailure(error, broadcastHash, operationIdentity);
      } else {
        handleFailure(error, operationIdentity);
      }
    } finally {
      finishWrite();
    }
  }

  async function handleExpire() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract || requestId === undefined) return;

    if (pendingExpiry) {
      setSubmittedTransactionHash(pendingExpiry.transactionHash);
      setFlowState("submitted");
      return;
    }
    if (!beginWrite()) return;
    const contractAddress = activeContract;
    const activeRequestId = requestId;
    const operationIdentity = { ...workspaceIdentityRef.current };
    let broadcastHash: Hash | undefined;
    setErrorMessage(undefined);
    setFlowState("expiring");
    try {
      const currentAccount = await prepareWalletWrite(provider);
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const walletClient = createMonadWalletClient(provider, currentAccount);
      const storage = localStorageOrUndefined();
      const writeResult = await runWithPendingWriteLock({
        lockManager: browserLockManager(),
        storage,
        action: {
          kind: "expiry",
          chainId: MONAD_TESTNET_CHAIN_ID,
          contractAddress,
          requestId: activeRequestId,
        },
        write: async () =>
          await expireRandomnessRequest({
            publicClient,
            walletClient,
            account: currentAccount,
            contractAddress,
            requestId: activeRequestId,
            onTransactionHash: async (transactionHash) => {
              broadcastHash = transactionHash;
              setExpiryHash(transactionHash);
              const pendingState = await runWithStoredStateMutationLock({
                lockManager: browserLockManager(),
                mutate: () =>
                  rememberPendingTransaction(storage, {
                    kind: "expiry",
                    chainId: MONAD_TESTNET_CHAIN_ID,
                    contractAddress,
                    requestId: activeRequestId,
                    transactionHash,
                  }),
              });
              applyLocalState(pendingState, transactionHash);
              setFlowState("submitted");
            },
          }),
      });
      if (writeResult.status !== "completed") {
        handleBlockedWrite(writeResult);
        return;
      }
      const expired = writeResult.value;
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      const latest = await readRandomnessResult({
        publicClient,
        contractAddress,
        requestId: activeRequestId,
      });
      if (
        !workspaceOperationMatches(
          operationIdentity,
          workspaceIdentityRef.current,
        )
      ) {
        return;
      }
      setExpiryHash(expired.transactionHash);
      requestRef.current = latest.request;
      setRequest(latest.request);
      setActiveResult(latest);
      const confirmedState = await runWithStoredStateMutationLock({
        lockManager: browserLockManager(),
        mutate: () => {
          rememberRequest(storage, {
            chainId: MONAD_TESTNET_CHAIN_ID,
            contractAddress,
            requestId: activeRequestId,
            tx1Hash: tx1Hash ?? activeReference?.tx1Hash,
            tx2Hash: tx2Hash ?? activeReference?.tx2Hash,
            expiryHash: expired.transactionHash,
          });
          return forgetPendingTransaction(storage, expired.transactionHash);
        },
      });
      applyLocalState(confirmedState);
      setErrorMessage(undefined);
      setFlowState(
        flowForWalletSnapshot(
          latest.request,
          currentBlockRef.current,
          accountRef.current,
          isMonadChainRef.current,
        ),
      );
    } catch (error) {
      if (broadcastHash) {
        await handleSubmittedFailure(error, broadcastHash, operationIdentity);
      } else {
        handleFailure(error, operationIdentity);
      }
    } finally {
      finishWrite();
    }
  }

  async function handleCheckSubmittedTransaction() {
    if (
      !submittedPending ||
      recoveryBusyRef.current ||
      writeBusyRef.current
    ) {
      return;
    }
    const pending = submittedPending;
    let recoveryHash = pending.transactionHash;
    const recoverySelectionEpoch = selectionEpochRef.current;
    const recoveryWorkspaceIdentity = { ...workspaceIdentityRef.current };
    recoveryBusyRef.current = true;
    setRecoveryLoading(true);
    setErrorMessage(undefined);
    setFlowState("submitted");

    try {
      const storage = localStorageOrUndefined();
      let confirmedState: StoredLocalState;
      let recoveredWorkspace = false;
      const observeReplacementHash = async (transactionHash: Hash) => {
        recoveryHash = transactionHash;
        const replacementState = await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () =>
            rememberPendingTransaction(storage, {
              ...pending,
              transactionHash,
            }),
        });
        applyLocalState(replacementState, transactionHash);
      };

      if (pending.kind === "deployment") {
        const deployed = await recoverDemoDeployment({
          publicClient,
          transactionHash: pending.transactionHash,
          onTransactionHash: observeReplacementHash,
        });
        confirmedState = await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () => {
            rememberDemoContract(storage, {
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: deployed.contractAddress,
              deploymentTxHash: deployed.transactionHash,
            });
            return forgetPendingTransaction(
              storage,
              deployed.transactionHash,
            );
          },
        });
        applyLocalState(confirmedState);
        if (
          recoveryWorkspaceMayApply(
            recoverySelectionEpoch,
            selectionEpochRef.current,
            recoveryWorkspaceIdentity,
            workspaceIdentityRef.current,
          )
        ) {
          recoveredWorkspace = true;
          workspaceIdentityRef.current = normalizedWorkspaceIdentity(
            workspaceIdentityRef.current.epoch + 1,
            deployed.contractAddress,
          );
          setActiveContract(deployed.contractAddress);
          setContractInput(deployed.contractAddress);
          setDeploymentHash(deployed.transactionHash);
          setRequestId(undefined);
          requestRef.current = undefined;
          setRequest(undefined);
          setActiveResult(undefined);
          setTx1Hash(undefined);
          setTx2Hash(undefined);
          setExpiryHash(undefined);
        }
      } else if (pending.kind === "request") {
        const locked = await recoverRandomnessRequestTx({
          publicClient,
          contractAddress: pending.contractAddress,
          transactionHash: pending.transactionHash,
          expectedRequester: pending.requester,
          onTransactionHash: observeReplacementHash,
        });
        const latest = await readRandomnessResult({
          publicClient,
          contractAddress: pending.contractAddress,
          requestId: locked.requestId,
        });
        confirmedState = await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () => {
            rememberRequest(storage, {
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: pending.contractAddress,
              requestId: locked.requestId,
              tx1Hash: locked.transactionHash,
            });
            return forgetPendingTransaction(storage, locked.transactionHash);
          },
        });
        applyLocalState(confirmedState);
        if (
          recoveryWorkspaceMayApply(
            recoverySelectionEpoch,
            selectionEpochRef.current,
            recoveryWorkspaceIdentity,
            workspaceIdentityRef.current,
          )
        ) {
          recoveredWorkspace = true;
          workspaceIdentityRef.current = normalizedWorkspaceIdentity(
            workspaceIdentityRef.current.epoch + 1,
            pending.contractAddress,
            locked.requestId,
          );
          setActiveContract(pending.contractAddress);
          setContractInput(pending.contractAddress);
          setDeploymentHash(undefined);
          setRequestId(locked.requestId);
          requestRef.current = latest.request;
          setRequest(latest.request);
          setActiveResult(latest);
          setTx1Hash(locked.transactionHash);
          setTx2Hash(undefined);
          setExpiryHash(undefined);
        }
      } else if (pending.kind === "finalization") {
        const finalized = await recoverRandomnessFinalizationTx({
          publicClient,
          contractAddress: pending.contractAddress,
          requestId: BigInt(pending.requestId),
          transactionHash: pending.transactionHash,
          onTransactionHash: observeReplacementHash,
        });
        const recoveredRequestId = BigInt(pending.requestId);
        confirmedState = await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () => {
            rememberRequest(storage, {
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: pending.contractAddress,
              requestId: recoveredRequestId,
              tx2Hash: finalized.transactionHash,
            });
            return forgetPendingTransaction(
              storage,
              finalized.transactionHash,
            );
          },
        });
        applyLocalState(confirmedState);
        if (
          recoveryWorkspaceMayApply(
            recoverySelectionEpoch,
            selectionEpochRef.current,
            recoveryWorkspaceIdentity,
            workspaceIdentityRef.current,
          )
        ) {
          recoveredWorkspace = true;
          const permanent: ResultRead = {
            contractAddress: pending.contractAddress,
            requestId: recoveredRequestId,
            request: finalized.request,
            drawZeroBased: finalized.drawZeroBased,
            drawOneBased: finalized.drawOneBased,
          };
          const reference = findLocalReference(
            confirmedState,
            pending.contractAddress,
            recoveredRequestId,
          );
          workspaceIdentityRef.current = normalizedWorkspaceIdentity(
            workspaceIdentityRef.current.epoch + 1,
            pending.contractAddress,
            recoveredRequestId,
          );
          setActiveContract(pending.contractAddress);
          setContractInput(pending.contractAddress);
          setDeploymentHash(undefined);
          setRequestId(recoveredRequestId);
          requestRef.current = finalized.request;
          setRequest(finalized.request);
          setActiveResult(permanent);
          setTx1Hash(reference?.tx1Hash);
          setTx2Hash(finalized.transactionHash);
          setExpiryHash(reference?.expiryHash);
        }
      } else {
        const recoveredRequestId = BigInt(pending.requestId);
        const expired = await recoverRandomnessExpiryTx({
          publicClient,
          contractAddress: pending.contractAddress,
          requestId: recoveredRequestId,
          transactionHash: pending.transactionHash,
          onTransactionHash: observeReplacementHash,
        });
        const latest = await readRandomnessResult({
          publicClient,
          contractAddress: pending.contractAddress,
          requestId: recoveredRequestId,
        });
        confirmedState = await runWithStoredStateMutationLock({
          lockManager: browserLockManager(),
          mutate: () => {
            rememberRequest(storage, {
              chainId: MONAD_TESTNET_CHAIN_ID,
              contractAddress: pending.contractAddress,
              requestId: recoveredRequestId,
              expiryHash: expired.transactionHash,
            });
            return forgetPendingTransaction(storage, expired.transactionHash);
          },
        });
        applyLocalState(confirmedState);
        if (
          recoveryWorkspaceMayApply(
            recoverySelectionEpoch,
            selectionEpochRef.current,
            recoveryWorkspaceIdentity,
            workspaceIdentityRef.current,
          )
        ) {
          recoveredWorkspace = true;
          const reference = findLocalReference(
            confirmedState,
            pending.contractAddress,
            recoveredRequestId,
          );
          workspaceIdentityRef.current = normalizedWorkspaceIdentity(
            workspaceIdentityRef.current.epoch + 1,
            pending.contractAddress,
            recoveredRequestId,
          );
          setActiveContract(pending.contractAddress);
          setContractInput(pending.contractAddress);
          setDeploymentHash(undefined);
          setRequestId(recoveredRequestId);
          requestRef.current = latest.request;
          setRequest(latest.request);
          setActiveResult(latest);
          setTx1Hash(reference?.tx1Hash);
          setTx2Hash(reference?.tx2Hash);
          setExpiryHash(expired.transactionHash);
        }
      }

      if (recoveredWorkspace) {
        setErrorMessage(undefined);
        const stillPending = confirmedState.pendingTransactions.some(
          (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
        );
        setFlowState(
          stillPending
            ? "submitted"
            : flowForWalletSnapshot(
                requestRef.current,
                currentBlockRef.current,
                accountRef.current,
                isMonadChainRef.current,
              ),
        );
      }
    } catch (error) {
      await handleSubmittedFailure(error, recoveryHash);
    } finally {
      recoveryBusyRef.current = false;
      setRecoveryLoading(false);
    }
  }

  async function handleExplore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeBusyRef.current) return;
    const explorerEpoch = explorerEpochRef.current + 1;
    explorerEpochRef.current = explorerEpoch;
    setExplorerError(undefined);
    setExplorerLoading(true);
    try {
      if (!/^[1-9][0-9]*$/.test(explorerRequestId.trim())) {
        throw new Error("Enter a request ID of 1 or greater.");
      }
      const result = await readRandomnessResult({
        publicClient,
        contractAddress: explorerContract,
        requestId: BigInt(explorerRequestId),
      });
      if (
        explorerEpoch !== explorerEpochRef.current ||
        writeBusyRef.current
      ) {
        return;
      }
      setExplorerContract(result.contractAddress);
      setExplorerResult(result);
    } catch (error) {
      if (explorerEpoch !== explorerEpochRef.current) return;
      const mapped = mapClientError(error);
      setExplorerError(
        mapped.code === "UNKNOWN"
          ? error instanceof Error
            ? error.message
            : mapped.message
          : mapped.message,
      );
      setExplorerResult(undefined);
    } finally {
      if (explorerEpoch === explorerEpochRef.current) {
        setExplorerLoading(false);
      }
    }
  }

  async function handleLoadIntoWorkspace() {
    if (!explorerResult || writeBusyRef.current) return;

    selectionEpochRef.current += 1;
    workspaceIdentityRef.current = normalizedWorkspaceIdentity(
      workspaceIdentityRef.current.epoch + 1,
      explorerResult.contractAddress,
      explorerResult.requestId,
    );
    setActiveContract(explorerResult.contractAddress);
    setContractInput(explorerResult.contractAddress);
    setDeploymentHash(undefined);
    setRequestId(explorerResult.requestId);
    requestRef.current = explorerResult.request;
    setRequest(explorerResult.request);
    setActiveResult(explorerResult);
    setTx1Hash(explorerReference?.tx1Hash);
    setTx2Hash(explorerReference?.tx2Hash);
    setExpiryHash(undefined);
    setErrorMessage(undefined);

    setFlowState(
      flowForWalletSnapshot(
        explorerResult.request,
        currentBlockRef.current,
        accountRef.current,
        isMonadChainRef.current,
      ),
    );

    const storage = localStorageOrUndefined();
    const next = await runWithStoredStateMutationLock({
      lockManager: browserLockManager(),
      mutate: () =>
        rememberRequest(storage, {
          chainId: MONAD_TESTNET_CHAIN_ID,
          contractAddress: explorerResult.contractAddress,
          requestId: explorerResult.requestId,
          tx1Hash: explorerReference?.tx1Hash,
          tx2Hash: explorerReference?.tx2Hash,
        }),
    });
    setLocalState(next);
    const reducedMotion =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    globalThis.document?.getElementById("demo")?.scrollIntoView({
      behavior: preferredScrollBehavior(reducedMotion),
      block: "start",
    });
  }

  const activeReference =
    activeContract && requestId !== undefined
      ? findLocalReference(localState, activeContract, requestId)
      : undefined;
  const explorerReference = explorerResult
    ? findLocalReference(
        localState,
        explorerResult.contractAddress,
        explorerResult.requestId,
      )
    : undefined;
  const busy = writeBusy || recoveryLoading;
  const browserProofCutoff =
    readiness && currentBlock !== undefined
      ? isBrowserProofCutoff(readiness, currentBlock)
      : false;
  const canFinalize = Boolean(
    readiness?.canFinalize &&
      account &&
      isMonadChain &&
      request &&
      !browserProofCutoff &&
      !pendingFinalization &&
      (readiness.phase === "permissionless" ||
        account.toLowerCase() === request.requester.toLowerCase()),
  );

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Monad RNG home">
          <span className="wordmark-mark" aria-hidden="true">
            M
          </span>
          <span>Monad RNG</span>
          <small>Public good · v1</small>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/integrate">Integrate</a>
          <a href="#demo">Demo</a>
          <a href="#security">Security</a>
          <a href="#explorer">Explorer</a>
          <a href="/contracts/PlatformRandomness.sol">Source</a>
        </nav>
        <button
          className="wallet-button"
          type="button"
          onClick={
            account && !isMonadChain ? handleSwitchNetwork : handleConnect
          }
          disabled={busy}
        >
          {account
            ? isMonadChain
              ? shorten(account)
              : "Switch to Monad"
            : "Connect wallet"}
        </button>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow">Monad-native randomness · no backend</p>
          <h1>
            Lock in the future.
            <br />
            <span>Verify what arrives.</span>
          </h1>
          <p className="hero-lede">
            An open-source, contract-only randomness primitive for Monad builders.
            Three future proposer-entropy values become one permanent, inspectable
            seed.
          </p>
          <div className="hero-actions">
            <a className="button button--primary" href="#demo">
              Run the two-transaction demo
            </a>
            <a
              className="button button--secondary"
              href="/integrate"
            >
              Integration guide
            </a>
            <a
              className="button button--quiet"
              href="/contracts/PlatformRandomness.json"
            >
              Download ABI + bytecode
            </a>
          </div>
        </div>
        <div className="hero-proof" aria-label="Protocol summary">
          <div className="proof-orbit" aria-hidden="true">
            <span>01</span>
            <span>02</span>
            <span>03</span>
            <b>R</b>
          </div>
          <dl>
            <div>
              <dt>Protocol fee</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Entropy blocks</dt>
              <dd>3</dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Demo chain</dt>
              <dd>10143</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="economics-strip" aria-label="Economics">
        <strong>Protocol fee · 0</strong>
        <span>Every caller pays their own Monad gas.</span>
        <span>Each platform sets its own request price, including zero.</span>
        <span>No project treasury, relayer, keeper reward, or gas subsidy.</span>
      </section>

      <section className="timeline-section" aria-labelledby="timeline-title">
        <div className="section-intro">
          <p className="eyebrow">One request, one outcome</p>
          <h2 id="timeline-title">The block numbers are the source of truth.</h2>
        </div>
        <ol className="protocol-timeline">
          <li>
            <span>01</span>
            <h3>Choose an isolated platform</h3>
            <p>
              Deploy your own instance or paste the exact published
              PlatformRandomness contract.
            </p>
          </li>
          <li>
            <span>02</span>
            <h3>Tx1 · Lock request</h3>
            <p>Requester, price, ID, and targets +8 · +24 · +40 are fixed.</p>
          </li>
          <li>
            <span>03</span>
            <h3>Tx2 · Store result</h3>
            <p>Requester opens at target three +2; anyone can rescue at T+64.</p>
          </li>
          <li>
            <span>04</span>
            <h3>Verify forever—or expire honestly</h3>
            <p>
              Finalized results persist. After first target +8,191, expiry creates
              no result.
            </p>
          </li>
        </ol>
        <p className="timing-note">
          At roughly 0.3 seconds per block, requester Tx2 is about 13 seconds and
          permissionless rescue about 31 seconds after Tx1. Network timing varies;
          observed block height always wins.
        </p>
      </section>

      <section className="demo-security-grid" id="demo">
        <div className="demo-workspace">
          <div className="section-heading-row demo-title">
            <div>
              <p className="eyebrow">Live testnet workspace</p>
              <h2>Two transactions. No service account.</h2>
            </div>
            <span className="network-badge">
              <i aria-hidden="true" /> Monad testnet
            </span>
          </div>

          <StateBanner
            flowState={flowState}
            request={request}
            readiness={readiness}
            currentBlock={currentBlock}
            errorMessage={errorMessage}
          />

          {submittedPending ? (
            <div className="selected-contract" role="status">
              <span>
                {submittedPending.kind === "deployment"
                  ? "Deployment submitted"
                  : submittedPending.kind === "request"
                    ? "Tx1 submitted"
                    : submittedPending.kind === "finalization"
                      ? "Tx2 submitted"
                      : "Expiry submitted"}
              </span>
              <a
                href={transactionExplorerUrl(submittedPending.transactionHash)}
                target="_blank"
                rel="noreferrer"
              >
                {shorten(submittedPending.transactionHash)} ↗
              </a>
              <CopyButton value={submittedPending.transactionHash} />
              <button
                className="button button--secondary"
                type="button"
                onClick={handleCheckSubmittedTransaction}
                disabled={recoveryLoading || busy}
              >
                {recoveryLoading
                  ? "Checking confirmation…"
                  : "Check submitted transaction"}
              </button>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="inline-error" role="alert">
              <strong>Action paused.</strong>
              <span>{errorMessage}</span>
              <a href={MONAD_FAUCET_URL} target="_blank" rel="noreferrer">
                Need testnet MON? Open faucet ↗
              </a>
            </div>
          ) : null}

          <div className="action-stack">
            <section className="action-card">
              <div className="action-number">01</div>
              <div className="action-content">
                <div className="action-heading">
                  <div>
                    <h3>Connect + isolate</h3>
                    <p>
                      Your wallet deploys the demo. This project never receives a
                      private key or pays the transaction.
                    </p>
                  </div>
                  <span>
                    {account
                      ? isMonadChain
                        ? "Connected"
                        : "Wrong network"
                      : "Required to write"}
                  </span>
                </div>

                <div className="wallet-line">
                  <span>Wallet</span>
                  <code>{account ?? "Not connected"}</code>
                  {!account ? (
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={handleConnect}
                    >
                      {flowState === "wrong-network"
                        ? "Switch to Monad testnet"
                        : "Connect wallet"}
                    </button>
                  ) : !isMonadChain ? (
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={handleSwitchNetwork}
                    >
                      Switch to Monad testnet
                    </button>
                  ) : null}
                </div>

                <div className="platform-choices">
                  <button
                    className={`button ${
                      activeContract ? "button--secondary" : "button--primary"
                    }`}
                    type="button"
                    onClick={handleDeploy}
                    disabled={
                      !account ||
                      !isMonadChain ||
                      busy ||
                      Boolean(pendingDeployment)
                    }
                  >
                    {flowState === "deploying"
                      ? "Deploying…"
                      : pendingDeployment
                        ? "Deployment submitted · check transaction"
                      : "Deploy zero-price demo"}
                  </button>
                  <span>or use an existing instance</span>
                  <form onSubmit={handleUseContract} className="inline-form">
                    <label htmlFor="platform-address">Platform contract</label>
                    <div>
                      <input
                        id="platform-address"
                        value={contractInput}
                        onChange={(event) => setContractInput(event.target.value)}
                        placeholder="0x…"
                        autoComplete="off"
                        disabled={busy}
                      />
                      <button
                        className="button button--secondary"
                        type="submit"
                        disabled={!contractInput || busy}
                      >
                        Use contract
                      </button>
                    </div>
                  </form>
                </div>

                {activeContract ? (
                  <div className="selected-contract">
                    <span>Active platform</span>
                    <a
                      href={addressExplorerUrl(activeContract)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {activeContract}
                    </a>
                    <CopyButton value={activeContract} />
                    {deploymentHash && !pendingDeployment ? (
                      <a
                        href={transactionExplorerUrl(deploymentHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        deployment ↗
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="action-card">
              <div className="action-number">02</div>
              <div className="action-content">
                <div className="action-heading">
                  <div>
                    <h3>Tx1 · Lock request</h3>
                    <p>
                      Reads this platform&apos;s current price and sends exactly that
                      value. Three target blocks are emitted in the receipt.
                    </p>
                  </div>
                  <span>+8 · +24 · +40</span>
                </div>
                <button
                  className="button button--primary button--wide"
                  type="button"
                  onClick={handleRequest}
                  disabled={
                    !account ||
                    !isMonadChain ||
                    !activeContract ||
                    busy ||
                    Boolean(pendingRequest) ||
                    Boolean(request)
                  }
                >
                  {flowState === "requesting"
                    ? "Confirming Tx1…"
                    : pendingRequest
                      ? "Tx1 submitted · check transaction"
                    : request
                      ? `Request #${requestId?.toString() ?? "—"} locked`
                      : "Submit Tx1 · Lock request"}
                </button>
                {request ? (
                  <dl className="request-snapshot">
                    <DataValue label="Request ID" value={requestId?.toString() ?? "—"} />
                    <DataValue label="Price paid" value={formatPrice(request.pricePaid)} />
                    <DataValue
                      label="Requester"
                      value={shorten(request.requester)}
                      copyValue={request.requester}
                    />
                    <DataValue
                      label="Targets"
                      value={`${formatBlock(request.firstTargetBlock)} · ${formatBlock(
                        request.secondTargetBlock,
                      )} · ${formatBlock(request.thirdTargetBlock)}`}
                    />
                  </dl>
                ) : null}
              </div>
            </section>

            <section className="action-card">
              <div className="action-number">03</div>
              <div className="action-content">
                <div className="action-heading">
                  <div>
                    <h3>Tx2 · Store result</h3>
                    <p>
                      Fetches exactly three raw headers from Monad RPC, then the
                      contract authenticates and stores one result.
                    </p>
                  </div>
                  <span>
                    {browserProofCutoff
                      ? "Demo safety stop"
                      : readiness?.phase === "permissionless"
                        ? "Anyone may rescue"
                        : "Requester first"}
                  </span>
                </div>

                {flowState === "proof-expired" || flowState === "expiring" ? (
                  <button
                    className="button button--danger button--wide"
                    type="button"
                    onClick={handleExpire}
                    disabled={
                      !account ||
                      !isMonadChain ||
                      busy ||
                      Boolean(pendingExpiry)
                    }
                  >
                    {flowState === "expiring"
                      ? "Marking expired…"
                      : pendingExpiry
                        ? "Expiry submitted · check transaction"
                      : "Mark expired · no refund or reward"}
                  </button>
                ) : (
                  <button
                    className="button button--primary button--wide"
                    type="button"
                    onClick={handleFinalize}
                    disabled={!canFinalize || busy}
                  >
                    {flowState === "finalizing"
                      ? "Fetching 3 headers + confirming Tx2…"
                      : pendingFinalization
                        ? "Tx2 submitted · check transaction"
                      : flowState === "safety-cutoff"
                        ? "Demo Tx2 closed · proof still valid on-chain"
                        : flowState === "rescue-ready"
                          ? "Rescue Tx2 · Store original requester's result"
                          : "Submit Tx2 · Store result"}
                  </button>
                )}

                <div className="readiness-meter">
                  <div>
                    <span
                      style={{
                        width: request
                          ? `${Math.min(
                              100,
                              Math.max(
                                0,
                                Number(
                                  ((currentBlock ?? request.requestBlock) -
                                    request.requestBlock) *
                                    BigInt(100),
                                ) / 42,
                              ),
                            )}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <p>
                    {request && readiness ? (
                      <>
                        Requester window{" "}
                        <b>{formatBlock(readiness.requesterFinalizationBlock)}</b>
                        {" · "}rescue <b>{formatBlock(readiness.permissionlessRescueBlock)}</b>
                        {" · "}demo cutoff{" "}
                        <b>
                          {formatBlock(
                            proofSafetyCutoffBlock(
                              readiness.lastProofValidBlock,
                            ),
                          )}
                        </b>
                        {" · "}last on-chain proof{" "}
                        <b>{formatBlock(readiness.lastProofValidBlock)}</b>
                      </>
                    ) : (
                      "Readiness appears after Tx1."
                    )}
                  </p>
                  {estimatedSeconds > 0 ? (
                    <small>
                      Rough estimate: ~{estimatedSeconds}s. Network timing varies.
                    </small>
                  ) : null}
                  {readiness ? (
                    <small>
                      The demo&apos;s 64-block cutoff is a best-effort UI margin
                      that prevents starting a new Tx2 flow after the observed
                      head reaches it. Wallet or RPC delay can cross the margin,
                      so it does not guarantee broadcast or inclusion. On-chain
                      proof remains valid through exact block{" "}
                      {formatBlock(readiness.lastProofValidBlock)}. T+64 opens
                      rescue; it is not proof expiry.
                    </small>
                  ) : null}
                </div>
              </div>
            </section>
          </div>

          <ResultCard
            idPrefix="active"
            title="Verified randomness"
            result={activeResult}
            tx1Hash={tx1Hash ?? activeReference?.tx1Hash}
            tx2Hash={tx2Hash ?? activeReference?.tx2Hash}
            expiryHash={expiryHash ?? activeReference?.expiryHash}
          />
        </div>

        <aside className="security-panel" id="security">
          <p className="eyebrow">Threat model, in plain language</p>
          <h2>
            Authenticated multi-block proposer entropy, not a cryptographic VRF.
          </h2>
          <p className="security-lede">
            The headers are canonical and the stored result is irreversible. That
            does not make block-proposer entropy perfectly unbiasable.
          </p>
          <ul>
            <li>
              <strong>Proposer skip bias remains.</strong>
              <span>
                A proposer may know its own entropy and skip a block when that is
                economically worthwhile.
              </span>
            </li>
            <li>
              <strong>Free multi-request cherry-picking is an app risk.</strong>
              <span>
                A user must not open many zero-price requests and redeem only the
                favorable result.
              </span>
            </li>
            <li>
              <strong>Bind value during Tx1.</strong>
              <span>
                Lock payment, inventory, eligibility, and exactly one request ID
                together before future blocks exist.
              </span>
            </li>
            <li>
              <strong>Set a real value ceiling.</strong>
              <span>
                Use threshold randomness or an external VRF when prize value can
                exceed plausible proposer skip cost.
              </span>
            </li>
          </ul>
          <div className="security-rule">
            <span>Recommended use</span>
            <p>
              Games and reveals whose maximum extractable value is explicitly
              capped below the bias budget.
            </p>
          </div>
          <a
            className="text-link"
            href="https://docs.monad.xyz/monad-arch/transaction-lifecycle"
            target="_blank"
            rel="noreferrer"
          >
            Read Monad transaction lifecycle ↗
          </a>
        </aside>
      </section>

      <section className="explorer-section" id="explorer">
        <div className="section-intro">
          <p className="eyebrow">Read-only · wallet optional</p>
          <h2>Result explorer</h2>
          <p>
            Enter an exact published PlatformRandomness address and request ID.
            Its runtime bytecode hash is verified, and all authoritative data
            comes directly from Monad; this page uses no indexer or application
            server.
          </p>
        </div>
        <form className="explorer-form" onSubmit={handleExplore}>
          <label htmlFor="explorer-contract">
            Platform contract
            <input
              id="explorer-contract"
              value={explorerContract}
              onChange={(event) => setExplorerContract(event.target.value)}
              placeholder="0x…"
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <label htmlFor="explorer-request">
            Request ID
            <input
              id="explorer-request"
              value={explorerRequestId}
              onChange={(event) => setExplorerRequestId(event.target.value)}
              placeholder="1"
              inputMode="numeric"
              disabled={busy}
            />
          </label>
          <button
            className="button button--lime"
            type="submit"
            disabled={explorerLoading || busy}
          >
            {explorerLoading ? "Reading Monad…" : "Verify result"}
          </button>
        </form>
        {latestLocalRequest ? (
          <p className="explorer-saved-note">
            <strong>Latest saved Monad request</strong>
            <span>
              #{latestLocalRequest.requestId} was restored from this browser.
              Read on-chain to verify its current status.
            </span>
          </p>
        ) : null}
        {explorerError ? (
          <p className="explorer-error" role="alert">
            {explorerError}
          </p>
        ) : null}
        {explorerResult ? (
          <>
            <div className="explorer-promotion">
              <div>
                <strong>Want to finish this request?</strong>
                <span>
                  Load it above to resume as the requester, rescue after T+64, or
                  expire it after the proof window.
                </span>
              </div>
              <button
                className="button button--secondary"
                type="button"
                onClick={handleLoadIntoWorkspace}
                disabled={busy}
              >
                Load into Tx2 workspace
              </button>
            </div>
            <ResultCard
              idPrefix="explorer"
              title={`Request #${explorerResult.requestId.toString()}`}
              result={explorerResult}
              tx1Hash={explorerReference?.tx1Hash}
              tx2Hash={explorerReference?.tx2Hash}
              expiryHash={explorerReference?.expiryHash}
            />
          </>
        ) : (
          <div className="explorer-empty">
            <span aria-hidden="true">↳</span>
            <p>
              Finalized requests show a permanent seed and draw. Expired requests
              explicitly show no result.
            </p>
          </div>
        )}
      </section>

      <section className="public-good-section">
        <div>
          <p className="eyebrow">Take it. Inspect it. Ship it.</p>
          <h2>Public infrastructure, not a toll booth.</h2>
        </div>
        <div className="public-good-copy">
          <p>
            The contracts charge no protocol fee and keep no author treasury.
            Integrating platforms operate an isolated instance, choose its fixed price, and
            keep their own storage, counters, caps, and revenue isolated.
          </p>
          <div className="source-links">
            <a href="/integrate">Platform onboarding →</a>
            <a href="/contracts/PlatformRandomness.sol">Solidity source ↓</a>
            <a href="/contracts/PlatformRandomness.json">ABI + bytecode ↓</a>
            <a
              href={MONAD_FAUCET_URL}
              target="_blank"
              rel="noreferrer"
            >
              Testnet faucet ↗
            </a>
            <a
              href={MONAD_EXPLORER_URL}
              target="_blank"
              rel="noreferrer"
            >
              Monadscan ↗
            </a>
          </div>
        </div>
      </section>

      <footer>
        <a className="wordmark" href="#top">
          <span className="wordmark-mark" aria-hidden="true">
            M
          </span>
          <span>Monad RNG</span>
        </a>
        <p>
          Open-source authenticated block entropy. Not a cryptographic VRF.
        </p>
        <span>Built for Monad builders · 2026</span>
      </footer>
    </main>
  );
}
