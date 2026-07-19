import type { Metadata, ResolvingMetadata } from "next";
import Link from "next/link";

const INTEGRATE_TITLE = "Integrate Monad RNG · Platform onboarding";
const INTEGRATE_DESCRIPTION =
  "Plan a production Monad RNG integration where Tx1 locks the request and Tx2 finalizes and permanently stores the result as one operated flow.";

export async function generateMetadata(
  _props: Record<string, never>,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const parentMetadata = await parent;
  const integrateUrl = parentMetadata.metadataBase
    ? new URL("/integrate", parentMetadata.metadataBase)
    : "/integrate";

  return {
    title: INTEGRATE_TITLE,
    description: INTEGRATE_DESCRIPTION,
    alternates: {
      canonical: integrateUrl,
    },
    openGraph: {
      type: "website",
      url: integrateUrl,
      siteName: parentMetadata.openGraph?.siteName ?? "Monad RNG",
      title: INTEGRATE_TITLE,
      description: INTEGRATE_DESCRIPTION,
      images: parentMetadata.openGraph?.images ?? undefined,
    },
    twitter: {
      card: parentMetadata.twitter?.card ?? "summary_large_image",
      title: INTEGRATE_TITLE,
      description: INTEGRATE_DESCRIPTION,
      images: parentMetadata.twitter?.images ?? undefined,
    },
  };
}

const guides = [
  {
    role: "Product leads + technical owners",
    title: "Decide whether the primitive fits",
    description:
      "Set the value ceiling, expiry policy, operating roles, gas budget, and Go/No-Go criteria before implementation.",
    file: "production-readiness.md",
  },
  {
    role: "Application + smart-contract engineers",
    title: "Build Tx1, Tx2, and settlement",
    description:
      "Choose direct EOA or wrapper mode, bind the business action, persist request identity, and settle exactly once.",
    file: "integration-guide.md",
  },
  {
    role: "Release + deployment engineers",
    title: "Deploy and verify every boundary",
    description:
      "Verify chain, approved address, runtime code, frozen settings, source, manifest, and a full canary flow separately.",
    file: "deployment-and-verification.md",
  },
  {
    role: "Operators + support teams",
    title: "Keep requests moving safely",
    description:
      "Run finalization, rescue, RPC failover, nonce reconciliation, expiry, monitoring, and incident procedures.",
    file: "operations-runbook.md",
  },
] as const;

const lifecycle = [
  {
    block: "R",
    meaning:
      "Tx1 locks the business action, stores the requester, and creates one pending request.",
  },
  {
    block: "R+8 · R+24 · R+40",
    meaning:
      "The three fixed target blocks contribute authenticated proposer entropy.",
  },
  {
    block: "R+42",
    meaning:
      "Requester-window Tx2 opens. Only the stored requester may finalize through R+103.",
  },
  {
    block: "R+104",
    meaning:
      "Permissionless rescue opens. Anyone may submit the same proof, but execution is still not automatic.",
  },
  {
    block: "R+8199",
    meaning:
      "Last contract-valid proof block. Tx2 must be included successfully by this block.",
  },
  {
    block: "R+8200",
    meaning:
      "Expiry starts. Tx2 is no longer valid; anyone may expire the request, and no result is created.",
  },
] as const;

