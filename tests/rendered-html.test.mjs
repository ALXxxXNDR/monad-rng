import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;
const templateRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the complete Monad RNG public-good landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Monad RNG · Public randomness for Monad<\/title>/i);
  assert.match(html, /Monad RNG/);
  assert.doesNotMatch(html, /Monad RND/);
  assert.match(html, /Connect wallet/);
  assert.match(html, /Tx1 · Lock request/);
  assert.match(html, /Tx2 · Store result/);
  assert.match(html, /Result explorer/);
  assert.match(html, /Protocol fee · 0/);
  assert.match(
    html,
    /Authenticated multi-block proposer entropy, not a cryptographic VRF\./,
  );
  assert.match(html, /Every caller pays their own Monad gas\./);
  assert.match(html, /Each platform sets its own request price, including zero\./);
  assert.match(
    html,
    /No project treasury, relayer, keeper reward, or gas subsidy\./,
  );
  assert.match(html, /\+8 · \+24 · \+40/);
  assert.match(html, /T\+64/);
  assert.match(html, /\+8,191/);
  assert.match(html, /Requester/);
  assert.match(html, /Finalizer/);
  assert.match(html, /1–100 draw/);
  assert.match(
    html,
    /<nav[^>]*aria-label="Primary navigation"[^>]*>(?:(?!<\/nav>)[\s\S])*?<a[^>]*href="\/integrate"[^>]*>Integrate<\/a>/i,
  );
  assert.match(
    html,
    /<a(?=[^>]*class="[^"]*\bbutton\b[^"]*\bbutton--secondary\b[^"]*")(?=[^>]*href="\/integrate")[^>]*>Integration guide<\/a>/i,
  );
  assert.match(
    html,
    /<section[^>]*class="public-good-section"[^>]*>(?:(?!<\/section>)[\s\S])*?<a[^>]*href="\/integrate"[^>]*>Platform onboarding →<\/a>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*property="og:image")(?=[^>]*content="http:\/\/localhost\/og\.png")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*name="twitter:card")(?=[^>]*content="summary_large_image")[^>]*>/i,
  );

  assert.doesNotMatch(html, developmentPreviewMeta);
  assert.doesNotMatch(html, /Your site is taking shape|Codex is working/i);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("server-renders the platform integration hub", async () => {
  const response = await render("/integrate");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<link(?=[^>]*rel="canonical")(?=[^>]*href="http:\/\/localhost\/integrate")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*property="og:url")(?=[^>]*content="http:\/\/localhost\/integrate")[^>]*>/i,
  );
  assert.match(
    html,
    /<title>Integrate Monad RNG · Platform onboarding<\/title>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*name="description")(?=[^>]*content="Plan a production Monad RNG integration where Tx1 locks the request and Tx2 finalizes and permanently stores the result as one operated flow\.")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*property="og:image")(?=[^>]*content="http:\/\/localhost\/og\.png")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*name="twitter:card")(?=[^>]*content="summary_large_image")[^>]*>/i,
  );

  assert.match(html, /Integrate Monad RNG/i);
  assert.doesNotMatch(html, /Monad RND/);
  assert.match(
    html,
    /Tx1 locks the request;\s*Tx2 finalizes and permanently stores the random\s*result\. A production integration must operate both as one flow\./i,
  );

  for (const guide of [
    "testnet-deployment.md",
    "production-readiness.md",
    "integration-guide.md",
    "deployment-and-verification.md",
    "operations-runbook.md",
  ]) {
    assert.match(
      html,
      new RegExp(`href=["']/docs/${guide.replace(".", "\\.")}["']`, "i"),
    );
  }

  assert.match(html, /0x22A5Ed6bA91661cd06D68FBa5aae5015EDbF7DA1/);
  assert.match(html, /0x75E6458DaA0c6152419e4617dcf4D459149C1530/);
  assert.match(html, /Start from the attested contracts/i);
  assert.match(html, /href="\/deployments\/monad-testnet-v1\.json"/i);
  assert.match(html, /Direct EOA/i);
  assert.match(
    html,
    /same EOA must finalize directly from R\+42 through R\+103/i,
  );
  assert.match(html, /wrapper—not the player—becomes requester/i);
  assert.match(html, /finalizeEntry/i);

  for (const blockPoint of [
    "R",
    "R\\+8 · R\\+24 · R\\+40",
    "R\\+42",
    "R\\+104",
    "R\\+8199",
    "R\\+8200",
  ]) {
    assert.match(
      html,
      new RegExp(`<th[^>]*scope=["']row["'][^>]*>${blockPoint}</th>`, "i"),
    );
  }

  assert.match(html, /Not a cryptographic VRF/i);
  assert.match(html, /Every caller funds its own gas/i);
  assert.match(html, /No automatic finalization or rescue/i);
  assert.match(
    html,
    /Permissionless rescue only changes who is allowed to call/i,
  );
  assert.match(html, /RPC and replacement limits are operational risks/i);
  assert.match(html, /Monad public RPC hides pending mempool transactions/i);
  assert.match(html, /reference demo, not a production SDK/i);
  assert.match(
    html,
    /Only Monad Testnet chain 10143 has been validated for this release/i,
  );
  assert.match(
    html,
    /Mainnet needs fresh RPC and EIP-2935 verification, an updated threat model, and an independent security review/i,
  );
  assert.match(html, /Expiry is terminal/i);
  assert.match(
    html,
    /Expiry creates no result, protocol refund, keeper reward, or later retry right/i,
  );
});

