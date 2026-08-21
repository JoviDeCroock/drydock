import type { ComponentChildren } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { type Signal, useComputed, useSignal } from "@preact/signals";
import { Badge, type BadgeTone } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { cn } from "../../components/cn";
import { PageShell } from "../../components/PageShell";
import { Eyebrow, MonoLabel, SectionLabel } from "../../components/Typography";
import { ensureHighlighter, highlighterReady, tokenizeLines } from "../../components/highlight";
import { docsPageSeo, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

const TOC: Array<{ id: string; label: string; children: Array<{ id: string; label: string }> }> = [
  {
    id: "start-here",
    label: "Start here",
    children: [
      { id: "artifact-gap", label: "The artifact gap" },
      { id: "review-loop", label: "The review loop" },
      { id: "inside-report", label: "Inside a report" },
      { id: "safety-model", label: "Safety model" },
    ],
  },
  {
    id: "choose-path",
    label: "Choose a release path",
    children: [{ id: "path-comparison", label: "Compare the paths" }],
  },
  {
    id: "staged-publishing",
    label: "npm stage publish",
    children: [
      { id: "staged-setup", label: "Connect npm" },
      { id: "staged-lifecycle", label: "Run a review" },
    ],
  },
  {
    id: "atpm-publishing",
    label: "atpm trusted publishing",
    children: [
      { id: "atpm-setup", label: "Set the publisher policy" },
      { id: "atpm-review", label: "Review before publishing" },
    ],
  },
  {
    id: "workflow-gating",
    label: "GitHub workflow gates",
    children: [
      { id: "gate-setup", label: "Connect GitHub" },
      { id: "gate-bundle", label: "Prepare the artifacts" },
      { id: "gate-workflow", label: "Workflow examples" },
      { id: "gate-decision", label: "Approve or reject" },
    ],
  },
  {
    id: "dependency-updates",
    label: "Diffs in dependency PRs",
    children: [
      { id: "renovate-diff-links", label: "Renovate" },
      { id: "dependabot-diff-links", label: "Dependabot" },
    ],
  },
];

const TOC_IDS = TOC.flatMap((section) => [section.id, ...section.children.map((c) => c.id)]);

export default function DocsPage() {
  const authed = useAuthedSession();
  const activeId = useSignal(TOC_IDS[0]);

  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // A parent <section> overlaps the reading band the whole way through, so
        // the deepest (last in document order) visible id is the one being read.
        for (let i = TOC_IDS.length - 1; i >= 0; i--) {
          if (visible.has(TOC_IDS[i])) {
            activeId.value = TOC_IDS[i];
            return;
          }
        }
      },
      { rootMargin: "-8% 0px -72% 0px" },
    );
    for (const id of TOC_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <PageShell
      class="gap-10 md:gap-14"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={docsPageSeo} />
      <header class="py-8 md:py-14 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Learn Drydock</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Review what ships, not just what changed.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Drydock is a release checkpoint for package maintainers. It opens the package that is
          about to be published, compares it with the last release, points to risky changes, and
          gives a human the final decision.
        </p>
        <p class="m-0 font-mono text-[11px] text-ink-subtle tracking-[0.02em]">
          About 5 minutes · No security background required · npm, PyPI, VS Code, and atpm
        </p>
        <nav class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2" aria-label="Learning path">
          <JourneyCard number="01" href="#artifact-gap" title="Understand the gap">
            See why reviewing source code alone can miss what reaches users.
          </JourneyCard>
          <JourneyCard number="02" href="#review-loop" title="Follow a review">
            Learn what Drydock inspects and how a maintainer makes the call.
          </JourneyCard>
          <JourneyCard number="03" href="#choose-path" title="Choose your setup">
            Pick npm staging, atpm trusted publishing, or a GitHub workflow gate.
          </JourneyCard>
        </nav>
      </header>

      <details class="group lg:hidden rounded-md border border-border bg-surface">
        <summary class="cursor-pointer list-none px-4 py-3 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          <span aria-hidden class="mr-2 inline group-open:hidden">
            ▸
          </span>
          <span aria-hidden class="mr-2 hidden group-open:inline">
            ▾
          </span>
          On this page
        </summary>
        <div class="border-t border-border px-4 py-3">
          <TocList activeId={activeId} />
        </div>
      </details>

      <div class="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
        <aside class="hidden lg:block">
          <nav
            aria-label="On this page"
            class="sticky top-8 flex max-h-[calc(100svh-4rem)] flex-col gap-3 overflow-y-auto"
          >
            <p class="m-0 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              On this page
            </p>
            <TocList activeId={activeId} />
          </nav>
        </aside>

        <div class="flex flex-col gap-16 min-w-0">
          <section id="start-here" class="flex flex-col gap-10 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">Start here</SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                A second pair of eyes at the last responsible moment.
              </h2>
              <Prose>
                Pull requests show source changes. Registries deliver built archives. Drydock sits
                between those two moments and reviews the exact release candidate before it becomes
                public.
              </Prose>
            </div>

            <Subsection id="artifact-gap" title="The artifact gap">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card as="article" padding="none" class="p-5 flex flex-col gap-3">
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                      Pull request
                    </span>
                    <Badge tone="neutral">source</Badge>
                  </div>
                  <p class="m-0 text-base font-medium tracking-[-0.005em]">
                    The code your team reviewed
                  </p>
                  <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
                    Tests, configuration, and source files before packaging. Useful context, but not
                    necessarily the bytes a registry will serve.
                  </p>
                </Card>
                <Card
                  as="article"
                  padding="none"
                  class="p-5 flex flex-col gap-3 border-border-strong"
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                      Release candidate
                    </span>
                    <Badge tone="modified">artifact</Badge>
                  </div>
                  <p class="m-0 text-base font-medium tracking-[-0.005em]">
                    The package your users receive
                  </p>
                  <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
                    Generated files, bundled dependencies, lifecycle scripts, binaries, and package
                    metadata after the build has finished.
                  </p>
                </Card>
              </div>
              <Callout label="The question Drydock answers">
                Does this release candidate contain anything the maintainer should understand before
                it ships?
              </Callout>
            </Subsection>

            <Subsection id="review-loop" title="The review loop">
              <Card padding="none" class="overflow-hidden">
                <div class="px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
                  <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                    Release checkpoint
                  </span>
                  <span class="font-mono text-[11px] text-ink-subtle">
                    candidate → evidence → decision
                  </span>
                </div>
                <ol class="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
                  <ReviewStep number="01" label="Hold">
                    npm, atpm, or GitHub pauses a built release candidate.
                  </ReviewStep>
                  <ReviewStep number="02" label="Review">
                    Drydock compares the artifact, explains findings, and records provenance.
                  </ReviewStep>
                  <ReviewStep number="03" label="Decide">
                    A maintainer approves or rejects. Drydock never publishes the package.
                  </ReviewStep>
                </ol>
                <div class="border-t border-border">
                  <div class="px-5 py-3 bg-surface-2">
                    <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                      What the review tells you
                    </span>
                  </div>
                  <dl class="m-0 divide-y divide-border">
                    <ReviewAnswer label="Release delta" question="What changed?">
                      A file-by-file diff against the most relevant published version.
                    </ReviewAnswer>
                    <ReviewAnswer label="Risk signals" question="What needs attention?">
                      Install hooks, process execution, network access, credential reads, native
                      code, and ecosystem-specific risks.
                    </ReviewAnswer>
                    <ReviewAnswer label="Provenance" question="Are these the reviewed bytes?">
                      Package identity, artifact hashes, baseline choice, and the evidence behind
                      every recommendation.
                    </ReviewAnswer>
                  </dl>
                </div>
              </Card>
            </Subsection>

            <Subsection id="inside-report" title="Inside a report">
              <Card padding="none" class="p-0 overflow-hidden">
                <div class="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
                  <div class="flex flex-col gap-1">
                    <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                      Example review
                    </span>
                    <span class="text-lg font-semibold tracking-[-0.01em]">
                      @acme/cli · 4.2.0 → 4.3.0
                    </span>
                  </div>
                  <Badge tone="critical">manual review required</Badge>
                </div>
                <div class="divide-y divide-border">
                  <ReportRow label="Recommendation" value="Do not approve yet" tone="critical">
                    The release adds an install-time script and a new network-capable file.
                  </ReportRow>
                  <ReportRow label="Release delta" value="2 new findings" tone="medium">
                    Findings are pinned to the changed files and lines that introduced them.
                  </ReportRow>
                  <ReportRow label="Artifact context" value="1 existing finding">
                    Pre-existing package risk stays visible without drowning out this release.
                  </ReportRow>
                  <ReportRow label="Provenance" value="4 artifacts verified" tone="info">
                    Names, versions, baselines, and SHA-256 digests show exactly what was reviewed.
                  </ReportRow>
                </div>
              </Card>
              <Prose>
                A finding is evidence, not a verdict. Open the file, read the highlighted diff,
                check whether the behavior is intended, and record the reason for your decision.
                Clean reports still wait for a human when the release path is gated.
              </Prose>
            </Subsection>

            <Subsection id="safety-model" title="Safety model">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <SafetyItem title="Package contents are hostile evidence">
                  Drydock reads bounded file listings and text samples. It never installs, imports,
                  builds, executes, or renders package-provided active content.
                </SafetyItem>
                <SafetyItem title="Publish credentials stay elsewhere">
                  npm tokens are isolated from the sandbox. Workflow releases keep their publish
                  credential in GitHub Actions. Drydock never needs it.
                </SafetyItem>
                <SafetyItem title="Deterministic checks stay authoritative">
                  The AI reviewer is advisory and on by default behind a per-organization
                  killswitch. Its findings can raise concern but never downgrade a deterministic
                  finding.
                </SafetyItem>
                <SafetyItem title="Failures do not become approvals">
                  Missing, malformed, ambiguous, or unverifiable evidence keeps a gated release
                  blocked instead of silently passing it.
                </SafetyItem>
              </div>
            </Subsection>
          </section>

          <section id="choose-path" class="flex flex-col gap-8 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">Choose a release path</SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                Put the checkpoint where your release already pauses.
              </h2>
              <Prose>
                Every path creates the same kind of Drydock report. The difference is who holds the
                candidate while you review it and where the final decision happens.
              </Prose>
            </div>

            <Subsection id="path-comparison" title="Compare the paths">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PathCard
                  title="npm stage publish"
                  badge="npm only"
                  href="#staged-publishing"
                  command="npm stage publish"
                  bestFor="Maintainers already using npm stage publish."
                  heldBy="npm holds the unpublished package."
                  decision="You finish or decline the publish in npm with 2FA."
                />
                <PathCard
                  title="atpm trusted publishing"
                  badge="atpm"
                  href="#atpm-publishing"
                  command="npm stage publish --provenance"
                  bestFor="atpm packages using OIDC trusted publishing."
                  heldBy="The publisher's AT Protocol repository holds the candidate."
                  decision="You approve in atpm; Drydock only shows you what changed."
                />
                <PathCard
                  title="GitHub workflow gate"
                  badge="Preview"
                  href="#workflow-gating"
                  command="environment: production"
                  bestFor="PyPI, npm, VS Code, monorepos, and CI-first releases."
                  heldBy="A GitHub Environment holds the publish job."
                  decision="You approve or reject the job from Drydock."
                />
              </div>
              <Callout label="Quick decision">
                Use npm staging for npm's private candidate store. For atpm, open the
                credential-free staged review from the link on your staged dashboard. For PyPI, the
                VS Code Marketplace, or other CI-first releases, use a GitHub workflow gate.
              </Callout>
            </Subsection>
          </section>

          <section id="staged-publishing" class="flex flex-col gap-8 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">Path 1 · npm stage publish</SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                npm holds the candidate; you keep the approval.
              </h2>
              <Prose>
                This is the shortest route for npm. Stage the package, let Drydock review the
                private tarball, then return to npm to publish or discard it.
              </Prose>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Requirement label="Registry">npm stage publish</Requirement>
              <Requirement label="Drydock connection">Read-scoped npm token</Requirement>
              <Requirement label="Final approval">npm 2FA</Requirement>
            </div>

            <Subsection id="staged-setup" title="Connect npm once">
              <Steps
                items={[
                  <>Create a Drydock organization for the team that publishes the package.</>,
                  <>
                    On npmjs.com, generate a granular access token with{" "}
                    <Code>Packages and scopes: Read-only</Code> on the packages you stage and{" "}
                    <Code>Organizations: No access</Code>. A scoped package like{" "}
                    <Code>@nanostores/i18n</Code> is covered by selecting the{" "}
                    <Code>@nanostores</Code> scope there; the Organizations permission is for member
                    and settings management, which Drydock never reads.
                  </>,
                  <>
                    Open <Code>Organization settings → npm access</Code> and paste the token.
                  </>,
                  <>
                    Save. Drydock encrypts the token and checks it against the registry right away.
                  </>,
                  <>
                    Drydock now discovers packages in npm stage publish automatically. Use{" "}
                    <Code>Check npm</Code> on the dashboard when you want an immediate refresh.
                  </>,
                ]}
              />
              <div class="flex flex-wrap gap-2 pt-1">
                <LinkButton href="/dashboard/settings?tab=integrations" size="sm">
                  Open Organization settings
                </LinkButton>
              </div>
            </Subsection>

            <Subsection id="staged-lifecycle" title="Run a release review">
              <Steps
                items={[
                  <>
                    From the package directory, run <Code>npm stage publish</Code>. npm uploads the
                    candidate but does not make it public.
                  </>,
                  <>
                    Drydock discovers the stage and queues a scan. You can also trigger discovery
                    with <Code>Check npm</Code>.
                  </>,
                  <>
                    Open the report. Start with the recommendation, then inspect release-delta
                    findings and the highlighted file diff. The baseline follows the staged dist-tag
                    when possible, so beta and maintenance releases compare against the right line.
                  </>,
                  <>
                    Record your decision and reason in Drydock. Then finish on npm with your normal
                    2FA — either on npm's staged-packages page, or with the{" "}
                    <Code>npm stage approve</Code> / <Code>npm stage reject</Code> command Drydock
                    shows you after saving.
                  </>,
                ]}
              />
              <Callout label="Credential boundary">
                The npm token is encrypted at rest and only attached by the registry gateway for
                allowed npm endpoints. The archive sandbox never sees it, and Drydock never receives
                the credential that completes the publish.
              </Callout>
            </Subsection>
          </section>

          <section id="atpm-publishing" class="flex flex-col gap-8 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">Path 2 · atpm trusted publishing</SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                The publisher holds a public, content-addressed candidate.
              </h2>
              <Prose>
                atpm uses GitHub OIDC for trusted publishing, so CI needs no long-lived token. A
                staged release is a public record in the publisher's AT Protocol repository, and
                Drydock verifies its provenance and reviews its content-addressed blob directly.
              </Prose>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Requirement label="Publisher policy">Stage allowed, publish denied</Requirement>
              <Requirement label="Drydock account">Not required</Requirement>
              <Requirement label="Final approval">Yours, in atpm</Requirement>
            </div>

            <Subsection id="atpm-setup" title="Set the publisher policy">
              <Steps
                items={[
                  <>
                    In the publisher's AT Protocol repository, configure the package's{" "}
                    <Code>dev.atpm.alpha.trustPublisher</Code> record with the GitHub owner,
                    repository, and workflow allowed to stage it.
                  </>,
                  <>
                    Set <Code>allowStage: true</Code> and <Code>allowPublish: false</Code>. The
                    workflow may upload a candidate, but it cannot make that candidate public — so
                    the release is already paused before anyone reviews it.
                  </>,
                  <>
                    Publish with <Code>--provenance</Code>. The Sigstore attestation is what lets a
                    review say where the release was built, and whether that matches the record
                    above.
                  </>,
                ]}
              />
            </Subsection>

            <Subsection id="atpm-review" title="Review before publishing">
              <Steps
                items={[
                  <>
                    From the package directory, run <Code>npm stage publish --provenance</Code>.
                    atpm stores the candidate without publishing it.
                  </>,
                  <>
                    Open the Drydock link beside the candidate on your staged dashboard. No account
                    and no sign-in: a staged record is public, so the review is too.
                  </>,
                  <>
                    Read the diff against the release this candidate would replace, plus the
                    verified build repository and workflow, package identity, and SHA-512 binding.
                  </>,
                  <>
                    Approve or withdraw in atpm, with <Code>npm stage approve &lt;id&gt;</Code> or{" "}
                    <Code>npm stage reject &lt;id&gt;</Code>. Drydock takes no part in that
                    decision.
                  </>,
                ]}
              />
              <Callout label="Credential boundary">
                Drydock reads public AT Protocol records and content-addressed blobs. It receives no
                atpm credential and cannot stage, approve, reject, or publish a package.
              </Callout>
            </Subsection>
          </section>

          <section id="workflow-gating" class="flex flex-col gap-8 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">
                Path 3 · GitHub workflow gates <Badge tone="info">Preview</Badge>
              </SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                When the registry can't pause, the workflow can.
              </h2>
              <Prose>
                CI uploads built files and reaches a protected publish job. GitHub asks Drydock for
                a decision before the held job continues.
              </Prose>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Requirement label="Supported evidence">whl, tar.gz, tgz, vsix</Requirement>
              <Requirement label="Release hold">GitHub Environment</Requirement>
              <Requirement label="Publish credential">Stays in GitHub Actions</Requirement>
            </div>

            <Subsection id="gate-setup" title="Connect GitHub once">
              <Steps
                items={[
                  <>Create or choose the Drydock organization that owns the release.</>,
                  <>
                    Open <Code>Organization settings → GitHub App</Code> and install the Drydock
                    GitHub App on the account that hosts your repository.
                  </>,
                  <>
                    In the repository, create a GitHub Environment such as <Code>production</Code>{" "}
                    and enable Drydock as a custom deployment protection rule.
                  </>,
                  <>
                    Back in Drydock settings, map that repository and environment to the
                    organization. You can optionally narrow the gate to one artifact name.
                  </>,
                  <>
                    Add a build job that uploads release candidates and a publish job that uses the
                    protected environment. Start from one of the examples below.
                  </>,
                ]}
              />
              <div class="flex flex-wrap gap-2 pt-1">
                <LinkButton href="/dashboard/settings?tab=integrations" size="sm">
                  Open Organization settings
                </LinkButton>
              </div>
            </Subsection>

            <Subsection id="gate-bundle" title="Prepare the release artifacts">
              <Prose>
                For npm, PyPI, and VS Code, there is no Drydock manifest to maintain. Upload built{" "}
                <Code>.whl</Code>, <Code>.tar.gz</Code>, <Code>.tgz</Code>, or <Code>.vsix</Code>{" "}
                files before the protected job starts. Drydock derives the ecosystem, package name,
                and version from metadata inside each archive.
              </Prose>
              <Prose>
                Generate <Code>SHA256SUMS</Code> beside the artifacts during the build, upload it
                with them, and verify it in the publish job. The digests in the Drydock report
                should match. Most importantly: download and publish the uploaded files—never
                rebuild after approval.
              </Prose>
              <Prose>
                Large compiled PyPI releases can upload one bounded artifact per wheel or sdist.
                Name the shards <Code>pypi-release-candidate-*</Code> and set the release target's
                ecosystem to PyPI; Drydock then processes them one at a time while keeping every
                distribution in the review and provenance. A target left on auto-detect has no name
                to match, so it keeps the smaller single-upload limits.
              </Prose>
              <Callout label="Monorepos work as one gate">
                Drydock groups uploaded files by package and opens a separate report for each one.
                The held job continues only after every package is approved; rejecting one blocks
                the release set.
              </Callout>
            </Subsection>

            <Subsection id="gate-workflow" title="Workflow examples">
              <Prose>
                Each workflow has the same contract: build once, record checksums, upload, pause at
                the environment, verify the download, and publish without rebuilding.
              </Prose>
              <WorkflowExample title="PyPI with Trusted Publishing" defaultOpen>
                {`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.x"
      - run: python -m pip install build
      - run: python -m build
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/

  publish:
    needs: build
    environment: production
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1`}
              </WorkflowExample>
              <WorkflowExample title="npm packed artifacts">
                {`jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run pack:all # write dist/*.tgz
      - run: cd dist && sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: dist/

  publish:
    needs: pack
    environment: production
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: |
          for tgz in dist/*.tgz; do
            npm publish "$tgz" --access public --provenance
          done`}
              </WorkflowExample>
              <WorkflowExample title="VS Code extension">
                {`jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx @vscode/vsce package --out dist/extension.vsix
      - run: cd dist && sha256sum *.vsix > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist/

  publish:
    needs: package
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: npx @vscode/vsce publish --packagePath dist/extension.vsix`}
              </WorkflowExample>
              <Callout label="Authentication stays in the publish job">
                Add the registry authentication your release already uses—for example PyPI Trusted
                Publishing, npm trusted publishing or a scoped token, or a VS Code Marketplace
                token—to the protected publish job. Drydock does not receive those credentials.
              </Callout>
            </Subsection>

            <Subsection id="gate-decision" title="Approve or reject the gate">
              <Steps
                items={[
                  <>
                    The publish job reaches <Code>environment: production</Code>. GitHub pauses it
                    and sends Drydock a signed protection-rule request.
                  </>,
                  <>
                    Drydock fetches the uploaded artifacts, verifies identity and digests, and
                    creates one report per package.
                  </>,
                  <>
                    Review every report in the release set. Approve intended changes or reject the
                    gate when evidence is unsafe, unexpected, or incomplete.
                  </>,
                  <>
                    After every package is approved, Drydock releases the GitHub job, which verifies{" "}
                    <Code>SHA256SUMS</Code> and publishes the downloaded files. Any rejection stops
                    the whole release.
                  </>,
                ]}
              />
              <Callout label="Fail closed">
                If Drydock cannot verify the webhook, resolve the artifact set, parse a package,
                finish a scan, or return a safe decision, the workflow does not get a silent pass.
              </Callout>
            </Subsection>
          </section>

          <section id="dependency-updates" class="flex flex-col gap-8 scroll-mt-6">
            <div class="flex flex-col gap-3">
              <SectionLabel as="p">Diffs in dependency PRs</SectionLabel>
              <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
                Review the bumps you merge, not just the releases you ship.
              </h2>
              <Prose>
                The same public diff pages work from the consumer side. A Renovate or Dependabot PR
                names an exact version pair, so the published-package diff has a predictable URL —
                no account, token, or API call. Set it up once and every dependency bump links its
                own diff.
              </Prose>
            </div>

            <Subsection id="renovate-diff-links" title="Renovate">
              <Prose>
                Extend the shared preset and each npm or PyPI update row gains a Drydock column
                linking the exact published pair being merged:
              </Prose>
              <CodeBlock name="renovate.json" lang="json">
                {`{
  "extends": [
    "config:recommended",
    "github>JoviDeCroock/drydock//renovate/diff-links"
  ]
}`}
              </CodeBlock>
              <Prose>
                List the preset after your base presets so its column layout wins. Updates without
                two distinct published versions of one package — pins, digests, replacements, and
                some lockfile-only changes — omit the link, and columns that end up empty are
                dropped from the table.
              </Prose>
            </Subsection>

            <Subsection id="dependabot-diff-links" title="Dependabot">
              <Prose>
                Dependabot cannot template PR bodies, so a small workflow comments the links
                instead. It reads the bumps from the PR metadata and never checks out or executes
                the updated code. Grouped update PRs get one link per dependency in a single
                comment, rewritten in place each time Dependabot revises the group.
              </Prose>
              <WorkflowExample title="Dependabot diff comment" defaultOpen>
                {`name: drydock-diff-link

on:
  pull_request:
    types: [opened, synchronize]

# Dependabot-triggered runs honor this permissions key; the read-only default
# token does not apply when permissions are set explicitly.
permissions:
  pull-requests: write

# Dependabot rewrites a grouped PR in place as the group's contents change, so
# the comment is rebuilt on every push. Serialize per PR so two pushes cannot
# race the read-then-write below into two comments.
concurrency:
  group: drydock-diff-link-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  diff-link:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      # Fails the job unless the PR's first commit is an authentic, signed
      # Dependabot commit, which is what makes it safe for the next step to
      # parse that commit message. Also derives the ecosystem from the branch.
      - id: meta
        uses: dependabot/fetch-metadata@v3

      - env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          PR: \${{ github.event.pull_request.number }}
          ECOSYSTEM: \${{ steps.meta.outputs.package-ecosystem }}
          NAMES: \${{ steps.meta.outputs.dependency-names }}
          FROM: \${{ steps.meta.outputs.previous-version }}
          TO: \${{ steps.meta.outputs.new-version }}
        run: |
          set -euo pipefail

          case "$ECOSYSTEM" in
            npm_and_yarn) prefix="" ;;
            pip) prefix="pypi/" ;;
            *) echo "No /diff pages for $ECOSYSTEM."; exit 0 ;;
          esac

          api="repos/$REPO"

          # A single-dependency PR carries its one pair in the action's outputs.
          # A grouped PR carries one \`Updates ...\` line per dependency in the
          # commit message, and is the only kind that does. Those lines are read
          # directly rather than through the action, which collapses a group to
          # one pair and fills the new version from the commit's
          # \`dependency-version\` metadata -- a value that can lag the version the
          # PR actually merges once Dependabot revises the group.
          case "$NAMES" in
            *,*)
              msg=$(gh api "$api/pulls/$PR/commits" --jq '.[0].commit.message')
              pairs=$(printf '%s\\n' "$msg" | sed -n \\
                's/^Updates \`\\([^\`]*\\)\` from \\([^ ]*\\) to \\([^ ]*\\)$/\\1 \\2 \\3/p')
              ;;
            *)
              pairs="$NAMES $FROM $TO"
              ;;
          esac

          # Anything that is not two distinct published versions of one package
          # gets no link: no link beats a confidently wrong one.
          links=""
          count=0
          while read -r name from to; do
            [ -n "$name" ] && [ -n "$from" ] && [ -n "$to" ] || continue
            [ "$from" != "$to" ] || continue
            url="https://drydock.org/diff/$prefix$name/$from/$to"
            links="$links- [$name $from → $to]($url)
          "
            count=$((count + 1))
          done < <(printf '%s\\n' "$pairs")

          if [ "$count" -eq 0 ]; then
            echo "No linkable version pair in this PR."
            exit 0
          fi

          lead="Read the diff this PR merges:"
          if [ "$count" -gt 1 ]; then
            lead="Read the diff of each update in this group:"
          fi

          MARKER="<!-- drydock:diff-link -->"
          body="$MARKER
          $lead

          $links"

          # Upsert, so a revised group updates its comment instead of
          # stacking a second one underneath the now-stale first.
          comments="$api/issues/$PR/comments"
          existing=$(MARKER="$MARKER" gh api "$comments" --paginate \\
            --jq '[.[] | select(.body | contains(env.MARKER))][0].id // empty')
          # --paginate applies the filter per page and concatenates, so keep
          # the first line only. Trimmed in bash rather than through \`head\`,
          # which under \`pipefail\` can fail the job on EPIPE.
          existing=\${existing%%$'\\n'*}
          if [ -n "$existing" ]; then
            method=PATCH
            target="$api/issues/comments/$existing"
          else
            method=POST
            target="$comments"
          fi
          gh api -X "$method" "$target" -f body="$body" --silent`}
              </WorkflowExample>
            </Subsection>

            <Callout label="Links, not lookups">
              Both integrations add plain markdown links. Nothing contacts Drydock when a PR renders
              — only when a reviewer clicks — and the linked pages serve public-registry data
              anonymously.
            </Callout>
          </section>

          <section class="border-t border-border pt-10">
            <Card
              padding="none"
              class="p-6 md:p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-5"
            >
              <div class="flex flex-col gap-2 max-w-[560px]">
                <SectionLabel as="p">Ready when your release is</SectionLabel>
                <h2 class="m-0 text-xl font-semibold tracking-[-0.015em]">
                  Add the checkpoint before the next publish.
                </h2>
                <p class="m-0 text-[13px] text-ink-muted leading-[1.6]">
                  Connect npm for the shortest path, or install the GitHub App to protect a CI
                  release. Your first report will make the model concrete.
                </p>
              </div>
              <div class="flex flex-wrap gap-3 shrink-0">
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/login" variant="secondary">
                  Sign in
                </LinkButton>
              </div>
            </Card>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

function TocList({ activeId }: { activeId: Signal<string> }) {
  return (
    <ul class="m-0 flex list-none flex-col border-l border-border p-0">
      {TOC.map((section) => (
        <li key={section.id}>
          <TocLink id={section.id} activeId={activeId}>
            {section.label}
          </TocLink>
          <ul class="m-0 flex list-none flex-col p-0">
            {section.children.map((child) => (
              <li key={child.id}>
                <TocLink id={child.id} activeId={activeId} depth={1}>
                  {child.label}
                </TocLink>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function TocLink({
  id,
  activeId,
  depth = 0,
  children,
}: {
  id: string;
  activeId: Signal<string>;
  depth?: 0 | 1;
  children: ComponentChildren;
}) {
  const linkClass = useComputed(() =>
    cn(
      "-ml-px block border-l-2 py-1 text-[13px] leading-[1.5] no-underline transition-colors",
      depth === 1 ? "pl-6" : "pl-3.5 font-medium",
      activeId.value === id
        ? "border-accent text-accent"
        : "border-transparent text-ink-muted hover:text-ink",
    ),
  );
  const ariaCurrent = useComputed(() => (activeId.value === id ? "location" : undefined));
  return (
    <a
      href={`#${id}`}
      class={linkClass}
      aria-current={ariaCurrent}
      onClick={() => {
        activeId.value = id;
      }}
    >
      {children}
    </a>
  );
}

function JourneyCard({
  number,
  href,
  title,
  children,
}: {
  number: string;
  href: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <a href={href} class="no-underline group">
      <Card
        as="div"
        padding="none"
        class="p-4 h-full grid grid-cols-[2rem_minmax(0,1fr)] gap-2 transition-colors group-hover:border-border-strong"
      >
        <span class="font-mono text-[11px] font-medium text-accent pt-[3px]">{number}</span>
        <div class="flex flex-col gap-1.5">
          <h2 class="text-[14px] font-medium tracking-[-0.005em] m-0 text-ink">{title}</h2>
          <p class="m-0 text-[12px] text-ink-muted leading-[1.55]">{children}</p>
        </div>
      </Card>
    </a>
  );
}

function Callout({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="border-l-2 border-accent bg-accent-soft px-4 py-3 flex flex-col gap-1.5 max-w-[680px]">
      <span class="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-accent">
        {label}
      </span>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{children}</p>
    </div>
  );
}

function ReviewStep({
  number,
  label,
  children,
}: {
  number: string;
  label: string;
  children: ComponentChildren;
}) {
  return (
    <li class="p-5 flex flex-col gap-2 min-w-0">
      <div class="flex items-baseline gap-2.5">
        <span class="font-mono text-[11px] text-accent">{number}</span>
        <span class="font-medium text-[15px] tracking-[-0.005em]">{label}</span>
      </div>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{children}</p>
    </li>
  );
}

function ReviewAnswer({
  label,
  question,
  children,
}: {
  label: string;
  question: string;
  children: ComponentChildren;
}) {
  return (
    <div class="px-5 py-3.5 grid grid-cols-1 sm:grid-cols-[120px_180px_minmax(0,1fr)] gap-1.5 sm:gap-4 sm:items-baseline">
      <MonoLabel as="dt">{label}</MonoLabel>
      <dd class="m-0 text-[13px] font-medium text-ink">{question}</dd>
      <dd class="m-0 text-[13px] leading-[1.55] text-ink-muted">{children}</dd>
    </div>
  );
}

function ReportRow({
  label,
  value,
  tone = "neutral",
  children,
}: {
  label: string;
  value: string;
  tone?: BadgeTone;
  children: ComponentChildren;
}) {
  return (
    <div class="grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] gap-2 sm:gap-4 px-5 py-4">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle pt-0.5">
        {label}
      </span>
      <div class="flex flex-col items-start gap-1.5">
        <Badge tone={tone}>{value}</Badge>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">{children}</p>
      </div>
    </div>
  );
}

function SafetyItem({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="border-t border-border pt-3 flex flex-col gap-1.5">
      <h4 class="m-0 text-[13px] font-medium tracking-[-0.005em]">{title}</h4>
      <p class="m-0 text-[12px] text-ink-muted leading-[1.6]">{children}</p>
    </div>
  );
}

function PathCard({
  title,
  badge,
  href,
  command,
  bestFor,
  heldBy,
  decision,
}: {
  title: string;
  badge: string;
  href: string;
  command: string;
  bestFor: string;
  heldBy: string;
  decision: string;
}) {
  return (
    <Card as="article" padding="none" class="p-5 flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 class="m-0 text-base font-medium tracking-[-0.005em]">{title}</h4>
        <Badge tone={badge === "Preview" ? "info" : "neutral"}>{badge}</Badge>
      </div>
      <code class="font-mono text-[12px] text-ink bg-surface-2 border border-border rounded px-2.5 py-2 overflow-x-auto">
        {command}
      </code>
      <dl class="m-0 flex flex-col gap-3">
        <Definition label="Best for">{bestFor}</Definition>
        <Definition label="Held by">{heldBy}</Definition>
        <Definition label="Decision">{decision}</Definition>
      </dl>
      <a href={href} class="mt-auto text-[13px] font-medium no-underline">
        Follow this setup →
      </a>
    </Card>
  );
}

function Definition({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <MonoLabel as="dt">{label}</MonoLabel>
      <dd class="m-0 text-[12px] leading-[1.55] text-ink-muted">{children}</dd>
    </div>
  );
}

function Requirement({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="border-t border-border pt-3 flex flex-col gap-1">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <span class="text-[13px] font-medium text-ink">{children}</span>
    </div>
  );
}

function WorkflowExample({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: string;
}) {
  return (
    <details
      open={defaultOpen}
      class="group rounded-md border border-border bg-surface overflow-hidden"
    >
      <summary class="cursor-pointer list-none px-4 py-3 flex items-center gap-2.5 hover:bg-surface-2 transition-colors">
        <span aria-hidden class="text-[10px] text-ink-subtle inline group-open:hidden">
          ▸
        </span>
        <span aria-hidden class="text-[10px] text-ink-subtle hidden group-open:inline">
          ▾
        </span>
        <span class="text-[13px] font-medium text-ink">{title}</span>
      </summary>
      <div class="border-t border-border">
        <CodeBlock lang="yaml" embedded>
          {children}
        </CodeBlock>
      </div>
    </details>
  );
}

function Subsection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div id={id} class="flex flex-col gap-3.5 scroll-mt-6">
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

function CodeBlock({
  name,
  lang,
  embedded = false,
  children,
}: {
  name?: string;
  lang?: string;
  embedded?: boolean;
  children: string;
}) {
  useEffect(() => {
    if (lang) ensureHighlighter();
  }, [lang]);

  const ready = highlighterReady.value;
  const tokens = useMemo(() => {
    if (!lang || !ready) return null;
    return tokenizeLines(children, lang);
  }, [children, lang, ready]);

  return (
    <div
      class={cn(
        "overflow-hidden bg-surface-2",
        embedded ? "border-0 rounded-none" : "rounded-md border border-border",
      )}
    >
      {name ? (
        <div class="px-4 py-2 border-b border-border font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {name}
        </div>
      ) : null}
      <pre class="m-0 p-4 overflow-x-auto font-mono text-[12px] leading-[1.55] text-ink">
        <code>
          {tokens ? (
            tokens.map((line, lineIndex) => (
              <span key={lineIndex} class="block whitespace-pre">
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} class={token.className}>
                    {token.content}
                  </span>
                ))}
              </span>
            ))
          ) : (
            <span class="whitespace-pre">{children}</span>
          )}
        </code>
      </pre>
    </div>
  );
}
