import { diffArrays, diffLines, diffWordsWithSpace, type ChangeObject } from "diff";
import { Fragment } from "preact";
import { useSignal, type Signal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import { Badge, severityTone, statusTone } from "./Badge";
import {
  annotationLabel,
  partitionFindingsByLine,
  severityGroup,
  type DiffFinding,
  type SeverityGroup,
} from "./diff-annotations";
import {
  diffOverviewMarkers,
  type DiffOverviewMarker,
  type DiffOverviewRow,
} from "./diff-overview";
import {
  ensureHighlighter,
  highlighterReady,
  langForPath,
  tokenizeLines,
  type TokenLine,
} from "./highlight";
import { Muted } from "./Typography";
import { cn } from "./cn";

export type { DiffFinding } from "./diff-annotations";

interface DiffSide {
  textSample?: string | null;
  size?: number | null;
  sha256?: string | null;
  flags?: string[];
}

export interface DiffViewProps {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged" | string;
  before: DiffSide | null;
  after: DiffSide | null;
  beforeLabel: string;
  afterLabel: string;
  // Deterministic findings for this file, pinned to the staged line they
  // reference. Findings without a matching line surface in a banner above the
  // diff so a truncated sample can't hide a signal.
  findings?: DiffFinding[];
}

interface Row {
  tone: "added" | "removed" | "unchanged";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
  tokens: TokenLine | null;
  wordParts: WordPart[] | null;
}

interface WordPart {
  text: string;
  tone: "added" | "removed" | "unchanged";
}

interface RowChunk {
  tone: Row["tone"];
  rows: Row[];
}

interface DiffOptions {
  wordDiff?: boolean;
  ignoreWhitespace?: boolean;
}

export function buildRows(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
  options: DiffOptions = {},
): Row[] {
  const chunks = options.ignoreWhitespace
    ? buildRowsIgnoringWhitespace(before, after, beforeTokens, afterTokens)
    : buildRowsFromLineDiff(before, after, beforeTokens, afterTokens);
  if (options.wordDiff) applyWordDiff(chunks, Boolean(options.ignoreWhitespace));
  return chunks.flatMap((chunk) => chunk.rows);
}

function buildRowsFromLineDiff(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
): RowChunk[] {
  const parts = diffLines(before, after);
  const chunks: RowChunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const part of parts) {
    const rows: Row[] = [];
    const lines = splitLines(part.value);
    for (const line of lines) {
      if (part.added) {
        afterLine += 1;
        rows.push({
          tone: "added",
          beforeLine: null,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? null,
          wordParts: null,
        });
      } else if (part.removed) {
        beforeLine += 1;
        rows.push({
          tone: "removed",
          beforeLine,
          afterLine: null,
          text: line,
          tokens: beforeTokens?.[beforeLine - 1] ?? null,
          wordParts: null,
        });
      } else {
        beforeLine += 1;
        afterLine += 1;
        rows.push({
          tone: "unchanged",
          beforeLine,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? beforeTokens?.[beforeLine - 1] ?? null,
          wordParts: null,
        });
      }
    }
    if (rows.length) {
      chunks.push({
        tone: part.added ? "added" : part.removed ? "removed" : "unchanged",
        rows,
      });
    }
  }
  return chunks;
}

