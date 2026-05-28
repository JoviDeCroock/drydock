import { Card, Eyebrow, LinkButton, PageShell, SectionLabel } from "../../components";

export default function DocsPage() {
  return (
    <PageShell
      class="gap-16"
      headerActions={
        <LinkButton href="/" variant="ghost" size="sm">
          Home
        </LinkButton>
      }
    >
      <section class="py-8 md:py-12 border-y border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Documentation</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          How Drydock guards a publish.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Two release shapes exist in the wild: registries that own a staged artifact before
          publish, and registries that don't. Drydock reviews each one with the primitive that fits
          it, and never holds a publish credential.
        </p>
        <nav class="flex flex-wrap gap-3 mt-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          <a class="text-accent hover:text-accent-hover" href="#staged-publishing">
            → Staged publishing
          </a>
          <a class="text-accent hover:text-accent-hover" href="#action-gating">
            → Action-based review gating
          </a>
        </nav>
      </section>

      <article id="staged-publishing" class="flex flex-col gap-6 max-w-[880px]">
        <header class="flex flex-col gap-3">
          <SectionLabel>Staged publishing — npm</SectionLabel>
          <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0">
            The registry holds the candidate; the maintainer holds the keys.
          </h2>
          <p class="text-[14px] text-ink-muted leading-[1.6] m-0">
            npm exposes a staged-publish primitive: a maintainer runs{" "}
            <Code>npm publish --stage</Code> and the registry parks the candidate tarball behind a{" "}
            <Code>stageId</Code> until the same maintainer confirms the publish with 2FA. Drydock
            reviews what is inside that staged tarball before that confirmation runs.
          </p>
        </header>

        <Card class="p-5 flex flex-col gap-3">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Set it up</h3>
          <ol class="list-decimal pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle marker:font-mono">
            <li>
              Sign in and switch the org picker to the organization that publishes the package.
            </li>
            <li>
              Open <Code>Organization settings → npm access</Code> and paste an automation or
              granular npm token that can read the org's packages and list staged publishes.
            </li>
            <li>
              Save — Drydock encrypts the token, hashes a fingerprint, and runs the registry auth
              check. Add a real <Code>stageId</Code> if you want to prove staged-tarball access on
              the same screen.
            </li>
            <li>
              From here, hit <Code>Check npm</Code> on the dashboard to discover open staged
              publishes on demand, or let the 15-minute auto-discovery cron pick them up
              automatically.
            </li>
          </ol>
          <div class="flex flex-wrap gap-2 pt-1">
            <LinkButton href="/dashboard/settings" size="sm">
              Open Organization settings
            </LinkButton>
          </div>
        </Card>

        <Card class="p-5 flex flex-col gap-2">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">The review lifecycle</h3>
          <ol class="list-decimal pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle marker:font-mono">
            <li>
              A new staged publish is discovered — the 15-minute auto-discovery cron sweeps the
              org's open stages, or a maintainer clicks <Code>Check npm</Code> on the dashboard. The
              worker queues a scan for any <Code>stageId</Code> it hasn't seen before and the UI
              starts polling its status.
            </li>
            <li>
              The worker resolves the active organization's npm connection. The plaintext token
              stays in D1 until the npm adapter broker needs it.
            </li>
            <li>
              A short-lived sandbox Worker downloads the staged tarball from{" "}
              <Code>/-/stage/&lt;stageId&gt;/tarball</Code> through a credentialed outbound gateway
              — the sandbox itself never receives the token.
            </li>
            <li>
              The sandbox unpacks the archive into bounded file metadata and text samples and hands
              them back to the parent worker. Package contents are evidence, never instructions.
            </li>
            <li>
              The parent worker resolves a tag-aware baseline version, computes the
              package-to-package diff, runs deterministic findings against the changed files, and
              persists a redacted report.
            </li>
            <li>
              The maintainer reads the report at <Code>/dashboard/scans/:id</Code>. Approval happens
              in npm with normal 2FA — Drydock never publishes on their behalf.
            </li>
          </ol>
        </Card>

        <Card class="p-5 flex flex-col gap-2">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Auto-discovery</h3>
          <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
            A <Code>*/15 * * * *</Code> cron sweeps every validated npm connection, lists the
            organization's open staged publishes via <Code>GET /-/stage</Code>, and queues a scan
            for any new <Code>stageId</Code>. Stages that already completed in another organization
            are skipped, so the same tarball is never fetched twice. When an auto-discovered scan
            finishes, the connection's creator receives an email linking to the report. Tokens
            marked <Code>invalid</Code> are skipped without contacting the registry.
          </p>
        </Card>

        <Card class="p-5 flex flex-col gap-2">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Trust boundary</h3>
          <ul class="list-disc pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle">
            <li>
              The npm token only attaches to allowed registry endpoints (staged tarball, staged
              details, registry metadata). The gateway is the single chokepoint.
            </li>
            <li>
              The sandbox sees package bytes, not credentials. It cannot reach the internet except
              through the gateway, and the gateway refuses to attach auth on arbitrary origins.
            </li>
            <li>
              Reports persist redacted evidence: file paths, bounded text samples, deterministic
              finding records. Raw tarballs are not retained.
            </li>
            <li>
              Deterministic findings are authoritative. Nothing downstream — including any future AI
              commentary — can downgrade them.
            </li>
          </ul>
        </Card>
      </article>

      <article id="action-gating" class="flex flex-col gap-6 max-w-[880px]">
        <header class="flex flex-col gap-3">
          <SectionLabel>Action-based review gating — PyPI &amp; GitHub Actions</SectionLabel>
          <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0">
            When the registry can't hold the candidate, the workflow does.
          </h2>
          <p class="text-[14px] text-ink-muted leading-[1.6] m-0">
            PyPI does not expose a staged tarball. The publish job itself becomes the boundary: CI
            builds the wheel and sdist, uploads them as a release candidate, and a GitHub
            Environment with a Drydock-owned deployment protection rule blocks the publish job until
            the reviewed artifact digests are approved. The same maintainer-controlled credential —
            PyPI Trusted Publishing via OIDC — does the publish.
          </p>
        </header>

        <Card class="p-5 flex flex-col gap-3">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Set it up</h3>
          <ol class="list-decimal pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle marker:font-mono">
            <li>
              Sign in and switch the org picker to the organization that owns the PyPI project.
            </li>
            <li>
              Open <Code>Organization settings → GitHub App</Code> and install the Drydock GitHub
              App on the GitHub account that hosts your repository. You'll be redirected to GitHub
              to pick the account and grant access to the repo, then back to Drydock.
            </li>
            <li>
              In the repository, create a GitHub Environment (e.g. <Code>pypi</Code>) and configure
              it as a PyPI Trusted Publisher. Drydock attaches its deployment-protection rule to
              that same environment.
            </li>
            <li>
              Map the repository + environment + PyPI package on the same settings page so the
              webhook can resolve a delivery to your organization. The mapping is unique per{" "}
              <Code>(organization, repository, environment)</Code>.
            </li>
            <li>
              Add the build and publish workflow below. The build job writes{" "}
              <Code>drydock-manifest.json</Code>; the publish job runs in{" "}
              <Code>environment: pypi</Code> and is blocked until Drydock posts an approval back to
              GitHub.
            </li>
          </ol>
          <div class="flex flex-wrap gap-2 pt-1">
            <LinkButton href="/dashboard/settings" size="sm">
              Open Organization settings
            </LinkButton>
          </div>
        </Card>

        <Card class="p-5 flex flex-col gap-3">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">
            The release-candidate manifest
          </h3>
          <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
            The build job writes a <Code>drydock-manifest.json</Code> next to the artifacts. The
            manifest names every file that must reach PyPI and pins its sha256:
          </p>
          <CodeBlock>
            {`{
  "schema": "drydock.release-artifacts.v1",
  "ecosystem": "pypi",
  "package": "example-package",
  "version": "1.2.3",
  "artifacts": [
    {
      "path": "dist/example_package-1.2.3-py3-none-any.whl",
      "sha256": "…"
    },
    {
      "path": "dist/example_package-1.2.3.tar.gz",
      "sha256": "…"
    }
  ]
}`}
          </CodeBlock>
          <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
            The publish job re-verifies these digests immediately before invoking{" "}
            <Code>pypa/gh-action-pypi-publish</Code>. Rebuilding after the gate is rejected — the
            reviewed bytes must be the published bytes.
          </p>
        </Card>

        <Card class="p-5 flex flex-col gap-3">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">The workflow shape</h3>
          <CodeBlock>
            {`jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: sha256sum dist/* > drydock-sha256.txt
      - run: python scripts/write-drydock-manifest.py
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*
            drydock-manifest.json
            drydock-sha256.txt

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
      - run: sha256sum --check drydock-sha256.txt
      - uses: pypa/gh-action-pypi-publish@release/v1`}
          </CodeBlock>
          <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
            The <Code>environment: pypi</Code> line is the gate. Configure the same environment in
            PyPI Trusted Publishers and attach Drydock as a custom deployment protection rule on it.
            The publish job is blocked until Drydock posts a decision back.
          </p>
        </Card>

        <Card class="p-5 flex flex-col gap-2">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Decision flow</h3>
          <ol class="list-decimal pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle marker:font-mono">
            <li>
              GitHub fires a signed <Code>deployment_protection_rule</Code> webhook to{" "}
              <Code>POST /webhooks/github</Code>. The handler HMAC-verifies the signature against
              the raw body in constant time — unsigned or malformed requests are rejected.
            </li>
            <li>
              The handler resolves the <Code>(installationId, repositoryId, environment)</Code>{" "}
              triple against the organization's release-target table. Deliveries that don't match a
              mapped target are acknowledged but ignored.
            </li>
            <li>
              Matched deliveries persist a <Code>github_workflow_gates</Code> row keyed on the
              GitHub delivery ID, so retries are idempotent. The scan pipeline runs against the
              uploaded artifacts and the digests pinned in the manifest.
            </li>
            <li>
              The decision is posted back to GitHub at{" "}
              <Code>
                POST
                /repos/&lt;owner&gt;/&lt;repo&gt;/actions/runs/&lt;run_id&gt;/deployment_protection_rule
              </Code>{" "}
              with a fresh installation access token. The callback URL is pinned to{" "}
              <Code>api.github.com</Code> and the deployment-protection path — a spoofed URL in the
              webhook payload is rejected even when the signature is valid.
            </li>
            <li>
              The transition out of <Code>pending</Code> is a single conditional update, so even if
              the review pipeline runs more than once Drydock calls GitHub exactly once.
            </li>
          </ol>
        </Card>

        <Card class="p-5 flex flex-col gap-2">
          <h3 class="text-base font-medium tracking-[-0.005em] m-0">Trust boundary</h3>
          <ul class="list-disc pl-5 m-0 flex flex-col gap-1.5 text-[13px] text-ink-muted leading-[1.55] marker:text-ink-subtle">
            <li>
              Drydock never holds a PyPI credential or an OIDC token. The publish job exchanges its
              own OIDC identity with PyPI directly.
            </li>
            <li>
              The release-target mapping is unique per{" "}
              <Code>(organization, repository, environment)</Code> so a webhook can never
              ambiguously resolve to two organizations.
            </li>
            <li>
              The reviewed artifact path set must exactly match the manifest path set. Adding a file
              post-review breaks the gate.
            </li>
            <li>
              Installation lifecycle events (<Code>suspend</Code>, <Code>unsuspend</Code>,{" "}
              <Code>deleted</Code>) update the installation row, so later deliveries on a revoked
              install fail closed automatically.
            </li>
          </ul>
        </Card>
      </article>

      <section class="flex flex-col gap-4">
        <SectionLabel>Set up an organization</SectionLabel>
        <div class="flex flex-wrap gap-3">
          <LinkButton href="/register">Create account</LinkButton>
          <LinkButton href="/login" variant="secondary">
            Sign in
          </LinkButton>
        </div>
      </section>
    </PageShell>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code class="font-mono text-[12px] text-ink bg-surface-2 px-1 py-0.5 rounded">{children}</code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre class="m-0 p-4 rounded bg-surface-2 border border-border overflow-x-auto font-mono text-[12px] leading-[1.55] text-ink">
      <code>{children}</code>
    </pre>
  );
}
