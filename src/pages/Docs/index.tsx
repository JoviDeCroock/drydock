import type { ComponentChildren } from "preact";
import { Badge, Card, Eyebrow, LinkButton, PageShell, SectionLabel } from "../../components";
import { docsPageSeo, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

export default function DocsPage() {
  const authed = useAuthedSession();

  return (
    <PageShell class="gap-12" headerActions={<MarketingHeaderActions authed={authed} />}>
      <PageSeo metadata={docsPageSeo} />
      <header class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Documentation</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Pick where Drydock pauses your release.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          The package that reaches a registry is not the pull request a maintainer reviewed. It is
          the built output from scripts, bundlers, and CI. Drydock pauses npm staged publishes or
          GitHub-gated PyPI and npm jobs, compares the candidate with the last published version,
          and pins findings to changed lines. Maintainers decide; Drydock never publishes, never
          stores publish credentials, and never executes package contents.
        </p>
        <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">
          Use registry staging when npm can hold the candidate. Use workflow gating when GitHub
          Actions builds the release and a GitHub Environment can pause the publish job. Both paths
          produce the same review report:
        </p>
        <nav class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-1" aria-label="Integration modes">
          <ModeCard href="#staged-publishing" title="Staged publishing: npm">
            Run <Code>npm publish --stage</Code>. npm holds a private candidate, Drydock reviews it,
            and you complete the publish in npm with your own 2FA.
          </ModeCard>
          <ModeCard href="#workflow-gating" title="Workflow gating: PyPI & npm" badge="Preview">
            GitHub Actions builds and uploads the release artifact. A GitHub Environment pauses
            publishing until a maintainer approves or rejects the Drydock review.
          </ModeCard>
        </nav>
      </header>

      <div class="flex flex-col gap-14">
        <section id="staged-publishing" class="flex flex-col gap-8 scroll-mt-6">
          <div class="flex flex-col gap-3">
            <SectionLabel>Staged publishing: npm</SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
              npm holds the candidate; you keep the approval.
            </h2>
            <Prose>
              npm staged publishing gives Drydock a private release candidate to inspect. Run{" "}
              <Code>npm publish --stage</Code>; npm holds the new version until you confirm with
              2FA; Drydock reviews the staged tarball before that confirmation.
            </Prose>
          </div>

          <Subsection title="Set it up">
            <Steps
              items={[
                <>Sign in and choose the organization that publishes the package.</>,
                <>
                  Open <Code>Organization settings → npm access</Code> and paste an automation or
                  granular npm token that can read the org's packages and list staged publishes.
                </>,
                <>
                  Save. Drydock encrypts the token and checks it against the registry right away.
                </>,
                <>
                  That's it. Drydock picks up new staged publishes automatically, and{" "}
                  <Code>Check npm</Code> on the dashboard runs a check on demand.
                </>,
              ]}
            />
            <div class="flex flex-wrap gap-2 pt-1">
              <LinkButton href="/dashboard/settings?tab=integrations" size="sm">
                Open Organization settings
              </LinkButton>
            </div>
          </Subsection>

          <Subsection title="Review lifecycle">
            <Steps
              items={[
                <>
                  Drydock finds a new staged publish, either automatically or when you hit{" "}
                  <Code>Check npm</Code>, and queues a scan for it.
                </>,
                <>
                  Your npm token is stored encrypted and only decrypted at the moment Drydock needs
                  to talk to the registry.
                </>,
                <>
                  A short-lived sandbox downloads the staged version. The token is attached by a
                  separate gateway, so the sandbox never sees it.
                </>,
                <>
                  The sandbox unpacks the archive into file listings and text samples. Nothing in
                  the package is executed.
                </>,
                <>
                  Drydock selects the right earlier version to compare against, diffs the two
                  packages, checks what changed, and saves the report.
                </>,
                <>
                  You read the report on the dashboard, record your decision, and Drydock opens
                  npm's staged-packages page for the signed-in token owner. You still approve or
                  decline in npm with your normal 2FA; Drydock never publishes on your behalf.
                </>,
              ]}
            />
          </Subsection>
        </section>

        <section id="workflow-gating" class="flex flex-col gap-8 scroll-mt-6">
          <div class="flex flex-col gap-3">
            <SectionLabel>
              Workflow gating: PyPI &amp; npm on GitHub Actions <Badge tone="info">Preview</Badge>
            </SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
              When the registry can't pause, the workflow can.
            </h2>
            <Prose>
              PyPI has no staging step, and some npm workflows publish directly from CI. For those
              releases, the publish job becomes the checkpoint: CI builds wheels, sdists, or
              tarballs, uploads them as a workflow artifact, and enters a GitHub Environment
              protected by Drydock. Drydock reviews the upload and records a recommendation; a
              maintainer approves or rejects in the workbench; if approved, the job continues using
              its own credential.
            </Prose>
            <Prose>
              PyPI and npm use the same gate. Drydock detects each package's ecosystem from the
              uploaded files, so this walkthrough uses PyPI as the example. For npm, a workflow gate
              is the alternative to{" "}
              <a class="underline" href="#staged-publishing">
                staged-publish review
              </a>{" "}
              when a repository publishes without staging.
            </Prose>
          </div>

          <Subsection title="Set it up">
            <Steps
              items={[
                <>Sign in and choose the organization that owns the PyPI project.</>,
                <>
                  Open <Code>Organization settings → GitHub App</Code> and install the Drydock
                  GitHub App on the GitHub account that hosts your repository. You'll be redirected
                  to GitHub to pick the account and grant access to the repo, then back to Drydock.
                </>,
                <>
                  In the repository, create a GitHub Environment (for example <Code>pypi</Code>),
                  configure it as a PyPI Trusted Publisher, and enable Drydock as a custom
                  deployment protection rule on that same environment.
                </>,
                <>
                  On the same settings page, map the repository and environment so Drydock knows
                  which organization a held publish belongs to. Packages and ecosystems are derived
                  from the uploaded artifacts.
                </>,
                <>
                  Add the build and publish workflow below. The build job uploads the wheels and
                  sdists as a workflow artifact. The publish job runs in{" "}
                  <Code>environment: pypi</Code>, downloads that same artifact, and stays blocked
                  until the review is approved in Drydock.
                </>,
              ]}
            />
            <div class="flex flex-wrap gap-2 pt-1">
              <LinkButton href="/dashboard/settings?tab=integrations" size="sm">
                Open Organization settings
              </LinkButton>
            </div>
          </Subsection>

          <Subsection title="Release-candidate bundle">
            <Prose>
              You do not write a manifest. CI builds and uploads <Code>dist/*</Code>, and Drydock
              treats every <Code>.whl</Code>, <Code>.tar.gz</Code>, and <Code>.tgz</Code> it finds
              in the upload as part of the release. The settings form can narrow this down to one
              artifact name; when left blank, Drydock inspects every non-expired artifact from the
              held run and fails closed if an archive is ambiguous.
            </Prose>
            <Prose>
              Drydock reads each package's name and version out of the files themselves and
              recomputes SHA-256 digests from the bytes it fetched. The publish job only downloads
              the reviewed bundle and never rebuilds, so the bytes that were reviewed are the bytes
              that get published.
            </Prose>
            <Prose>
              You usually do not declare which ecosystem you're publishing. Drydock tells an npm
              tarball from a PyPI sdist by looking inside it, so the same gate can review either one
              or both at once in a mixed monorepo.
            </Prose>
          </Subsection>

          <Subsection title="Monorepo releases">
            <Prose>
              One workflow run can publish several packages at once, like a monorepo cutting many
              wheels and sdists in a single release. Drydock groups the uploads by package and opens
              one review per package, each diffed against its own previously published version. A
              single gate covers every package the environment publishes.
            </Prose>
            <Prose>
              The held publish is released once every package is approved, and rejecting any single
              package blocks the whole release. The workbench lists the packages, tracks how many
              are approved, and links each one to its own review.
            </Prose>
          </Subsection>

          <Subsection title="Workflow shape">
            <CodeBlock name=".github/workflows/release.yml">
              {`jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/*

  publish:
    needs: build-release-artifacts
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
      # publish the downloaded dist/* to PyPI via Trusted Publishing (OIDC)`}
            </CodeBlock>
            <Prose>
              No manifest or checksum step is required. CI builds and uploads <Code>dist/*</Code>.
              The <Code>environment: pypi</Code> line is the gate: configure that same environment
              as a PyPI Trusted Publisher and enable Drydock as a deployment protection rule on it.
              The publish job stays blocked until the review is approved in Drydock, then publishes
              the downloaded bundle with whatever tool you prefer.
            </Prose>
            <Prose>
              npm looks the same. <Code>npm pack</Code> the workspaces, upload{" "}
              <Code>dist/*.tgz</Code>, and gate the publish job on a GitHub Environment. The publish
              job downloads the reviewed tarballs and publishes them exactly as reviewed, without
              re-packing.
            </Prose>
            <CodeBlock name=".github/workflows/release.yml (npm)">
              {`jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run pack:all   # npm pack each workspace into dist/*.tgz
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: dist/*.tgz

  publish:
    needs: build-release-artifacts
    environment: npm
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
          path: dist
      # no checkout, no re-pack: publish exactly the reviewed bytes
      - run: |
          for tgz in dist/*.tgz; do
            npm publish "$tgz" --access public --provenance
          done`}
            </CodeBlock>
          </Subsection>

          <Subsection title="Decision flow">
            <Steps
              items={[
                <>
                  When the gated publish job starts, GitHub sends Drydock a signed webhook. Drydock
                  verifies the signature and rejects anything unsigned or malformed.
                </>,
                <>
                  Drydock matches the delivery to the repository and environment you mapped in
                  settings and records a pending gate. Retried deliveries are recognized, and
                  deliveries that don't match anything you configured are ignored.
                </>,
                <>
                  Drydock fetches the uploaded bundle, recomputes artifact digests, and reviews each
                  package against its own earlier version. The review records a recommendation and
                  leaves the decision to a human.
                </>,
                <>
                  A maintainer opens the review on the dashboard and approves or rejects each
                  package. If their Drydock account has 2FA enabled, this asks for a fresh TOTP
                  code. The held job is released once every package is approved and blocked the
                  moment any one is rejected. A bundle Drydock can't verify is rejected
                  automatically.
                </>,
                <>
                  Drydock reports the final decision back to GitHub over its own pinned connection,
                  so a spoofed webhook can't redirect the callback.
                </>,
                <>
                  Each gate is decided exactly once, even when a manual decision and an automatic
                  rejection race.
                </>,
              ]}
            />
          </Subsection>
        </section>

        <section class="flex flex-col gap-4 border-t border-border pt-10">
          <SectionLabel>Start reviewing releases</SectionLabel>
          <div class="flex flex-wrap gap-3">
            <LinkButton href="/register">Create account</LinkButton>
            <LinkButton href="/login" variant="secondary">
              Sign in
            </LinkButton>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function ModeCard({
  href,
  title,
  badge,
  children,
}: {
  href: string;
  title: string;
  badge?: string;
  children: ComponentChildren;
}) {
  return (
    <a href={href} class="no-underline group">
      <Card
        as="div"
        class="p-5 h-full flex flex-col gap-2 transition-colors group-hover:border-border-strong"
      >
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-medium tracking-[-0.005em] m-0 text-ink">{title}</h2>
          {badge ? <Badge tone="info">{badge}</Badge> : null}
        </div>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">{children}</p>
        <span class="mt-auto pt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-accent group-hover:text-accent-hover">
          Go to setup
        </span>
      </Card>
    </a>
  );
}

function Subsection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-3.5">
      <h3 class="text-base font-medium tracking-[-0.005em] text-ink m-0">{title}</h3>
      {children}
    </div>
  );
}

function Prose({ children }: { children: ComponentChildren }) {
  return <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">{children}</p>;
}

function Steps({ items }: { items: ComponentChildren[] }) {
  return (
    <ol class="list-none p-0 m-0 flex flex-col">
      {items.map((item, index) => (
        <li key={index} class="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
          <div class="flex flex-col items-center">
            <span class="font-mono text-[11px] font-medium text-ink-subtle tabular-nums leading-none pt-px">
              {String(index + 1).padStart(2, "0")}
            </span>
            {index < items.length - 1 ? (
              <span class="w-px flex-1 bg-border mt-2" aria-hidden />
            ) : null}
          </div>
          <div
            class={`text-[13px] text-ink-muted leading-[1.6] min-w-0 ${
              index < items.length - 1 ? "pb-5" : ""
            }`}
          >
            {item}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code class="font-mono text-[12px] text-ink bg-surface-2 px-1 py-0.5 rounded">{children}</code>
  );
}

function CodeBlock({ name, children }: { name?: string; children: string }) {
  return (
    <div class="rounded-md border border-border overflow-hidden bg-surface-2">
      {name ? (
        <div class="px-4 py-2 border-b border-border font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {name}
        </div>
      ) : null}
      <pre class="m-0 p-4 overflow-x-auto font-mono text-[12px] leading-[1.55] text-ink">
        <code>{children}</code>
      </pre>
    </div>
  );
}