function buildRowsIgnoringWhitespace(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
): RowChunk[] {
  const parts = diffArrays(splitLines(before), splitLines(after), {
    comparator: linesEqualIgnoringWhitespace,
  });
  const chunks: RowChunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const part of parts) {
    const rows: Row[] = [];
    for (const line of part.value) {
      if (part.added) {
        afterLine += 1;
        rows.push({
          tone: "added",
          beforeLine: null,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? null,
          wordParts: null,
        });
      } else if (part.removed) {
        beforeLine += 1;
        rows.push({
          tone: "removed",
          beforeLine,
          afterLine: null,
          text: line,
          tokens: beforeTokens?.[beforeLine - 1] ?? null,
          wordParts: null,
        });
      } else {
        beforeLine += 1;
        afterLine += 1;
        rows.push({
          tone: "unchanged",
          beforeLine,
          afterLine,
          text: line,
          tokens: afterTokens?.[afterLine - 1] ?? beforeTokens?.[beforeLine - 1] ?? null,
          wordParts: null,
        });
      }
    }
    if (rows.length) {
      chunks.push({
        tone: part.added ? "added" : part.removed ? "removed" : "unchanged",
        rows,
      });
    }
  }
  return chunks;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function linesEqualIgnoringWhitespace(left: string, right: string): boolean {
  return stripWhitespace(left) === stripWhitespace(right);
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function applyWordDiff(chunks: RowChunk[], ignoreWhitespace: boolean) {
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const removed = chunks[index];
    const added = chunks[index + 1];
    if (removed.tone !== "removed" || added.tone !== "added") continue;
    const pairedRows = Math.min(removed.rows.length, added.rows.length);
    for (let rowIndex = 0; rowIndex < pairedRows; rowIndex += 1) {
      const parts = buildWordParts(
        removed.rows[rowIndex].text,
        added.rows[rowIndex].text,
        ignoreWhitespace,
      );
      removed.rows[rowIndex].wordParts = parts.before;
      added.rows[rowIndex].wordParts = parts.after;
    }
  }
}

function buildWordParts(
  before: string,
  after: string,
  ignoreWhitespace: boolean,
): { before: WordPart[]; after: WordPart[] } {
  const beforeParts: WordPart[] = [];
  const afterParts: WordPart[] = [];
  for (const part of diffWordsWithSpace(before, after) as ChangeObject<string>[]) {
    const tone = whitespaceOnly(part.value) && ignoreWhitespace ? "unchanged" : partTone(part);
    if (!part.added) beforeParts.push({ text: part.value, tone });
    if (!part.removed) afterParts.push({ text: part.value, tone });
  }
  return { before: beforeParts, after: afterParts };
}

function whitespaceOnly(value: string): boolean {
  return value.trim() === "";
}

function partTone(part: ChangeObject<string>): WordPart["tone"] {
  if (part.added) return "added";
  if (part.removed) return "removed";
  return "unchanged";
}

// Tokenize an entire side once, memoized on the sample/language/ready signal.
function useLineTokens(text: string, lang: string | undefined): TokenLine[] | null {
  const ready = highlighterReady.value;
  return useMemo(
    () => (lang && ready && text ? tokenizeLines(text, lang) : null),
    [text, lang, ready],
  );
}

function LineContent({
  text,
  tokens,
  wordParts,
}: {
  text: string;
  tokens: TokenLine | null;
  wordParts: WordPart[] | null;
}) {
  if (wordParts) {
    return (
      <>
        {wordParts.map((part, index) => (
          <span key={index} class={wordPartClass(part.tone)}>
            {part.text}
          </span>
        ))}
      </>
    );
  }
  if (!tokens || tokens.length === 0) return <>{text}</>;
  // Token content is rendered as escaped text children (never innerHTML) so
  // untrusted package bytes can't inject markup.
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} class={token.className}>
          {token.content}
        </span>
      ))}
    </>
  );
}

function wordPartClass(tone: WordPart["tone"]): string | undefined {
  if (tone === "added") return "rounded-[2px] bg-ok/25";
  if (tone === "removed") return "rounded-[2px] bg-danger/25";
  return undefined;
}

function hasFlag(side: DiffSide | null, flag: string): boolean {
  return Boolean(side?.flags?.includes(flag));
}

