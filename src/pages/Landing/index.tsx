import type { ComponentChildren } from "preact";
import { useComputed, useSignal, type ReadonlySignal, type Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { homePageSeo, PageSeo, StructuredData } from "../../lib/seo";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Badge, type BadgeTone } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { PageShell } from "../../components/PageShell";
import { SeverityBar } from "../../components/SeverityBar";
import { StatusStrip, StatusStripItem } from "../../components/StatusStrip";
import { Eyebrow, MonoDetail, SectionLabel } from "../../components/Typography";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

type DemoStage = "delta" | "finding" | "decision";

interface DemoLine {
  tone: "added" | "removed" | "unchanged";
  before: number | null;
  after: number | null;
  text: string;
}

interface DemoState {
  stage: DemoStage;
  selectedFile: string;
  status: "added" | "modified";
  versionLabel: string;
  lines: DemoLine[];
  finding?: {
    severity: "critical" | "medium";
    ruleId: string;
    line: number;
    reason: ComponentChildren;
  };
}

const DEMO_STATES: Record<DemoStage, DemoState> = {
  delta: {
    stage: "delta",
    selectedFile: "package.json",
    status: "modified",
    versionLabel: "4.2.0 → 4.3.0",
    lines: [
      { tone: "unchanged", before: 3, after: 3, text: '  "version": "4.3.0",' },
      { tone: "unchanged", before: 4, after: 4, text: '  "main": "lib/index.js",' },
      { tone: "unchanged", before: 5, after: 5, text: '  "scripts": {' },
      { tone: "unchanged", before: 6, after: 6, text: '    "build": "tsc -p .",' },
      {
        tone: "added",
        before: null,
        after: 7,
        text: '    "postinstall": "node lib/install.js",',
      },
      { tone: "unchanged", before: 7, after: 8, text: '    "test": "vitest"' },
      { tone: "unchanged", before: 8, after: 9, text: "  }," },
    ],
  },
  finding: {
    stage: "finding",
    selectedFile: "lib/install.js",
    status: "added",
    versionLabel: "new in 4.3.0",
    lines: [
      {
        tone: "added",
        before: null,
        after: 1,
        text: "const { execFileSync } = require('node:child_process');",
      },
      {
        tone: "added",
        before: null,
        after: 2,
        text: "const token = process.env.NPM_TOKEN;",
      },
      { tone: "added", before: null, after: 3, text: "if (token) {" },
      {
        tone: "added",
        before: null,
        after: 4,
        text: "  execFileSync('node', ['lib/bootstrap.js']);",
      },
      { tone: "added", before: null, after: 5, text: "}" },
    ],
    finding: {
      severity: "critical",
      ruleId: "code.credential-access",
      line: 2,
      reason: (
        <>
          The new install path reads <code class="font-mono text-[12px]">NPM_TOKEN</code> and
          launches a second process. This capability is reachable from the added postinstall hook.
        </>
      ),
    },
  },
  decision: {
    stage: "decision",
    selectedFile: "lib/install.js",
    status: "added",
    versionLabel: "review complete",
    lines: [],
  },
};

