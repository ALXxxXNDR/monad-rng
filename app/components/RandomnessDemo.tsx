"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import type { Address, Hash } from "viem";

import {
  MONAD_EXPLORER_URL,
  MONAD_FAUCET_URL,
  MONAD_TESTNET_CHAIN_ID,
  addressExplorerUrl,
  connectMonadWallet,
  createMonadPublicClient,
  createMonadWalletClient,
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
  requestRandomnessTx,
} from "../lib/randomness";
import type {
  RandomnessRequest,
  RequestReadiness,
} from "../lib/randomness";
import {
  loadStoredState,
  rememberDemoContract,
  rememberRequest,
} from "../lib/storage";
import type {
  StoredLocalState,
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
  | "proof-expired"
  | "expiring"
  | "expired"
  | "finalized"
  | "error";
type ResultRead = Awaited<ReturnType<typeof readRandomnessResult>>;

const EMPTY_LOCAL_STATE: StoredLocalState = {
  version: 1,
  demoContracts: [],
  recentRequests: [],
};
const BUSY_STATES = new Set<FlowState>([
  "deploying",
  "requesting",
  "finalizing",
  "expiring",
]);
const BLOCK_TIME_ESTIMATE_SECONDS = 0.3;

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
): FlowState {
  if (readiness.phase === "finalized") return "finalized";
  if (readiness.phase === "expired") return "expired";
  if (readiness.phase === "proof-expired") return "proof-expired";
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
    <div className={`state-banner state-banner--${flowState}`} role="status" aria-live="polite">
      <div>
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

  const latestLocalRequest = useMemo(
    () =>
      localState.recentRequests.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      ),
    [localState],
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

  const handleFailure = useCallback((error: unknown) => {
    const mapped = mapClientError(error);
    setErrorMessage(mapped.message);
    setFlowState(mapped.code === "WRONG_NETWORK" ? "wrong-network" : "error");
  }, []);

  useEffect(() => {
    const hydrationTimer = globalThis.setTimeout(() => {
      const stored = loadStoredState();
      setLocalState(stored);
      const saved = stored.demoContracts.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
      const newestMonadRequest = stored.recentRequests.find(
        (item) => item.chainId === MONAD_TESTNET_CHAIN_ID,
      );
      if (saved) {
        setActiveContract(saved.contractAddress);
        setContractInput(saved.contractAddress);
        setDeploymentHash(saved.deploymentTxHash);
      }
      if (newestMonadRequest) {
        setExplorerContract(newestMonadRequest.contractAddress);
        setExplorerRequestId(newestMonadRequest.requestId);
      }
    }, 0);
    return () => globalThis.clearTimeout(hydrationTimer);
  }, []);

  useEffect(() => {
    let live = true;

    async function pollBlock() {
      try {
        const block = await publicClient.getBlockNumber();
        if (live) setCurrentBlock(block);
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
    let live = true;

    async function refreshActiveRequest() {
      try {
        const latest = await readRandomnessResult({
          publicClient,
          contractAddress,
          requestId: activeRequestId,
        });
        if (!live) return;
        setRequest(latest.request);
        setActiveResult(latest);
        const nextReadiness = calculateReadiness(
          latest.request,
          observedBlock,
          account,
        );
        setFlowState((current) => {
          if (BUSY_STATES.has(current) || current === "wrong-network") return current;
          return flowFromReadiness(
            nextReadiness,
            account?.toLowerCase() === latest.request.requester.toLowerCase(),
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
      const connected = await connectMonadWallet(injected);
      setProvider(injected);
      setAccount(connected);
      setFlowState(
        request && readiness
          ? flowFromReadiness(
              readiness,
              connected.toLowerCase() === request.requester.toLowerCase(),
            )
          : "ready",
      );
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleUseContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(undefined);
    try {
      const address = await assertCompatibleContract(publicClient, contractInput);
      setActiveContract(address);
      setContractInput(address);
      setRequestId(undefined);
      setRequest(undefined);
      setActiveResult(undefined);
      const next = rememberDemoContract(localStorageOrUndefined(), {
        chainId: MONAD_TESTNET_CHAIN_ID,
        contractAddress: address,
      });
      setLocalState(next);
      setFlowState(account ? "ready" : "disconnected");
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleDeploy() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    setErrorMessage(undefined);
    setFlowState("deploying");
    try {
      const walletClient = createMonadWalletClient(provider, account);
      const deployed = await deployDemoPlatform({
        walletClient,
        publicClient,
        owner: account,
      });
      setActiveContract(deployed.contractAddress);
      setContractInput(deployed.contractAddress);
      setDeploymentHash(deployed.transactionHash);
      setRequestId(undefined);
      setRequest(undefined);
      setActiveResult(undefined);
      const next = rememberDemoContract(localStorageOrUndefined(), {
        chainId: MONAD_TESTNET_CHAIN_ID,
        contractAddress: deployed.contractAddress,
        deploymentTxHash: deployed.transactionHash,
      });
      setLocalState(next);
      setFlowState("ready");
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleRequest() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract) {
      setErrorMessage("Deploy or paste one compatible platform contract first.");
      setFlowState("error");
      return;
    }
    setErrorMessage(undefined);
    setFlowState("requesting");
    try {
      const walletClient = createMonadWalletClient(provider, account);
      const locked = await requestRandomnessTx({
        publicClient,
        walletClient,
        account,
        contractAddress: activeContract,
      });
      const pending = await readRandomnessResult({
        publicClient,
        contractAddress: activeContract,
        requestId: locked.requestId,
      });
      setRequestId(locked.requestId);
      setRequest(pending.request);
      setActiveResult(pending);
      setTx1Hash(locked.transactionHash);
      setTx2Hash(undefined);
      setExpiryHash(undefined);
      const next = rememberRequest(localStorageOrUndefined(), {
        chainId: MONAD_TESTNET_CHAIN_ID,
        contractAddress: activeContract,
        requestId: locked.requestId,
        tx1Hash: locked.transactionHash,
      });
      setLocalState(next);
      setFlowState("waiting");
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleFinalize() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract || requestId === undefined || !request) return;

    setErrorMessage(undefined);
    setFlowState("finalizing");
    try {
      const walletClient = createMonadWalletClient(provider, account);
      const targetBlocks = [
        request.firstTargetBlock,
        request.secondTargetBlock,
        request.thirdTargetBlock,
      ] as const;
      const headers = await fetchRawHeaders(targetBlocks);
      const finalized = await finalizeRandomnessTx({
        publicClient,
        walletClient,
        account,
        contractAddress: activeContract,
        requestId,
        headers,
      });
      const permanent: ResultRead = {
        contractAddress: activeContract,
        requestId,
        request: finalized.request,
        drawZeroBased: finalized.drawZeroBased,
        drawOneBased: finalized.drawOneBased,
      };
      setRequest(finalized.request);
      setActiveResult(permanent);
      setTx2Hash(finalized.transactionHash);
      const next = rememberRequest(localStorageOrUndefined(), {
        chainId: MONAD_TESTNET_CHAIN_ID,
        contractAddress: activeContract,
        requestId,
        tx1Hash: tx1Hash ?? activeReference?.tx1Hash,
        tx2Hash: finalized.transactionHash,
      });
      setLocalState(next);
      setFlowState("finalized");
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleExpire() {
    if (!account || !provider) {
      await handleConnect();
      return;
    }
    if (!activeContract || requestId === undefined) return;

    setErrorMessage(undefined);
    setFlowState("expiring");
    try {
      const walletClient = createMonadWalletClient(provider, account);
      const expired = await expireRandomnessRequest({
        publicClient,
        walletClient,
        account,
        contractAddress: activeContract,
        requestId,
      });
      const latest = await readRandomnessResult({
        publicClient,
        contractAddress: activeContract,
        requestId,
      });
      setExpiryHash(expired.transactionHash);
      setRequest(latest.request);
      setActiveResult(latest);
      setFlowState("expired");
    } catch (error) {
      handleFailure(error);
    }
  }

  async function handleExplore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setExplorerContract(result.contractAddress);
      setExplorerResult(result);
    } catch (error) {
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
      setExplorerLoading(false);
    }
  }

  function handleLoadIntoWorkspace() {
    if (!explorerResult) return;

    setActiveContract(explorerResult.contractAddress);
    setContractInput(explorerResult.contractAddress);
    setRequestId(explorerResult.requestId);
    setRequest(explorerResult.request);
    setActiveResult(explorerResult);
    setTx1Hash(explorerReference?.tx1Hash);
    setTx2Hash(explorerReference?.tx2Hash);
    setExpiryHash(undefined);

    if (currentBlock !== undefined) {
      const loadedReadiness = calculateReadiness(
        explorerResult.request,
        currentBlock,
        account,
      );
      setFlowState(
        flowFromReadiness(
          loadedReadiness,
          account?.toLowerCase() ===
            explorerResult.request.requester.toLowerCase(),
        ),
      );
    } else if (explorerResult.request.finalized) {
      setFlowState("finalized");
    } else if (explorerResult.request.expired) {
      setFlowState("expired");
    } else {
      setFlowState("waiting");
    }

    const next = rememberRequest(localStorageOrUndefined(), {
      chainId: MONAD_TESTNET_CHAIN_ID,
      contractAddress: explorerResult.contractAddress,
      requestId: explorerResult.requestId,
      tx1Hash: explorerReference?.tx1Hash,
      tx2Hash: explorerReference?.tx2Hash,
    });
    setLocalState(next);
    globalThis.document?.getElementById("demo")?.scrollIntoView({
      behavior: "smooth",
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
  const busy = BUSY_STATES.has(flowState);
  const canFinalize = Boolean(
    readiness?.canFinalize &&
      account &&
      request &&
      (readiness.phase === "permissionless" ||
        account.toLowerCase() === request.requester.toLowerCase()),
  );

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Monad RND home">
          <span className="wordmark-mark" aria-hidden="true">
            M
          </span>
          <span>Monad RND</span>
          <small>Public good · v1</small>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#demo">Demo</a>
          <a href="#security">Security</a>
          <a href="#explorer">Explorer</a>
          <a href="/contracts/PlatformRandomness.sol">Source</a>
        </nav>
        <button
          className="wallet-button"
          type="button"
          onClick={handleConnect}
          disabled={busy}
        >
          {account ? shorten(account) : "Connect wallet"}
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
            <p>Deploy your own instance or paste any compatible contract.</p>
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
                  <span>{account ? "Connected" : "Required to write"}</span>
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
                  ) : null}
                </div>

                <div className="platform-choices">
                  <button
                    className={`button ${
                      activeContract ? "button--secondary" : "button--primary"
                    }`}
                    type="button"
                    onClick={handleDeploy}
                    disabled={!account || busy}
                  >
                    {flowState === "deploying"
                      ? "Deploying…"
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
                    {deploymentHash ? (
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
                  disabled={!account || !activeContract || busy || Boolean(request)}
                >
                  {flowState === "requesting"
                    ? "Confirming Tx1…"
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
                    {readiness?.phase === "permissionless"
                      ? "Anyone may rescue"
                      : "Requester first"}
                  </span>
                </div>

                {flowState === "proof-expired" || flowState === "expiring" ? (
                  <button
                    className="button button--danger button--wide"
                    type="button"
                    onClick={handleExpire}
                    disabled={!account || busy}
                  >
                    {flowState === "expiring"
                      ? "Marking expired…"
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
                        {" · "}last proof <b>{formatBlock(readiness.lastProofValidBlock)}</b>
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
            expiryHash={expiryHash}
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
            Enter a compatible platform and request ID. All authoritative data
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
            />
          </label>
          <button
            className="button button--lime"
            type="submit"
            disabled={explorerLoading}
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
            Integrating platforms own their instance, choose their own price, and
            keep their own storage, counters, caps, and revenue isolated.
          </p>
          <div className="source-links">
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
          <span>Monad RND</span>
        </a>
        <p>
          Open-source authenticated block entropy. Not a cryptographic VRF.
        </p>
        <span>Built for Monad builders · 2026</span>
      </footer>
    </main>
  );
}