export function DiffView({
  path,
  status,
  before,
  after,
  beforeLabel,
  afterLabel,
  findings = [],
}: DiffViewProps) {
  const beforeSample = before?.textSample ?? "";
  const afterSample = after?.textSample ?? "";
  const wordDiff = useSignal(false);
  const ignoreWhitespace = useSignal(false);

  const binary = hasFlag(before, "binary") || hasFlag(after, "binary");
  const truncated = hasFlag(before, "truncated") || hasFlag(after, "truncated");
  const showDiffOptions = !binary && Boolean(beforeSample && afterSample);

  return (
    <div class="flex flex-col gap-3 min-h-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(status)}>{status}</Badge>
          <code class="font-mono text-xs text-ink-muted break-all">{path}</code>
          {truncated ? <Badge tone="neutral">truncated</Badge> : null}
          {binary ? <Badge tone="neutral">binary</Badge> : null}
        </div>
        {showDiffOptions ? (
          <DiffControls wordDiff={wordDiff} ignoreWhitespace={ignoreWhitespace} />
        ) : null}
      </div>
      <div class="font-mono text-[11px] text-ink-subtle flex flex-wrap gap-3">
        <span>
          {beforeLabel}: {formatSize(before?.size ?? null)}
        </span>
        <span>
          {afterLabel}: {formatSize(after?.size ?? null)}
        </span>
      </div>
      <DiffBody
        path={path}
        status={status}
        beforeSample={beforeSample}
        afterSample={afterSample}
        binary={binary}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        findings={findings}
        wordDiff={wordDiff.value}
        ignoreWhitespace={ignoreWhitespace.value}
      />
    </div>
  );
}

function DiffControls({
  wordDiff,
  ignoreWhitespace,
}: {
  wordDiff: Signal<boolean>;
  ignoreWhitespace: Signal<boolean>;
}) {
  return (
    <div class="flex flex-wrap items-center gap-1.5" aria-label="Diff display options">
      <DiffOptionToggle
        label="Toggle word diff"
        description="Highlight changed words"
        checked={wordDiff}
      />
      <DiffOptionToggle
        label="Toggle whitespace"
        description="Ignore whitespace"
        checked={ignoreWhitespace}
      />
    </div>
  );
}

function DiffOptionToggle({
  label,
  description,
  checked,
}: {
  label: string;
  description: string;
  checked: Signal<boolean>;
}) {
  return (
    <label class="cursor-pointer">
      <input
        type="checkbox"
        class="sr-only peer"
        checked={checked.value}
        onChange={(event) => (checked.value = event.currentTarget.checked)}
        aria-label={description}
      />
      <span
        title={description}
        class="inline-flex items-center rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] leading-none text-ink-muted transition-colors peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-ink peer-focus-visible:shadow-[0_0_0_3px_var(--color-accent-soft)]"
      >
        {label}
      </span>
    </label>
  );
}