export default function LandingPage() {
  const authed = useAuthedSession();

  return (
    <PageShell
      class="gap-16 lg:gap-20"
      headerActions={<MarketingHeaderActions authed={authed} page="home" />}
    >
      <PageSeo metadata={homePageSeo} />
      <StructuredData />

      <section class="border-t border-border py-10 md:py-14 lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(480px,1.1fr)] lg:items-center lg:gap-12">
        <div class="flex flex-col items-start gap-5">
          <Eyebrow tone="accent">The last review before publish</Eyebrow>
          <h1 class="m-0 max-w-[760px] text-4xl font-semibold leading-[1.05] tracking-[-0.03em] md:text-5xl">
            Review what ships—not what was committed.
          </h1>
          <p class="m-0 max-w-[620px] text-[17px] leading-[1.6] text-ink-muted">
            Drydock adds a review checkpoint to npm, PyPI, and VS Code releases, compares the built
            artifact with the previous version, and pins suspicious changes to exact lines before a
            maintainer approves.
          </p>
          <div class="mt-1 flex flex-wrap gap-3">
            <Show
              when={authed}
              fallback={<LinkButton href="/register">Protect a release</LinkButton>}
            >
              <LinkButton href="/dashboard">Open dashboard</LinkButton>
            </Show>
            <LinkButton href="#sample-review" variant="secondary">
              Explore a sample review
            </LinkButton>
          </div>
          <MonoDetail
            class="mt-1"
            parts={[
              <span key="npm">npm stage publish</span>,
              <span key="gates">GitHub workflow gates</span>,
              <span key="approval">human approval</span>,
            ]}
          />
        </div>

        <HeroReviewSnapshot />
      </section>

      <StatusStrip>
        <StatusStripItem label="evidence" status="built artifact" tone="info">
          Review the package bytes users will install, including generated files that never lived in
          git.
        </StatusStripItem>
        <StatusStripItem label="sandbox" status="never executes" tone="ok">
          Package contents stay hostile evidence. Drydock parses and diffs them without running
          package code.
        </StatusStripItem>
        <StatusStripItem label="release" status="human decision" tone="neutral">
          The candidate remains held until a maintainer approves in npm or resolves the GitHub gate.
        </StatusStripItem>
      </StatusStrip>

      <ReleaseGap />

      <GuidedReview />

      <DetectionCoverage />

      <ReleaseModes />

      <SecurityContract />

      <AikidoPartnerStrip />

      <ReleaseOperations />

      <ClosingCta authed={authed} />
    </PageShell>
  );
}

function HeroReviewSnapshot() {
  return (
    <Card class="mt-10 overflow-hidden p-0 shadow-sm lg:mt-0" as="article">
      <header class="flex flex-col gap-3 border-b border-border px-5 pb-4 pt-5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              held release
            </span>
            <Badge tone="critical">manual review</Badge>
          </div>
          <span class="font-mono text-[11px] text-ink-subtle">scan_01HXY5K9PNQE3</span>
        </div>
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 class="m-0 text-lg font-semibold tracking-[-0.01em]">@acme/cli</h2>
            <MonoDetail
              class="mt-1"
              parts={[
                <span key="version">4.2.0 → 4.3.0</span>,
                <span key="files">4 changed files</span>,
              ]}
            />
          </div>
          <Badge tone="critical">release critical</Badge>
        </div>
        <SeverityBar counts={{ critical: 1, medium: 1 }} class="max-w-[420px]" />
      </header>
      <div class="border-b border-border bg-surface-2 px-4 py-2">
        <div class="flex items-center gap-2">
          <Badge tone="modified">modified</Badge>
          <code class="font-mono text-[12px] text-ink-muted">package.json</code>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            <DiffLine tone="unchanged" before={5} after={5} text={'  "scripts": {'} />
            <DiffLine tone="unchanged" before={6} after={6} text={'    "build": "tsc -p .",'} />
            <DiffLine
              tone="added"
              before={null}
              after={7}
              text={'    "postinstall": "node lib/install.js",'}
            />
            <DiffLine tone="unchanged" before={7} after={8} text={'    "test": "vitest"'} />
          </tbody>
        </table>
      </div>
      <FindingAnnotation severity="critical" ruleId="install-script.postinstall" line={7}>
        A newly added lifecycle hook runs during installation and reaches a new executable path.
        Inspect the shipped code before approving.
      </FindingAnnotation>
    </Card>
  );
}

function ReleaseGap() {
  return (
    <section id="why" class="scroll-mt-8" aria-labelledby="release-gap-title">
      <SectionLabel>The release-review gap</SectionLabel>
      <div class="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:items-start">
        <div class="flex max-w-[620px] flex-col gap-4">
          <h2
            id="release-gap-title"
            class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
          >
            Your pull request is not the thing users install.
          </h2>
          <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
            Build scripts, bundlers, generated files, and CI credentials all sit between reviewed
            source and a published package. A compromised runner or maintainer account can change
            the artifact without changing repository history.
          </p>
          <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
            Drydock adds a checkpoint after the release is built and before it becomes immutable.
            That is the last moment to compare the actual bytes, explain risky deltas, and stop a
            release safely.
          </p>
        </div>
        <ReleasePath />
      </div>
    </section>
  );
}

