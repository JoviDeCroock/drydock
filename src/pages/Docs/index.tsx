import type { ComponentChildren } from "preact";
import { Alert, Badge, Card, Eyebrow, LinkButton, PageShell, SectionLabel } from "../../components";

export default function DocsPage() {
  return (
    <PageShell
      width="doc"
      headerActions={
        <LinkButton href="/" variant="ghost" size="sm">
          Home
        </LinkButton>
      }
    >
      <div class="flex flex-col gap-14">
        <header class="border-t border-border pt-8 flex flex-col gap-5">
          <Eyebrow tone="accent">Documentation</Eyebrow>
          <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
            How Drydock guards a publish.
          </h1>
          <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
            The package that reaches a registry is built, packed output — code review never sees it.
            Drydock holds the release candidate before it goes public, diffs it against the last
            published version, and pins deterministic findings to the lines that introduced them. A
            maintainer makes the final call: Drydock never publishes and never holds a publish
            credential, and package contents are evidence to review, never code to execute.
          </p>
          <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">
            How the candidate is held depends on how you publish. npm can park a staged tarball on
            the registry itself; PyPI has no staged artifact — and not every npm publish goes
            through staging — so a GitHub Actions environment gate holds the publish job instead.
            Both paths end in the same diff-first review. Pick the one that matches your release:
          </p>
          <nav class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-1" aria-label="Integration modes">
            <ModeCard href="#staged-publishing" title="Staged publishing — npm">
              You publish with <Code>npm publish --stage</Code>. The registry parks the candidate
              tarball; Drydock reviews it, and you confirm the publish in npm with your own 2FA.
            </ModeCard>
            <ModeCard href="#workflow-gating" title="Workflow gating — PyPI & npm" badge="Preview">
              You publish from GitHub Actions — PyPI via Trusted Publishing, or npm without staging.
              An environment gate holds the publish job until a maintainer approves the review.
            </ModeCard>
          </nav>
        </header>

        <section id="staged-publishing" class="flex flex-col gap-8 scroll-mt-6">
          <div class="flex flex-col gap-3">
            <SectionLabel>Staged publishing — npm</SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
              The registry holds the candidate; the maintainer holds the keys.
            </h2>
            <Prose>
              npm exposes a staged-publish primitive: a maintainer runs{" "}
              <Code>npm publish --stage</Code> and the registry parks the candidate tarball behind a{" "}
              <Code>stageId</Code> until the same maintainer confirms the publish with 2FA. Drydock
              reviews what is inside that staged tarball before that confirmation runs.
            </Prose>
          </div>

          <Subsection title="Set it up">
            <Steps
              items={[
                <>
                  Sign in and switch the org picker to the organization that publishes the package.
                </>,
                <>
                  Open <Code>Organization settings → npm access</Code> and paste an automation or
                  granular npm token that can read the org's packages and list staged publishes.
                </>,
                <>
                  Save — Drydock encrypts the token, hashes a fingerprint, and runs the registry
                  auth check. Add a real <Code>stageId</Code> if you want to prove staged-tarball
                  access on the same screen.
                </>,
                <>
                  From here, hit <Code>Check npm</Code> on the dashboard to discover open staged
                  publishes on demand, or let the 15-minute auto-discovery cron pick them up
                  automatically.
                </>,
              ]}
            />
            <div class="flex flex-wrap gap-2 pt-1">
              <LinkButton href="/dashboard/settings" size="sm">
                Open Organization settings
              </LinkButton>
            </div>
          </Subsection>

          <Subsection title="Review lifecycle">
            <Steps
              items={[
                <>
                  A new staged publish is discovered (see Auto-discovery below). The worker queues a
                  scan for any <Code>stageId</Code> it hasn't seen before, and the UI starts polling
                  that scan's status.
                </>,
                <>
                  The worker resolves the active organization's npm connection. The token is stored
                  encrypted with AES-256-GCM in D1 and is decrypted only at the moment the npm
                  adapter needs to authenticate a registry request.
                </>,
                <>
                  A short-lived sandbox Worker downloads the staged tarball from{" "}
                  <Code>/-/stage/&lt;stageId&gt;/tarball</Code> through a credentialed outbound
                  gateway — the sandbox itself never receives the token.
                </>,
                <>
                  The sandbox unpacks the archive into bounded file metadata and text samples and
                  hands them back to the parent worker. Package contents are evidence, never
                  instructions.
                </>,
                <>
                  The parent worker resolves a tag-aware baseline version, computes the
                  package-to-package diff, runs deterministic findings against the changed files,
                  and persists a redacted report.
                </>,
                <>
                  The maintainer reads the report at <Code>/dashboard/scans/:id</Code>. Approval
                  happens in npm with normal 2FA — Drydock never publishes on their behalf.
                </>,
              ]}
            />
          </Subsection>

          <Subsection title="Auto-discovery">
            <Prose>
              A <Code>*/15 * * * *</Code> cron sweeps every validated npm connection, lists the
              organization's open staged publishes via <Code>GET /-/stage</Code>, and queues a scan
              for any new <Code>stageId</Code>. Stages that already completed in another
              organization are skipped, so the same tarball is never fetched twice. When an
              auto-discovered scan finishes, the connection's creator receives an email linking to
              the report. Tokens marked <Code>invalid</Code> are skipped without contacting the
              registry.
            </Prose>
          </Subsection>
        </section>

        <section id="workflow-gating" class="flex flex-col gap-8 scroll-mt-6">
          <div class="flex flex-col gap-3">
            <SectionLabel>
              Workflow gating — PyPI &amp; npm on GitHub Actions <Badge tone="info">Preview</Badge>
            </SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
              When the registry can't hold the candidate, the workflow does.
            </h2>
            <Prose>
              PyPI does not expose a staged tarball, and not every npm publish goes through staged
              publishing. For those, the publish job itself becomes the boundary: CI builds the
              release artifacts — wheels and sdists for PyPI, <Code>npm pack</Code> tarballs for npm
              — uploads them as a release candidate, and a GitHub Environment with a Drydock-owned
              deployment protection rule holds the publish job. Drydock reviews the candidate and
              records a recommendation, but never approves on its own — a maintainer approves or
              rejects from the review workbench, and only then is the held job released or blocked.
              The publish runs on the workflow's own credential (PyPI Trusted Publishing, or npm via
              OIDC); Drydock never holds it.
            </Prose>
            <Prose>
              PyPI and npm are both supported. The GitHub plumbing — install, gate, fetch, review,
              decide — is shared, and Drydock auto-detects each package's ecosystem from the
              uploaded artifacts, so future ecosystems plug in behind the same gate. This
              walkthrough uses PyPI as the example; for npm, a workflow gate is an alternative to{" "}
              <a class="underline" href="#staged-publishing">
                staged-publish review
              </a>{" "}
              for repositories that publish without staging.
            </Prose>
            <Alert tone="info">
              The full gate runs in production today: Drydock fetches the release candidate, reviews
              it, and surfaces an approve/reject decision in the workbench — a maintainer makes the
              call, and Drydock relays it to GitHub. It is still early access: connecting the GitHub
              App is limited to allowlisted organizations. The steps below describe the flow.
            </Alert>
          </div>

          <Subsection title="Set it up">
            <Steps
              items={[
                <>
                  Sign in and switch the org picker to the organization that owns the PyPI project.
                </>,
                <>
                  Open <Code>Organization settings → GitHub App</Code> and install the Drydock
                  GitHub App on the GitHub account that hosts your repository. You'll be redirected
                  to GitHub to pick the account and grant access to the repo, then back to Drydock.
                </>,
                <>
                  In the repository, create a GitHub Environment (e.g. <Code>pypi</Code>) and
                  configure it as a PyPI Trusted Publisher. Drydock attaches its
                  deployment-protection rule to that same environment.
                </>,
                <>
                  Map the repository + environment + PyPI package on the same settings page so the
                  webhook can resolve a delivery to your organization. The mapping is unique per{" "}
                  <Code>(organization, repository, environment)</Code>.
                </>,
                <>
                  Add the build and publish workflow below. The build job uploads the wheels and
                  sdists as a GitHub Actions artifact; the publish job runs in{" "}
                  <Code>environment: pypi</Code>, downloads the same artifact, and stays blocked
                  until a maintainer approves the review in Drydock.
                </>,
              ]}
            />
            <div class="flex flex-wrap gap-2 pt-1">
              <LinkButton href="/dashboard/settings" size="sm">
                Open Organization settings
              </LinkButton>
            </div>
          </Subsection>

          <Subsection title="Release-candidate bundle">
            <Prose>
              There is no manifest to write. The boundary between your workflow and Drydock is the
              workflow run's uploaded artifacts: CI builds and uploads <Code>dist/*</Code>, and
              Drydock treats every <Code>.whl</Code>, <Code>.tar.gz</Code>, and <Code>.tgz</Code> it
              finds as the release set. The settings form can narrow discovery to one artifact name,
              but leaving it blank lets Drydock inspect every non-expired upload from the held run.
            </Prose>
            <Prose>
              The release identity is derived from the artifacts themselves — package name and
              version from each wheel's <Code>METADATA</Code>, each sdist's <Code>PKG-INFO</Code>,
              and each npm tarball's <Code>package.json</Code> — with every sha256 recomputed
              server-side from the uploaded bytes. The reviewed artifact must be the exact file
              published: the publish job only downloads the reviewed bundle and never rebuilds, so
              the reviewed bytes are the published bytes.
            </Prose>
            <Prose>
              You never declare which ecosystem you're publishing. Drydock tells an npm tarball from
              a PyPI sdist by content — an npm <Code>.tgz</Code> carries a <Code>package.json</Code>
              , a PyPI sdist a <Code>PKG-INFO</Code> — so the same auto-detect target reviews
              either, or both at once for a mixed monorepo.
            </Prose>
          </Subsection>

          <Subsection title="Monorepo releases">
            <Prose>
              One workflow run can publish several distinct packages — a monorepo cutting many
              wheels and sdists at once. Drydock groups the uploaded artifacts by package identity
              and fans the gate out into one review per package, each diffed against its own
              previously-published baseline. A release target left without a pinned ecosystem
              auto-detects each package's ecosystem from its artifacts, so a single gate can cover
              every package the environment publishes.
            </Prose>
            <Prose>
              The held deployment is released only once every discovered package is individually
              approved; rejecting any single package blocks the whole release. The review workbench
              lists the package roster, tracks how many are approved, and links each package to its
              own diff-first review.
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
              No manifest or checksum step is required — CI just builds and uploads{" "}
              <Code>dist/*</Code>. The <Code>environment: pypi</Code> line is the gate: configure
              the same environment in PyPI Trusted Publishers and attach Drydock as a custom
              deployment protection rule on it. The publish job stays blocked until a maintainer
              approves the review in Drydock, then publishes the downloaded bundle with whatever
              tool you prefer.
            </Prose>
            <Prose>
              npm looks the same — <Code>npm pack</Code> the workspaces, upload{" "}
              <Code>dist/*.tgz</Code>, and gate the publish job on a GitHub Environment. The publish
              job downloads the reviewed tarballs and runs <Code>npm publish &lt;tarball&gt;</Code>{" "}
              with <Code>--provenance</Code>; it never re-packs.
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
                  GitHub fires a signed <Code>deployment_protection_rule</Code> webhook to{" "}
                  <Code>POST /webhooks/github</Code>. The handler HMAC-verifies the signature
                  against the raw body in constant time — unsigned or malformed requests are
                  rejected.
                </>,
                <>
                  The handler resolves the <Code>(installationId, repositoryId, environment)</Code>{" "}
                  triple against the organization's release-target table and persists a{" "}
                  <Code>pending</Code> <Code>github_workflow_gates</Code> row keyed on the GitHub
                  delivery ID, so retries are idempotent. Deliveries that don't match a mapped
                  target are acknowledged but ignored.
                </>,
                <>
                  Drydock derives the release set from the uploaded bundle, recomputes each
                  artifact's sha256, and runs the scan pipeline — one review per discovered package,
                  each against its own baseline — recording an advisory recommendation. The review
                  never posts to GitHub — it leaves the gate <Code>pending</Code> and hands off to a
                  human.
                </>,
                <>
                  A maintainer opens the review in the diff-first workbench at{" "}
                  <Code>/dashboard/scans/:id</Code> and approves or rejects each package. The held
                  publish job is released only once every package is approved, and blocked the
                  moment any one is rejected — only that final decision is posted back to GitHub. A
                  bundle whose artifacts can't be verified is auto-rejected fail-closed — no human
                  is needed to block something Drydock can't identify.
                </>,
                <>
                  The decision callback hits{" "}
                  <Code>
                    POST
                    /repos/&lt;owner&gt;/&lt;repo&gt;/actions/runs/&lt;run_id&gt;/deployment_protection_rule
                  </Code>{" "}
                  with a fresh installation access token. The callback URL is pinned to{" "}
                  <Code>api.github.com</Code> and the deployment-protection path — a spoofed URL in
                  the webhook payload is rejected even when the signature is valid.
                </>,
                <>
                  The transition out of <Code>pending</Code> is a single compare-and-set, so a
                  double-submit or a race between a human decision and the fail-closed reject calls
                  GitHub exactly once.
                </>,
              ]}
            />
          </Subsection>
        </section>

        <section class="flex flex-col gap-4 border-t border-border pt-10">
          <SectionLabel>Set up an organization</SectionLabel>
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
          → jump to setup
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