export default function IntegratePage() {
  return (
    <main className="integrate-page">
      <header className="site-header integrate-header">
        <Link className="wordmark" href="/" aria-label="Monad RNG home">
          <span className="wordmark-mark" aria-hidden="true">
            M
          </span>
          <span>Monad RNG</span>
          <small>Platform guide</small>
        </Link>
        <Link
          className="button button--secondary integrate-header-action"
          href="/#demo"
        >
          Run demo
        </Link>
      </header>

      <section className="integrate-hero" aria-labelledby="integrate-title">
        <div className="integrate-hero-copy">
          <p className="eyebrow">Platform onboarding</p>
          <h1 id="integrate-title">Integrate Monad RNG</h1>
          <p className="integrate-lede">
            Start with the product boundary, choose who the contract records as
            requester, freeze the platform configuration, then build
            finalization and permanent settlement as one operated lifecycle.
          </p>
          <div className="integrate-actions">
            <a
              className="button button--primary"
              href="/docs/production-readiness.md"
              aria-label="Open the production readiness guide"
            >
              Start with readiness
            </a>
            <Link className="button button--secondary" href="/#demo">
              Try the reference demo
            </Link>
          </div>
        </div>

        <aside
          className="integrate-warning"
          aria-label="Required integration flow"
        >
          <span>Required product flow</span>
          <strong>
            Tx1 locks the request; Tx2 finalizes and permanently stores the
            random result. A production integration must operate both as one
            flow.
          </strong>
          <p>
            Tx2 needs an external caller, Monad gas, a compatible RPC, and a
            durable recovery path. No server is required, but permissionless
            does not mean automatic.
          </p>
        </aside>
      </section>

      <section
        className="integrate-section integrate-flow-section"
        aria-labelledby="flow-title"
      >
        <div className="integrate-section-heading">
          <p className="eyebrow">The complete path</p>
          <h2 id="flow-title">Design past the request transaction.</h2>
          <p>
            A request is unfinished until its authenticated result is stored and
            the application has settled the original business action exactly
            once.
          </p>
        </div>
        <ol className="integrate-flow">
          <li>
            <span>01 · Tx1</span>
            <h3>Lock the request</h3>
            <p>
              Atomically bind payment, eligibility, or inventory to one request.
              Persist its ID, requester, request block, and three fixed targets.
            </p>
          </li>
          <li>
            <span>02 · Wait</span>
            <h3>Wait for the targets</h3>
            <p>
              Use block height—not a wall-clock timer. The targets are R+8,
              R+24, and R+40; requester finalization opens at R+42.
            </p>
          </li>
          <li>
            <span>03 · Tx2</span>
            <h3>Authenticate and finalize</h3>
            <p>
              Fetch the three exact RLP headers from a checked Monad RPC. Submit
              them through the stored requester path and preserve the
              transaction.
            </p>
          </li>
          <li>
            <span>04 · Settle</span>
            <h3>Settle from stored result</h3>
            <p>
              Wait for finalized confirmation, verify the event against on-chain
              storage, then settle once from the permanent result.
            </p>
          </li>
        </ol>
      </section>

      <section
        className="integrate-section integrate-guides-section"
        aria-labelledby="guides-title"
      >
        <div className="integrate-section-heading">
          <p className="eyebrow">Start with your role</p>
          <h2 id="guides-title">Four guides, one operating model.</h2>
          <p>
            These public Markdown files are generated byte-for-byte from the
            repository&apos;s canonical onboarding documents.
          </p>
        </div>
        <div className="integrate-guide-grid">
          {guides.map((guide, index) => (
            <article className="integrate-guide-card" key={guide.file}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{guide.role}</p>
              <h3>{guide.title}</h3>
              <p>{guide.description}</p>
              <a
                href={`/docs/${guide.file}`}
                aria-label={`Read ${guide.title}: ${guide.file}`}
              >
                {guide.file} <span aria-hidden="true">↗</span>
              </a>
            </article>
          ))}
        </div>
      </section>

      <section
        className="integrate-section integrate-mode-section"
        aria-labelledby="mode-title"
      >
        <div className="integrate-section-heading">
          <p className="eyebrow">Requester architecture</p>
          <h2 id="mode-title">Choose direct EOA or wrapper deliberately.</h2>
          <p>
            Whoever calls <code>PlatformRandomness</code> in Tx1 becomes the
            stored requester and controls the requester-only Tx2 window.
          </p>
        </div>
        <div className="integrate-comparison">
          <article>
            <span>Direct EOA</span>
            <h3>The Tx1 wallet stays the requester.</h3>
            <ul>
              <li>An EOA calls the platform contract directly.</li>
              <li>
                That same EOA must finalize directly from R+42 through R+103.
              </li>
              <li>
                Use only when the business action can safely remain outside the
                request transaction.
              </li>
            </ul>
          </article>
          <article>
            <span>Application wrapper</span>
            <h3>The wrapper—not the player—becomes requester.</h3>
            <ul>
              <li>
                One wrapper call can lock payment, eligibility, inventory, and
                Tx1 atomically.
              </li>
              <li>
                A reviewed <code>finalizeEntry</code> function must forward
                requester-window Tx2 through the wrapper.
              </li>
              <li>
                Prefer this mode for paid entries, prizes, mints, assignments,
                and other value-bearing actions.
              </li>
            </ul>
          </article>
        </div>
        <p className="integrate-comparison-note">
          From R+104, permissionless rescue may finalize the underlying request
          directly. The application still has to reconcile and settle the
          wrapper entry exactly once.
        </p>
      </section>

      <section
        className="integrate-section integrate-lifecycle-section"
        aria-labelledby="lifecycle-title"
      >
        <div className="integrate-section-heading">
          <p className="eyebrow">Authoritative lifecycle</p>
          <h2 id="lifecycle-title">Block height is the source of truth.</h2>
          <p>
            R is the block containing Tx1. Internal warnings may start earlier,
            but they never change these contract boundaries.
          </p>
        </div>
        <div className="integrate-table-wrap">
          <table className="integrate-lifecycle-table">
            <caption>Monad RNG request lifecycle by block number</caption>
            <thead>
              <tr>
                <th scope="col">Block</th>
                <th scope="col">What becomes true</th>
              </tr>
            </thead>
            <tbody>
              {lifecycle.map((point) => (
                <tr key={point.block}>
                  <th scope="row">{point.block}</th>
                  <td>{point.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="integrate-section integrate-boundary-section"
        aria-labelledby="boundary-title"
      >
        <div className="integrate-section-heading">
          <p className="eyebrow">Production boundary</p>
          <h2 id="boundary-title">Know what your platform must supply.</h2>
          <p>
            The primitive authenticates and stores entropy. Product safety,
            transaction operations, and customer outcomes remain integration
            responsibilities.
          </p>
        </div>
        <ul className="integrate-boundaries">
          <li>
            <strong>Not a cryptographic VRF</strong>
            <span>
              Proposer skip bias remains. Set an approved value ceiling and use
              external VRF or threshold randomness above it.
            </span>
          </li>
          <li>
            <strong>Every caller funds its own gas</strong>
            <span>
              Zero protocol fee does not make deployment, Tx1, Tx2, rescue, or
              expiry gasless.
            </span>
          </li>
          <li>
            <strong>No automatic finalization or rescue</strong>
            <span>
              A funded external operator must submit every Tx2. Permissionless
              rescue only changes who is allowed to call. That caller can be a
              browser, script, serverless job, or keeper; an always-on server is
              not a protocol requirement.
            </span>
          </li>
          <li>
            <strong>V1 is ownerless and frozen</strong>
            <span>
              Revenue recipient, name, price, and pending policy are fixed at
              deployment. There is no owner, admin, pause, setter, proxy, or
              upgrade; a mistake or code change requires a new V2 address.
            </span>
          </li>
          <li>
            <strong>Free mode needs an anti-spam policy</strong>
            <span>
              <code>maxPending == 0</code> means unlimited. A positive free cap
              can be filled until requests finalize or expire, so add
              eligibility, economic, or rate controls in the integrating
              platform.
            </span>
          </li>
          <li>
            <strong>Revenue has one permanent destination</strong>
            <span>
              Anyone may trigger a revenue withdrawal, but the entire balance
              always goes to the deployment-fixed recipient. The caller cannot
              redirect it.
            </span>
          </li>
          <li>
            <strong>RPC and replacement limits are operational risks</strong>
            <span>
              Production needs checked raw-header RPC capacity, timeouts, and
              failover. Monad public RPC hides pending mempool transactions, so
              some replacements require manual sender-and-nonce reconciliation.
            </span>
          </li>
          <li>
            <strong>
              The browser is a reference demo, not a production SDK
            </strong>
            <span>
              Its localStorage and Web Locks are not a durable journal, shared
              queue, indexer, keeper, or cross-device idempotency system.
            </span>
          </li>
          <li>
            <strong>Only the Testnet baseline is validated</strong>
            <span>
              Only Monad Testnet chain 10143 has been validated for this
              release. Mainnet needs fresh RPC and EIP-2935 verification, an
              updated threat model, and an independent security review.
            </span>
          </li>
          <li>
            <strong>Expiry is terminal</strong>
            <span>
              From R+8200 the request cannot produce randomness. Expiry creates
              no result, protocol refund, keeper reward, or later retry right.
            </span>
          </li>
        </ul>
      </section>

      <section className="integrate-final">
        <p className="eyebrow">Ready to evaluate the flow?</p>
        <h2>Run the reference path, then build from the guides.</h2>
        <p>
          The demo makes Tx1, the target wait, Tx2, stored reads, rescue, and
          expiry visible. The public artifact supplies the exact ABI and
          bytecode. Production teams must also verify a raw-header RPC with{" "}
          <code>debug_getRawHeader</code>.
        </p>
        <div className="integrate-actions">
          <Link className="button button--primary" href="/#demo">
            Run the two-transaction demo
          </Link>
          <a
            className="button button--secondary"
            href="/contracts/PlatformRandomness.json"
            aria-label="Open the PlatformRandomness ABI and bytecode artifact"
          >
            Open platform artifact
          </a>
          <a
            className="button button--secondary"
            href="/contracts/RandomnessFactory.json"
            aria-label="Open the ownerless RandomnessFactory ABI and bytecode artifact"
          >
            Open Factory artifact
          </a>
        </div>
      </section>

      <footer className="integrate-footer">
        <Link className="wordmark" href="/" aria-label="Back to Monad RNG home">
          <span className="wordmark-mark" aria-hidden="true">
            M
          </span>
          <span>Monad RNG</span>
        </Link>
        <p>
          Authenticated multi-block proposer entropy. Not a cryptographic VRF.
        </p>
        <Link href="/">Back to home →</Link>
      </footer>
    </main>
  );
}