function ReleasePath() {
  const steps = [
    {
      number: "01",
      label: "repository",
      title: "Source reviewed",
      body: "Pull requests cover committed source and declared workflow changes.",
      badge: "reviewed",
      tone: "neutral" as const,
    },
    {
      number: "02",
      label: "build",
      title: "Artifact assembled",
      body: "CI generates bundles, manifests, binaries, and package metadata.",
      badge: "changes shape",
      tone: "medium" as const,
    },
    {
      number: "03",
      label: "drydock",
      title: "Release inspected",
      body: "The candidate is diffed, checked, and held for a human decision.",
      badge: "checkpoint",
      tone: "info" as const,
    },
    {
      number: "04",
      label: "registry",
      title: "Package published",
      body: "Only the reviewed release continues to npm, PyPI, or Marketplace.",
      badge: "controlled",
      tone: "ok" as const,
    },
  ];

  return (
    <ol class="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
      {steps.map((step) => (
        <li
          key={step.number}
          class={`flex min-h-[142px] flex-col gap-3 rounded-lg border p-4 ${
            step.label === "drydock"
              ? "border-accent bg-accent-soft/50"
              : "border-border bg-surface"
          }`}
        >
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-[11px] text-ink-subtle">{step.number}</span>
            <Badge tone={step.tone}>{step.badge}</Badge>
          </div>
          <div class="flex flex-col gap-1">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {step.label}
            </span>
            <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{step.title}</h3>
          </div>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}

function GuidedReview() {
  const activeStage = useSignal<DemoStage>("delta");
  const activeContent = useComputed(() => DEMO_STATES[activeStage.value]);

  return (
    <section id="sample-review" class="scroll-mt-8" aria-labelledby="sample-review-title">
      <SectionLabel>Guided product review</SectionLabel>
      <div class="mt-5 flex max-w-[760px] flex-col gap-3">
        <h2
          id="sample-review-title"
          class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
        >
          Follow the evidence from release delta to decision.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Start with what changed, inspect the exact capability that raised risk, then make the
          release call with the artifact and its history in one place.
        </p>
      </div>

      <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          class="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:flex-col"
          aria-label="Sample review stages"
        >
          <DemoStageButton active={activeStage} stage="delta" number="01" title="Release delta">
            Compare the built candidate with the last published version.
          </DemoStageButton>
          <DemoStageButton active={activeStage} stage="finding" number="02" title="Pinned finding">
            Trace risky capability back to the exact shipped line.
          </DemoStageButton>
          <DemoStageButton active={activeStage} stage="decision" number="03" title="Human decision">
            Resolve the held release with a documented recommendation.
          </DemoStageButton>
        </nav>

        <GuidedWorkbench content={activeContent} />
      </div>
    </section>
  );
}

function DemoStageButton({
  active,
  stage,
  number,
  title,
  children,
}: {
  active: Signal<DemoStage>;
  stage: DemoStage;
  number: string;
  title: string;
  children: ComponentChildren;
}) {
  const selected = useComputed(() => active.value === stage);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => (active.value = stage)}
      class="min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong aria-pressed:border-accent aria-pressed:bg-accent-soft/50 lg:flex-none"
    >
      <span class="font-mono text-[11px] text-ink-subtle">{number}</span>
      <span class="mt-2 block text-[14px] font-medium text-ink">{title}</span>
      <span class="mt-1 block text-[12px] leading-[1.5] text-ink-muted">{children}</span>
    </button>
  );
}

function GuidedWorkbench({ content }: { content: ReadonlySignal<DemoState> }) {
  const state = content.value;

  return (
    <Card class="overflow-hidden p-0" as="article">
      <header class="flex flex-col gap-3 border-b border-border px-5 pb-4 pt-5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 class="m-0 text-lg font-semibold tracking-[-0.01em]">@acme/cli</h3>
          <span class="font-mono text-[11px] text-ink-subtle">scan_01HXY5K9PNQE3</span>
        </div>
        <MonoDetail
          parts={[
            <span key="v">4.2.0 → 4.3.0</span>,
            <span key="files">17 files</span>,
            <span key="changed">4 changed</span>,
            <span key="status">complete</span>,
          ]}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone="critical">block manual approval</Badge>
          <Badge tone="critical">release critical</Badge>
          <Badge tone="medium">2 findings</Badge>
        </div>
        <SeverityBar counts={{ critical: 1, medium: 1 }} class="max-w-[420px]" />
      </header>

      <div class="grid grid-cols-1 divide-y divide-border md:grid-cols-[220px_minmax(0,1fr)] md:divide-x md:divide-y-0">
        <aside class="flex flex-col gap-2 bg-bg/40 p-4">
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
            Release tree
          </span>
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[12px]">
            <TreeRow depth={0} folder open name="lib" tone="mixed" />
            <TreeRow
              depth={1}
              name="install.js"
              tone="added"
              findings={1}
              selected={state.selectedFile === "lib/install.js"}
            />
            <TreeRow depth={1} name="api.js" tone="modified" />
            <TreeRow
              depth={0}
              name="package.json"
              tone="modified"
              findings={1}
              selected={state.selectedFile === "package.json"}
            />
            <TreeRow depth={0} name="README.md" tone="unchanged" />
            <TreeRow depth={0} name="LICENSE" tone="unchanged" />
          </ul>
        </aside>

        <div class="flex min-w-0 flex-col">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-2">
            <div class="flex min-w-0 items-center gap-2">
              <Badge tone={state.status}>{state.status}</Badge>
              <code class="truncate font-mono text-xs text-ink-muted">{state.selectedFile}</code>
            </div>
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              {state.versionLabel}
            </span>
          </div>

          {state.stage === "decision" ? (
            <DecisionSnapshot />
          ) : (
            <>
              <div class="overflow-x-auto">
                <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
                  <tbody>
                    {state.lines.map((line, index) => (
                      <DiffLine key={index} {...line} />
                    ))}
                  </tbody>
                </table>
              </div>
              {state.finding ? (
                <FindingAnnotation
                  severity={state.finding.severity}
                  ruleId={state.finding.ruleId}
                  line={state.finding.line}
                >
                  {state.finding.reason}
                </FindingAnnotation>
              ) : (
                <div class="border-t border-border px-4 py-3">
                  <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
                    The release delta introduces a consumer install hook and a new executable file.
                    Select the pinned finding to follow that capability into the artifact.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function DecisionSnapshot() {
  return (
    <div class="flex flex-col gap-5 p-5">
      <div class="flex flex-col gap-2">
        <SectionLabel>Release recommendation</SectionLabel>
        <h4 class="m-0 max-w-[620px] text-lg font-semibold tracking-[-0.01em] text-danger-text">
          Do not publish until the new install path is explained.
        </h4>
        <p class="m-0 max-w-[620px] text-[13px] leading-[1.6] text-ink-muted">
          Version 4.3.0 adds a postinstall hook that reaches new code with credential and process
          capability. The evidence is deterministic and release-critical.
        </p>
      </div>
      <dl class="m-0 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
        <DecisionFact label="artifact risk" value="critical" tone="critical" />
        <DecisionFact label="release state" value="held" tone="medium" />
        <DecisionFact label="decision owner" value="maintainer" tone="neutral" />
      </dl>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span class="font-mono text-[11px] text-ink-subtle">Evidence ready for human review</span>
        <div class="flex gap-2" aria-label="Example release decisions">
          <span class="rounded-md border border-border bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink-muted">
            Approve release
          </span>
          <span class="rounded-md border border-danger bg-danger-soft px-3 py-2 text-[12px] font-medium text-danger-text">
            Block publish
          </span>
        </div>
      </div>
    </div>
  );
}

function DecisionFact({ label, value, tone }: { label: string; value: string; tone: BadgeTone }) {
  return (
    <div class="flex min-h-[84px] flex-col justify-between gap-2 bg-surface p-3">
      <dt class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</dt>
      <dd class="m-0">
        <Badge tone={tone}>{value}</Badge>
      </dd>
    </div>
  );
}

function DetectionCoverage() {
  const detections = [
    {
      label: "install surface",
      title: "Lifecycle and startup hooks",
      body: "New preinstall, install, postinstall, Python build, and VS Code activation paths are surfaced before consumers run them.",
    },
    {
      label: "runtime capability",
      title: "Process and network access",
      body: "Shells, child processes, sockets, HTTP clients, downloaders, and dynamic execution are traced into the changed artifact.",
    },
    {
      label: "sensitive access",
      title: "Credentials and secret files",
      body: "Environment tokens, credential paths, private keys, and accidentally packed secret-bearing files become explicit review evidence.",
    },
    {
      label: "opaque payloads",
      title: "Native and binary artifacts",
      body: "ELF, Mach-O, PE, WebAssembly, and other content that cannot be safely rendered is fingerprinted and held for inspection.",
    },
    {
      label: "artifact integrity",
      title: "Identity and metadata",
      body: "Package names, versions, manifests, wheel records, and VSIX metadata are checked for missing or inconsistent release identity.",
    },
    {
      label: "release history",
      title: "Unexpected risk movement",
      body: "The candidate is compared with the right published baseline so maintainers see what is newly dangerous, not an unrelated wall of changes.",
    },
  ];

  return (
    <section aria-labelledby="detection-title">
      <SectionLabel>Deterministic coverage</SectionLabel>
      <div class="mt-5 flex max-w-[760px] flex-col gap-3">
        <h2
          id="detection-title"
          class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
        >
          Focus attention where a release can change behavior.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Drydock combines full-artifact checks with diff-aware context. Deterministic findings set
          the safety floor; optional AI review can add explanation but cannot lower that risk.
        </p>
      </div>
      <div class="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {detections.map((detection) => (
          <Card as="article" class="flex min-h-[174px] flex-col gap-3 p-5" key={detection.label}>
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {detection.label}
            </span>
            <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{detection.title}</h3>
            <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{detection.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ReleaseModes() {
  return (
    <section id="how-it-works" class="scroll-mt-8" aria-labelledby="release-modes-title">
      <SectionLabel>Two ways to hold a release</SectionLabel>
      <div class="mt-5 flex max-w-[760px] flex-col gap-3">
        <h2
          id="release-modes-title"
          class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
        >
          Meet the package where publication can still stop.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Use npm stage publish when the registry can hold a private candidate. For other releases,
          put Drydock on a GitHub Environment between artifact upload and publication.
        </p>
      </div>
      <div class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ReleaseModeCard
          eyebrow="npm stage publish"
          title="Stage the tarball before 2FA approval."
          badges={["npm", "private candidate"]}
          code="npm stage publish"
        >
          npm parks the exact tarball privately. Drydock compares it with the correct published
          baseline and leaves final approval in npm, using the maintainer's normal 2FA flow.
        </ReleaseModeCard>
        <ReleaseModeCard
          eyebrow="GitHub workflow gate"
          title="Pause CI after the artifact is built."
          badges={["PyPI", "npm", "VS Code"]}
          code="build → upload artifact → drydock gate → publish"
          preview
        >
          A GitHub Environment protection rule holds the publish job. Drydock reviews the immutable
          uploaded artifacts, then posts the maintainer's accept or reject decision back to GitHub.
        </ReleaseModeCard>
      </div>
      <LinkButton href="/docs" variant="ghost" size="sm" class="mt-3 self-start">
        Read the setup guides →
      </LinkButton>
    </section>
  );
}

function ReleaseModeCard({
  eyebrow,
  title,
  badges,
  code,
  preview = false,
  children,
}: {
  eyebrow: string;
  title: string;
  badges: string[];
  code: string;
  preview?: boolean;
  children: ComponentChildren;
}) {
  return (
    <Card as="article" class="flex flex-col gap-4 p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {eyebrow}
        </span>
        {preview ? <Badge tone="info">preview</Badge> : null}
      </div>
      <h3 class="m-0 text-lg font-medium tracking-[-0.01em]">{title}</h3>
      <div class="flex flex-wrap gap-1.5">
        {badges.map((badge) => (
          <Badge key={badge} tone="neutral">
            {badge}
          </Badge>
        ))}
      </div>
      <code class="overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-ink">
        {code}
      </code>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{children}</p>
    </Card>
  );
}

function SecurityContract() {
  const boundaries = [
    {
      label: "package code",
      value: "never executed",
      tone: "ok" as const,
      body: "Artifacts stay hostile evidence inside bounded parsers.",
    },
    {
      label: "publish credentials",
      value: "never collected",
      tone: "ok" as const,
      body: "Approval remains in npm or the protected GitHub job.",
    },
    {
      label: "AI review",
      value: "advisory",
      tone: "neutral" as const,
      body: "Default-off analysis can add context, never downgrade rules.",
    },
    {
      label: "stored evidence",
      value: "redacted",
      tone: "info" as const,
      body: "Reports retain bounded review evidence instead of raw archives.",
    },
    {
      label: "release control",
      value: "human owned",
      tone: "neutral" as const,
      body: "A maintainer accepts or rejects every held release.",
    },
  ];

  return (
    <section id="security" class="scroll-mt-8" aria-labelledby="security-title">
      <SectionLabel>Security contract</SectionLabel>
      <div class="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:items-start">
        <div class="flex max-w-[620px] flex-col gap-4">
          <h2
            id="security-title"
            class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
          >
            A release-security tool should have a narrow blast radius.
          </h2>
          <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
            Drydock is deliberately unable to turn reviewed package content into trusted code or to
            publish on a maintainer's behalf. Its job is to acquire bounded evidence, explain risk,
            and return control to the person responsible for the release.
          </p>
          <LinkButton href="/docs" variant="ghost" size="sm" class="self-start">
            Read setup and trust details →
          </LinkButton>
        </div>
        <Card class="overflow-hidden p-0">
          <dl class="m-0 divide-y divide-border">
            {boundaries.map((boundary) => (
              <div
                key={boundary.label}
                class="grid grid-cols-1 gap-2 px-5 py-4 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-center"
              >
                <dt class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                  {boundary.label}
                </dt>
                <dd class="m-0 text-[13px] leading-[1.5] text-ink-muted">{boundary.body}</dd>
                <dd class="m-0 sm:justify-self-end">
                  <Badge tone={boundary.tone}>{boundary.value}</Badge>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </section>
  );
}

function ReleaseOperations() {
  const features = [
    {
      label: "organization workflow",
      title: "Review with the maintainers who own the release.",
      body: "Organization-scoped access, invitations, roles, and optional two-factor checks keep sensitive decisions with the right team.",
    },
    {
      label: "durable evidence",
      title: "Keep the reason behind every release call.",
      body: "Canonical JSON reports, review history, and a 90-day organization audit log make approvals and blocks explainable later.",
    },
    {
      label: "operator signal",
      title: "Bring release status into the team's existing loop.",
      body: "Slack notifications surface completed or failed staged-publish scans and workflow-gate reviews that are ready for a maintainer.",
    },
    {
      label: "deployment boundary",
      title: "Run Drydock in your own Cloudflare account.",
      body: "The Worker, D1, R2, queues, and sandbox can be self-hosted when release evidence needs to stay inside your operating boundary.",
    },
  ];

  return (
    <section aria-labelledby="operations-title">
      <SectionLabel>Release operations</SectionLabel>
      <div class="mt-5 flex max-w-[760px] flex-col gap-3">
        <h2
          id="operations-title"
          class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]"
        >
          Built for a release process, not a one-off scan.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Drydock keeps the review, decision, and operational trail together while publication
          remains in the registry and CI systems your team already controls.
        </p>
      </div>
      <div class="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {features.map((feature) => (
          <Card as="article" class="flex flex-col gap-3 p-5" key={feature.label}>
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {feature.label}
            </span>
            <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{feature.title}</h3>
            <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{feature.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ClosingCta({ authed }: { authed: Signal<boolean> }) {
  return (
    <Card class="flex flex-col items-start gap-5 border-border-strong p-6 md:p-8">
      <Eyebrow tone="accent">Your next release</Eyebrow>
      <div class="flex max-w-[760px] flex-col gap-3">
        <h2 class="m-0 text-3xl font-semibold leading-[1.15] tracking-[-0.02em]">
          Put a review gate before the publish command.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Start with npm stage publish or connect a GitHub Environment for PyPI, npm, and VS Code
          release workflows.
        </p>
      </div>
      <div class="flex flex-wrap gap-3">
        <Show when={authed} fallback={<LinkButton href="/register">Protect a release</LinkButton>}>
          <LinkButton href="/dashboard">Open dashboard</LinkButton>
        </Show>
        <LinkButton href="/docs" variant="secondary">
          Read the setup guides
        </LinkButton>
      </div>
    </Card>
  );
}

function TreeRow({
  depth,
  name,
  tone,
  findings,
  folder,
  open,
  selected,
}: {
  depth: number;
  name: string;
  tone: "added" | "removed" | "modified" | "unchanged" | "mixed";
  findings?: number;
  folder?: boolean;
  open?: boolean;
  selected?: boolean;
}) {
  const toneClass =
    tone === "added"
      ? "text-ok-text"
      : tone === "removed"
        ? "text-danger-text"
        : tone === "modified"
          ? "text-warn-text"
          : tone === "mixed"
            ? "text-accent"
            : "text-ink-muted";
  return (
    <li
      class={`flex items-center gap-2 rounded py-0.5 pl-1 pr-1.5 ${
        selected ? "bg-surface-2 text-ink" : toneClass
      }`}
    >
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} class="w-4 shrink-0" aria-hidden />
      ))}
      {folder ? (
        <span aria-hidden class="text-[10px] text-ink-subtle">
          {open ? "▾" : "▸"}
        </span>
      ) : (
        <span class="w-[10px]" aria-hidden />
      )}
      <span class={`flex-1 truncate ${selected ? "text-ink" : ""}`}>
        {name}
        {folder ? "/" : ""}
      </span>
      {findings ? (
        <Badge tone="medium">
          {findings} {findings === 1 ? "finding" : "findings"}
        </Badge>
      ) : null}
    </li>
  );
}

function DiffLine({
  tone,
  before,
  after,
  text,
}: {
  tone: "added" | "removed" | "unchanged";
  before: number | null;
  after: number | null;
  text: string;
}) {
  const bg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const sign = tone === "added" ? "+" : tone === "removed" ? "-" : " ";
  return (
    <tr class={bg}>
      <td class="w-[44px] select-none border-r border-border px-2 py-[2px] text-right align-top text-ink-subtle">
        {before ?? ""}
      </td>
      <td class="w-[44px] select-none border-r border-border px-2 py-[2px] text-right align-top text-ink-subtle">
        {after ?? ""}
      </td>
      <td class="w-[20px] select-none px-2 py-[2px] align-top text-ink-subtle">{sign}</td>
      <td class="whitespace-pre-wrap break-words px-2 py-[2px] align-top">{text}</td>
    </tr>
  );
}

function FindingAnnotation({
  severity,
  ruleId,
  line,
  children,
}: {
  severity: "critical" | "medium";
  ruleId: string;
  line: number;
  children: ComponentChildren;
}) {
  const toneClass =
    severity === "critical" ? "border-l-danger bg-danger-soft/40" : "border-l-warn bg-warn-soft/40";
  return (
    <div class={`flex flex-col gap-1.5 border-l-2 border-t border-t-border px-4 py-3 ${toneClass}`}>
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={severity}>{severity}</Badge>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          {ruleId} · line {line}
        </span>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink">{children}</p>
    </div>
  );
}
