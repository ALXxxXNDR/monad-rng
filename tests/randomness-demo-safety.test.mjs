import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const demoUrl = new URL(
  "../app/components/RandomnessDemo.tsx",
  import.meta.url,
);
const demoSource = await readFile(demoUrl, "utf8");
const demoAst = ts.createSourceFile(
  demoUrl.pathname,
  demoSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function declarationSource(name) {
  for (const statement of demoAst.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name
    ) {
      return statement.getText(demoAst);
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === name,
      )
    ) {
      return statement.getText(demoAst);
    }
  }
  throw new Error(`Missing declaration ${name}`);
}

async function loadPureSafetyHelpers() {
  const TypeScript = [
    "BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS",
    "proofSafetyCutoffBlock",
    "isBrowserProofCutoff",
    "preferredScrollBehavior",
    "workspaceOperationMatches",
    "recoveryWorkspaceMayApply",
    "pendingMatchesAction",
    "pendingFailureDisposition",
    "visibleHashesAfterConfirmedRevert",
  ]
    .map(declarationSource)
    .join("\n");
  const JavaScript = ts.transpileModule(TypeScript, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(JavaScript).toString("base64")}`
  );
}

function functionDeclaration(name) {
  let declaration;
  function visit(node) {
    if (
      !declaration &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(demoAst);
  assert.ok(declaration, `Missing function ${name}`);
  return declaration;
}

function functionBody(name) {
  return functionDeclaration(name).getText(demoAst);
}

function identifierCallName(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    ? node.expression.text
    : undefined;
}

function descendantCalls(root, names) {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && names.has(identifierCallName(node))) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return calls;
}

function hasAncestorCall(node, callName, root) {
  for (let current = node.parent; current && current !== root; current = current.parent) {
    if (identifierCallName(current) === callName) return true;
  }
  return false;
}

test("the browser Tx2 cutoff starts exactly 64 blocks before proof expiry", async () => {
  const {
    BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS,
    proofSafetyCutoffBlock,
    isBrowserProofCutoff,
  } = await loadPureSafetyHelpers();
  const lastProofValidBlock = 8_299n;
  const readiness = {
    phase: "permissionless",
    lastProofValidBlock,
    firstExpiryBlock: lastProofValidBlock + 1n,
  };

  assert.equal(BROWSER_PROOF_INCLUSION_BUFFER_BLOCKS, 64n);
  assert.equal(proofSafetyCutoffBlock(lastProofValidBlock), 8_235n);
  assert.equal(isBrowserProofCutoff(readiness, 8_234n), false);
  assert.equal(isBrowserProofCutoff(readiness, 8_235n), true);
  assert.equal(isBrowserProofCutoff(readiness, lastProofValidBlock), true);
  assert.equal(
    isBrowserProofCutoff(
      { ...readiness, phase: "proof-expired" },
      readiness.firstExpiryBlock,
    ),
    false,
  );
});

test("workspace operation identity rejects a result from another selection", async () => {
  const { recoveryWorkspaceMayApply, workspaceOperationMatches } =
    await loadPureSafetyHelpers();
  const original = {
    epoch: 4,
    contractAddress: "0xaaaa",
    requestId: "7",
  };

  assert.equal(workspaceOperationMatches(original, { ...original }), true);
  assert.equal(
    workspaceOperationMatches(original, { ...original, epoch: 5 }),
    false,
  );
  assert.equal(
    workspaceOperationMatches(original, {
      ...original,
      contractAddress: "0xbbbb",
    }),
    false,
  );
  assert.equal(
    workspaceOperationMatches(original, { ...original, requestId: "8" }),
    false,
  );
  assert.equal(recoveryWorkspaceMayApply(3, 3, original, { ...original }), true);
  assert.equal(recoveryWorkspaceMayApply(3, 4, original, { ...original }), false);
  assert.equal(
    recoveryWorkspaceMayApply(3, 3, original, {
      ...original,
      contractAddress: "0xbbbb",
    }),
    false,
  );
});

test("pending writes block only the exact action identity", async () => {
  const { pendingMatchesAction } = await loadPureSafetyHelpers();
  const chainId = 10_143;
  const contractAddress = "0x4000000000000000000000000000000000000004";
  const otherContract = "0x5000000000000000000000000000000000000005";
  const requester = "0x6000000000000000000000000000000000000006";
  const otherRequester = "0x7000000000000000000000000000000000000007";
  const base = {
    chainId,
    transactionHash: `0x${"11".repeat(32)}`,
    createdAt: 1,
  };

  assert.equal(
    pendingMatchesAction(
      { ...base, kind: "deployment" },
      { kind: "deployment", chainId },
    ),
    true,
  );
  assert.equal(
    pendingMatchesAction(
      { ...base, kind: "request", contractAddress, requester },
      {
        kind: "request",
        chainId,
        contractAddress: contractAddress.toUpperCase(),
        requester: requester.toUpperCase(),
      },
    ),
    true,
  );
  assert.equal(
    pendingMatchesAction(
      { ...base, kind: "request", contractAddress, requester },
      {
        kind: "request",
        chainId,
        contractAddress,
        requester: otherRequester,
      },
    ),
    false,
  );
  assert.equal(
    pendingMatchesAction(
      { ...base, kind: "request", contractAddress },
      { kind: "request", chainId, contractAddress: otherContract },
    ),
    false,
  );
  assert.equal(
    pendingMatchesAction(
      {
        ...base,
        kind: "finalization",
        contractAddress,
        requestId: "7",
      },
      {
        kind: "finalization",
        chainId,
        contractAddress,
        requestId: "7",
      },
    ),
    true,
  );
  assert.equal(
    pendingMatchesAction(
      {
        ...base,
        kind: "finalization",
        contractAddress,
        requestId: "7",
      },
      {
        kind: "expiry",
        chainId,
        contractAddress,
        requestId: "7",
      },
    ),
    false,
  );
  assert.equal(
    pendingMatchesAction(
      {
        ...base,
        kind: "expiry",
        contractAddress,
        requestId: "7",
      },
      {
        kind: "expiry",
        chainId,
        contractAddress,
        requestId: "8",
      },
    ),
    false,
  );
});

test("only a confirmed revert makes a pending write safe to forget", async () => {
  const {
    pendingFailureDisposition,
    visibleHashesAfterConfirmedRevert,
  } = await loadPureSafetyHelpers();

  assert.equal(pendingFailureDisposition("TRANSACTION_REVERTED"), "forget");
  assert.equal(pendingFailureDisposition("TRANSACTION_REPLACED"), "forget");
  assert.equal(pendingFailureDisposition("UNKNOWN"), "retain");
  assert.equal(pendingFailureDisposition("WRONG_NETWORK"), "retain");
  assert.equal(pendingFailureDisposition("INVALID_REQUEST"), "retain");

  const visible = {
    deploymentHash: "pending-deployment",
    tx1Hash: "pending-tx1",
    tx2Hash: "pending-tx2",
    expiryHash: "pending-expiry",
  };
  const saved = {
    deploymentHash: "saved-deployment",
    tx1Hash: "saved-tx1",
    tx2Hash: "saved-tx2",
    expiryHash: "saved-expiry",
  };
  assert.deepEqual(
    visibleHashesAfterConfirmedRevert("deployment", visible, saved),
    { ...visible, deploymentHash: saved.deploymentHash },
  );
  assert.deepEqual(
    visibleHashesAfterConfirmedRevert("request", visible, saved),
    { ...visible, tx1Hash: saved.tx1Hash },
  );
  assert.deepEqual(
    visibleHashesAfterConfirmedRevert("finalization", visible, saved),
    { ...visible, tx2Hash: saved.tx2Hash },
  );
  assert.deepEqual(
    visibleHashesAfterConfirmedRevert("expiry", visible, saved),
    { ...visible, expiryHash: saved.expiryHash },
  );
});

test("reduced-motion preference removes scripted smooth scrolling", async () => {
  const { preferredScrollBehavior } = await loadPureSafetyHelpers();

  assert.equal(preferredScrollBehavior(false), "smooth");
  assert.equal(preferredScrollBehavior(true), "auto");
});

test("wallet events are subscribed, cleaned up, and every write rechecks Monad", () => {
  for (const eventName of [
    "accountsChanged",
    "chainChanged",
    "disconnect",
  ]) {
    assert.match(
      demoSource,
      new RegExp(`\\.on\\?\\.\\(\\s*"${eventName}"`),
    );
    assert.match(
      demoSource,
      new RegExp(`\\.removeListener\\?\\.\\(\\s*"${eventName}"`),
    );
  }

  for (const handler of [
    "handleDeploy",
    "handleRequest",
    "handleFinalize",
    "handleExpire",
  ]) {
    assert.match(
      functionBody(handler),
      /await prepareWalletWrite\(/,
      `${handler} must re-verify the chain and current wallet account`,
    );
  }
  const finalize = functionBody("handleFinalize");
  assert.ok(
    finalize.lastIndexOf("await prepareWalletWrite(") >
      finalize.indexOf("await fetchRawHeaders("),
    "Tx2 must re-verify the wallet after header fetching, immediately before writing",
  );
});

test("cross-tab storage sync and exact-action locks are wired into every wallet write", () => {
  assert.match(demoSource, /\bsubscribeToStoredState\(/);
  assert.match(
    demoSource,
    /useEffect\(\(\)\s*=>\s*subscribeToStoredState\([\s\S]{0,500}setLocalState/,
    "the storage subscription cleanup must be returned by the effect",
  );

  for (const handler of [
    "handleDeploy",
    "handleRequest",
    "handleFinalize",
    "handleExpire",
  ]) {
    assert.match(
      functionBody(handler),
      /\bawait runWithPendingWriteLock\(/,
      `${handler} must use its exact-action Web Lock`,
    );
  }
  const request = functionBody("handleRequest");
  assert.ok(
    request.indexOf("const currentAccount = await prepareWalletWrite(") <
      request.indexOf("await runWithPendingWriteLock("),
    "Tx1 must recheck the wallet account before choosing its action lock",
  );
  assert.match(
    request,
    /action:\s*\{[\s\S]{0,220}kind:\s*"request"[\s\S]{0,220}requester:\s*currentAccount/,
    "Tx1 lock identity must use the rechecked wallet account",
  );
});

test("all UI storage mutations use the short shared lock while wallet writers use only exact-action locks", () => {
  const component = functionDeclaration("RandomnessDemo");
  const mutationNames = new Set([
    "rememberDemoContract",
    "rememberRequest",
    "rememberPendingTransaction",
    "forgetPendingTransaction",
  ]);
  const mutationCalls = descendantCalls(component, mutationNames);
  assert.ok(mutationCalls.length > 0);
  for (const call of mutationCalls) {
    assert.equal(
      hasAncestorCall(call, "runWithStoredStateMutationLock", component),
      true,
      `${identifierCallName(call)} must run inside the shared storage mutation lock`,
    );
  }

  const writerNames = new Set([
    "deployDemoPlatform",
    "requestRandomnessTx",
    "finalizeRandomnessTx",
    "expireRandomnessRequest",
  ]);
  for (const call of descendantCalls(component, writerNames)) {
    assert.equal(
      hasAncestorCall(call, "runWithPendingWriteLock", component),
      true,
      `${identifierCallName(call)} must remain inside its exact-action lock`,
    );
    assert.equal(
      hasAncestorCall(call, "runWithStoredStateMutationLock", component),
      false,
      `${identifierCallName(call)} must never run inside the shared storage lock`,
    );
  }

  const sharedLockCalls = descendantCalls(
    component,
    new Set(["runWithStoredStateMutationLock"]),
  );
  let groupedRememberAndForget = 0;
  for (const lockCall of sharedLockCalls) {
    const options = lockCall.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(options));
    const mutateProperty = options.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "mutate",
    );
    assert.ok(
      mutateProperty && ts.isPropertyAssignment(mutateProperty),
      "shared storage lock must receive a mutate callback",
    );
    const callback = mutateProperty.initializer;
    assert.ok(
      ts.isArrowFunction(callback) || ts.isFunctionExpression(callback),
      "the mutate callback must be a short synchronous function",
    );
    assert.equal(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);

    const callbackCalls = descendantCalls(callback, new Set([
      ...mutationNames,
      "loadStoredState",
      "deployDemoPlatform",
      "requestRandomnessTx",
      "finalizeRandomnessTx",
      "expireRandomnessRequest",
      "recoverDemoDeployment",
      "recoverRandomnessRequestTx",
      "recoverRandomnessFinalizationTx",
      "recoverRandomnessExpiryTx",
      "readRandomnessResult",
      "applyLocalState",
    ]));
    const callbackNames = new Set(callbackCalls.map(identifierCallName));
    assert.equal(
      [...callbackNames].some((name) =>
        [
          "deployDemoPlatform",
          "requestRandomnessTx",
          "finalizeRandomnessTx",
          "expireRandomnessRequest",
          "recoverDemoDeployment",
          "recoverRandomnessRequestTx",
          "recoverRandomnessFinalizationTx",
          "recoverRandomnessExpiryTx",
          "readRandomnessResult",
          "applyLocalState",
        ].includes(name),
      ),
      false,
      "shared storage lock callbacks must contain only short local-state work",
    );
    if (
      [...callbackNames].some((name) => name?.startsWith("remember")) &&
      callbackNames.has("forgetPendingTransaction")
    ) {
      groupedRememberAndForget += 1;
    }
  }
  assert.ok(
    groupedRememberAndForget >= 8,
    "each paid-write and manual-recovery success must group remember + forget atomically",
  );
});

test("all broadcast callbacks persist recovery records before writer completion", () => {
  const expectations = [
    ["handleDeploy", "deployDemoPlatform", "deployment", "setDeploymentHash"],
    ["handleRequest", "requestRandomnessTx", "request", "setTx1Hash"],
    [
      "handleFinalize",
      "finalizeRandomnessTx",
      "finalization",
      "setTx2Hash",
    ],
    ["handleExpire", "expireRandomnessRequest", "expiry", "setExpiryHash"],
  ];

  for (const [handler, writer, kind, visibleSetter] of expectations) {
    const body = functionBody(handler);
    const writerStart = body.indexOf(`await ${writer}({`);
    const callback = body.indexOf("onTransactionHash", writerStart);
    const persist = body.indexOf("rememberPendingTransaction(", callback);
    const visible = body.indexOf(`${visibleSetter}(`, callback);
    assert.ok(writerStart >= 0, `${handler} must await ${writer}`);
    assert.ok(callback > writerStart, `${handler} must receive the broadcast hash`);
    assert.ok(persist > callback, `${handler} must persist the pending ${kind}`);
    assert.ok(visible > callback, `${handler} must expose the submitted hash`);
    assert.match(
      body.slice(callback, Math.max(persist, visible) + 500),
      new RegExp(`kind:\\s*"${kind}"`),
    );
  }
});

test("manual recovery wires every read-only recovery path and safe storage policy", () => {
  for (const recovery of [
    "recoverDemoDeployment",
    "recoverRandomnessRequestTx",
    "recoverRandomnessFinalizationTx",
    "recoverRandomnessExpiryTx",
  ]) {
    assert.match(demoSource, new RegExp(`\\b${recovery}\\b`));
  }
  for (const storageApi of [
    "rememberPendingTransaction",
    "forgetPendingTransaction",
    "readPendingTransactions",
  ]) {
    assert.match(demoSource, new RegExp(`\\b${storageApi}\\b`));
  }
  assert.match(demoSource, /Check submitted transaction/);
  assert.match(demoSource, /transactionExplorerUrl\(submittedPending\.transactionHash\)/);
  assert.match(demoSource, /const busy = writeBusy \|\| recoveryLoading/);
  assert.match(
    demoSource,
    /writeBusyRef\.current\s*\|\|\s*recoveryBusyRef\.current/,
  );
  assert.match(
    demoSource,
    /recoveryBusyRef\.current\s*\|\|\s*writeBusyRef\.current/,
  );
  assert.match(demoSource, /pendingFailureDisposition\(mapped\.code\)/);
  assert.match(demoSource, /activeReference\?\.expiryHash/);
  assert.match(demoSource, /explorerReference\?\.expiryHash/);

  const recovery = functionBody("handleCheckSubmittedTransaction");
  assert.match(recovery, /recoveryWorkspaceIdentity/);
  assert.match(recovery, /recoveryWorkspaceMayApply\(/);

  const submittedFailure = functionBody("handleSubmittedFailure");
  assert.match(submittedFailure, /loadStoredState\(/);
  assert.match(submittedFailure, /visibleHashesAfterConfirmedRevert\(/);
  for (const setter of [
    "setDeploymentHash",
    "setTx1Hash",
    "setTx2Hash",
    "setExpiryHash",
  ]) {
    assert.match(submittedFailure, new RegExp(`${setter}\\(`));
  }
});

test("UI safety copy distinguishes demo cutoff, rescue, and exact proof expiry", () => {
  assert.match(demoSource, /Demo Tx2 safety stop/);
  assert.match(demoSource, /64 blocks early/);
  assert.match(demoSource, /On-chain proof remains valid through exact block/);
  assert.match(demoSource, /Advanced callers may use the contract directly/);
  assert.match(demoSource, /rescue/);
  assert.match(demoSource, /last on-chain proof/);
  assert.match(demoSource, /Switch to Monad testnet/);
  assert.match(demoSource, /exact published\s+PlatformRandomness contract/);
  assert.match(demoSource, /runtime bytecode hash is verified/);
});

test("workspace-changing controls lock during writes and current block is not live", () => {
  assert.match(
    demoSource,
    /onClick=\{handleLoadIntoWorkspace\}[\s\S]{0,160}disabled=\{busy\}/,
  );
  assert.match(
    demoSource,
    /id="platform-address"[\s\S]{0,400}disabled=\{busy\}/,
  );
  assert.match(
    demoSource,
    /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/,
  );

  const banner = functionBody("StateBanner");
  const liveRegionEnd = banner.indexOf("</div>", banner.indexOf('aria-live="polite"'));
  const blockReadout = banner.indexOf('className="block-readout"');
  assert.ok(liveRegionEnd !== -1 && blockReadout > liveRegionEnd);
});
