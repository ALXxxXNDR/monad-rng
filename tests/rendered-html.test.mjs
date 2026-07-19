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

test("server-renders the complete Monad RND public-good landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Monad RND · Public randomness for Monad<\/title>/i);
  assert.match(html, /Monad RND/);
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
  assert.match(html, /Integrate Monad RND/i);
  assert.match(html, /Tx1 locks the request/i);
  assert.match(html, /Tx2 finalizes and permanently stores/i);
  assert.match(html, /production-readiness\.md/);
  assert.match(html, /integration-guide\.md/);
  assert.match(html, /deployment-and-verification\.md/);
  assert.match(html, /operations-runbook\.md/);
  assert.match(html, /reference demo, not a production SDK/i);
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
  assert.match(layout, /Monad RND · Public randomness for Monad/);
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

test("publishes product metadata, social preview, and a dedicated favicon", async () => {
  const [favicon, layout, socialCard] = await Promise.all([
    readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(layout, /lang="en"/);
  assert.match(layout, /Public randomness infrastructure with zero protocol fees/);
  assert.match(layout, /await headers\(\)/);
  assert.match(layout, /new URL\("\/og\.png", origin\)/);
  assert.ok(socialCard.byteLength > 100_000);
  assert.match(favicon, /aria-label="Monad RND"/);
  assert.match(favicon, /#836EF9/i);
  assert.match(favicon, /#C8FF65/i);
  assert.doesNotMatch(favicon, /#68C4FF|#0C79D8|#2E9EFF/i);
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
});