test("build publishes every canonical onboarding guide byte for byte", async () => {
  for (const guide of [
    "production-readiness.md",
    "integration-guide.md",
    "deployment-and-verification.md",
    "operations-runbook.md",
  ]) {
    const [canonical, built] = await Promise.all([
      readFile(new URL(`../docs/${guide}`, import.meta.url)),
      readFile(new URL(`../dist/client/docs/${guide}`, import.meta.url)),
    ]);
    assert.deepEqual(built, canonical, `${guide} must be present in the build`);
  }
});

test("ships real wallet flows and removes the disposable starter preview", async () => {
  const [page, layout, demo, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/RandomnessDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(page, /<RandomnessDemo \/>/);
  assert.match(layout, /Monad RNG · Public randomness for Monad/);
  assert.doesNotMatch(page + layout, /codex-preview|SkeletonPreview|Starter Project/);

  for (const operation of [
    "connectMonadWallet",
    "createMonadPublicClient",
    "createMonadWalletClient",
    "deployDemoPlatform",
    "requestRandomnessTx",
    "fetchRawHeaders",
    "finalizeRandomnessTx",
    "expireRandomnessRequest",
    "readRandomnessResult",
    "rememberDemoContract",
    "rememberRequest",
  ]) {
    assert.match(demo, new RegExp(`\\b${operation}\\b`));
  }

  for (const state of [
    "disconnected",
    "wrong-network",
    "ready",
    "deploying",
    "requesting",
    "waiting",
    "finalizing",
    "rescue-ready",
    "proof-expired",
    "expiring",
    "expired",
    "finalized",
    "error",
  ]) {
    assert.match(demo, new RegExp(`["']${state}["']`));
  }

  assert.match(demo, /getBlockNumber/);
  assert.match(demo, /setInterval/);
  assert.match(demo, /navigator\.clipboard/);
  assert.match(demo, /idPrefix:\s*string/);
  assert.match(demo, /idPrefix="active"/);
  assert.match(demo, /idPrefix="explorer"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("promotes a wallet-free lookup into the resumable Tx2 workspace", async () => {
  const demo = await readFile(
    new URL("../app/components/RandomnessDemo.tsx", import.meta.url),
    "utf8",
  );

  assert.match(demo, /function handleLoadIntoWorkspace/);
  assert.match(demo, /Load into Tx2 workspace/);
  assert.match(demo, /setActiveContract\(explorerResult\.contractAddress\)/);
  assert.match(demo, /setRequestId\(explorerResult\.requestId\)/);
  assert.match(demo, /setRequest\(explorerResult\.request\)/);
  assert.match(demo, /explorerReference\?\.tx1Hash/);
  assert.match(demo, /calculateReadiness/);
});

test("prefills the wallet-free explorer with the newest locally saved Monad request", async () => {
  const demo = await readFile(
    new URL("../app/components/RandomnessDemo.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    demo,
    /const newestMonadRequest = stored\.recentRequests\.find\(/,
  );
  assert.match(
    demo,
    /setExplorerContract\(newestMonadRequest\.contractAddress\)/,
  );
  assert.match(
    demo,
    /setExplorerRequestId\(newestMonadRequest\.requestId\)/,
  );
  assert.match(demo, /Latest saved Monad request/);
  assert.match(demo, /Read on-chain to verify its current status/);
});

test("publishes product metadata, matching RNG social images, and a dedicated favicon", async () => {
  const [favicon, layout, socialCard, submissionCover] = await Promise.all([
    readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/og.png", import.meta.url)),
    readFile(new URL("../public/submission-cover.png", import.meta.url)),
  ]);

  assert.match(layout, /lang="en"/);
  assert.match(layout, /Public randomness infrastructure with zero protocol fees/);
  assert.match(layout, /await headers\(\)/);
  assert.match(layout, /new URL\("\/og\.png", origin\)/);
  assert.match(layout, /width:\s*1_672/);
  assert.match(layout, /height:\s*941/);
  assert.ok(socialCard.byteLength > 100_000);
  assert.deepEqual(submissionCover, socialCard);
  assert.equal(socialCard.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(socialCard.readUInt32BE(16), 1_672);
  assert.equal(socialCard.readUInt32BE(20), 941);
  assert.match(favicon, /aria-label="Monad RNG"/);
  assert.match(favicon, /#836EF9/i);
  assert.match(favicon, /#C8FF65/i);
  assert.doesNotMatch(favicon, /#68C4FF|#0C79D8|#2E9EFF/i);
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
});