function DiffBody({
  path,
  status,
  beforeSample,
  afterSample,
  binary,
  beforeLabel,
  afterLabel,
  findings,
  wordDiff,
  ignoreWhitespace,
}: {
  path: string;
  status: string;
  beforeSample: string;
  afterSample: string;
  binary: boolean;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  wordDiff: boolean;
  ignoreWhitespace: boolean;
}) {
  const lang = langForPath(path);
  if (lang && !binary) ensureHighlighter();
  const beforeTokens = useLineTokens(beforeSample, lang);
  const afterTokens = useLineTokens(afterSample, lang);

  if (binary) {
    return <DiffMessage findings={findings}>Binary file. No text diff available.</DiffMessage>;
  }

  if (status === "added") {
    if (!afterSample) {
      return <DiffMessage findings={findings}>No preview stored for this added file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
      />
    );
  }
  if (status === "removed") {
    if (!beforeSample) {
      return (
        <DiffMessage findings={findings}>No preview stored for this removed file.</DiffMessage>
      );
    }
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
      />
    );
  }
  if (status === "unchanged") {
    if (!afterSample && !beforeSample) {
      return <DiffMessage findings={findings}>No preview stored for this file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        label={afterLabel || beforeLabel}
        tone="unchanged"
        text={afterSample || beforeSample}
        tokens={afterSample ? afterTokens : beforeTokens}
        findings={findings}
      />
    );
  }
  if (!beforeSample && !afterSample) {
    return <DiffMessage findings={findings}>No text samples available to diff.</DiffMessage>;
  }
  if (!beforeSample) {
    return (
      <SingleSidedView
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
      />
    );
  }
  if (!afterSample) {
    return (
      <SingleSidedView
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
      />
    );
  }

  const rows = buildRows(beforeSample, afterSample, beforeTokens, afterTokens, {
    wordDiff,
    ignoreWhitespace,
  });
  const presentLines = new Set<number>();
  for (const row of rows) if (row.afterLine !== null) presentLines.add(row.afterLine);
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div class="bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex justify-between">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      {unpinned.length ? <AnnotationBanner findings={unpinned} /> : null}
      <div class="relative h-[560px]">
        <div class="overflow-auto h-full pr-5">
          <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {rows.map((row, index) => {
                const pins = row.afterLine !== null ? pinned.get(row.afterLine) : undefined;
                return (
                  <Fragment key={index}>
                    <DiffRow row={row} />
                    {pins ? <AnnotationRows findings={pins} colSpan={4} /> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <DiffOverview markers={diffOverviewMarkers(toOverviewRows(rows), pinned)} />
      </div>
    </div>
  );
}

function DiffRow({ row }: { row: Row }) {
  const bg = row.tone === "added" ? "bg-ok-soft" : row.tone === "removed" ? "bg-danger-soft" : "";
  const sign = row.tone === "added" ? "+" : row.tone === "removed" ? "-" : " ";
  return (
    <tr class={cn(bg)}>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {row.beforeLine ?? ""}
      </td>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {row.afterLine ?? ""}
      </td>
      <td class="px-2 py-[2px] select-none w-[20px] text-ink-subtle align-top">{sign}</td>
      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
        <LineContent text={row.text} tokens={row.tokens} wordParts={row.wordParts} />
      </td>
    </tr>
  );
}

function SingleSidedView({
  label,
  tone,
  text,
  tokens,
  findings,
}: {
  label: string;
  tone: "added" | "removed" | "unchanged";
  text: string;
  tokens: TokenLine[] | null;
  findings: DiffFinding[];
}) {
  const headerBg =
    tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "bg-surface-2";
  const rowBg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const presentLines = new Set<number>(lines.map((_, index) => index + 1));
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div
        class={cn(
          "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle",
          headerBg,
        )}
      >
        {label}
      </div>
      {unpinned.length ? <AnnotationBanner findings={unpinned} /> : null}
      <div class="relative h-[560px]">
        <div class="overflow-auto h-full pr-5">
          <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {lines.map((line, index) => {
                const pins = pinned.get(index + 1);
                return (
                  <Fragment key={index}>
                    <tr class={cn(rowBg)}>
                      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
                        {index + 1}
                      </td>
                      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">
                        <LineContent
                          text={line}
                          tokens={tokens?.[index] ?? null}
                          wordParts={null}
                        />
                      </td>
                    </tr>
                    {pins ? <AnnotationRows findings={pins} colSpan={2} /> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <DiffOverview
          markers={diffOverviewMarkers(
            lines.map((_, index) => ({ tone, line: index + 1 })),
            pinned,
          )}
        />
      </div>
    </div>
  );
}

function toOverviewRows(rows: readonly Row[]): DiffOverviewRow[] {
  return rows.map((row) => ({ tone: row.tone, line: row.afterLine }));
}

function DiffOverview({ markers }: { markers: DiffOverviewMarker[] }) {
  if (!markers.length) return null;
  return (
    <div
      aria-hidden="true"
      class="pointer-events-none absolute right-1 top-2 bottom-2 w-[6px] rounded-full border border-border bg-surface/80 shadow-sm"
    >
      {markers.map((marker) => (
        <span
          key={marker.key}
          class={cn(
            "absolute left-[-1px] right-[-1px] rounded-full",
            markerClass(marker),
            marker.kind === "finding" ? "z-10 ring-1 ring-surface" : "opacity-75",
          )}
          style={{
            top: `${marker.topPercent}%`,
            height: `${marker.heightPercent}%`,
          }}
        />
      ))}
    </div>
  );
}

function markerClass(marker: DiffOverviewMarker): string {
  if (marker.tone === "added" || marker.tone === "ok") return "bg-ok";
  if (marker.tone === "removed" || marker.tone === "danger") return "bg-danger";
  if (marker.tone === "warn") return "bg-warn";
  return "bg-info";
}

// Severity-tinted fills and left bars for a pinned finding. The fill uses the
// soft severity token at reduced opacity so it reads as a callout over the
// green/red row backgrounds; the bar uses the saturated token (shapes, per
// DESIGN.md "color = signal"). Both are static class strings so Tailwind keeps
// them.
const ANNOTATION_FILL: Record<SeverityGroup, string> = {
  danger: "bg-danger-soft/60",
  warn: "bg-warn-soft/60",
  info: "bg-info-soft/60",
  ok: "bg-ok-soft/60",
};

const ANNOTATION_BAR: Record<SeverityGroup, string> = {
  danger: "border-danger",
  warn: "border-warn",
  info: "border-info",
  ok: "border-ok",
};

// The body of a pinned finding: severity Badge + mono `ruleId · line N` caption,
// the reason, and (when present) the triggering evidence in mono. Mirrors the
// landing page's review-preview annotation so what we advertise matches the app.
function FindingAnnotationBody({ finding }: { finding: DiffFinding }) {
  const group = severityGroup(finding.severity);
  const label = annotationLabel(finding);
  return (
    <div
      class={cn(
        // font-sans: the callout sits inside the mono diff table, but the reason
        // is body copy and must not inherit Geist Mono (label/evidence set their
        // own mono explicitly).
        "border-l-2 px-3 py-2.5 flex flex-col gap-1.5 font-sans",
        ANNOTATION_FILL[group],
        ANNOTATION_BAR[group],
      )}
    >
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
        {label ? (
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
            {label}
          </span>
        ) : null}
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink whitespace-normal">{finding.reason}</p>
      {finding.evidence ? (
        <code class="font-mono text-[11px] leading-[1.5] text-ink-muted break-words whitespace-pre-wrap">
          {finding.evidence}
        </code>
      ) : null}
    </div>
  );
}

// Findings pinned beneath their diff line, rendered as full-width table rows.
function AnnotationRows({ findings, colSpan }: { findings: DiffFinding[]; colSpan: number }) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id}>
          <td colSpan={colSpan} class="p-0">
            <FindingAnnotationBody finding={finding} />
          </td>
        </tr>
      ))}
    </>
  );
}

// Findings that can't be pinned (no line, or a line past a truncated sample),
// shown between the header strip and the scroll region so they're never hidden.
function AnnotationBanner({ findings }: { findings: DiffFinding[] }) {
  return (
    <div class="flex flex-col divide-y divide-border border-b border-border">
      {findings.map((finding) => (
        <FindingAnnotationBody key={finding.id} finding={finding} />
      ))}
    </div>
  );
}

// A non-table fallback (binary / no-sample) that still surfaces any findings as
// standalone callouts above the explanatory line, so a missing diff body never
// drops a deterministic signal.
function DiffMessage({ children, findings }: { children: string; findings: DiffFinding[] }) {
  if (!findings.length) return <Muted class="text-[13px]">{children}</Muted>;
  return (
    <div class="flex flex-col gap-3">
      <div class="border border-border rounded-md overflow-hidden flex flex-col divide-y divide-border">
        {findings.map((finding) => (
          <FindingAnnotationBody key={finding.id} finding={finding} />
        ))}
      </div>
      <Muted class="text-[13px]">{children}</Muted>
    </div>
  );
}

function formatSize(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
