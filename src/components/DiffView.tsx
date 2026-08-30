import { Fragment, type ComponentChildren } from "preact";
import { useSignal, type Signal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { Badge, statusTone } from "./Badge";
import { partitionFindingsByLine, type DiffFinding } from "./diff-annotations";
import { buildDisplaySegments, GAP_EXPAND_STEP, GAP_SHOW_ALL_MAX } from "./diff-hunks";
import { diffOverviewMarkers, displayOverviewRows } from "./diff-overview";
import { DiffOverview } from "./DiffOverview";
import { AnnotationBanner, AnnotationRows, DiffMessage } from "./DiffAnnotations";
import { buildRows, splitLines, type Row, type WordPart } from "./diff-rows";
import {
  initialScrollResetKey,
  isDiffScrollTarget,
  resetDiffScroll,
  shouldSeekInitialDiffTarget,
  type DiffScrollState,
} from "./diff-scroll";
import {
  formatLanguageFor,
  formatSourcePair,
  looksMinified,
  remapFindingLines,
  sourceGoalForPath,
} from "./format-source";
import {
  canHighlight,
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
  // Annotations for this file — deterministic findings, assistant findings, and
  // assistant comments alike — pinned to the staged line they reference.
  // Anything without a matching line surfaces in a banner above the diff so a
  // truncated sample can't hide a signal.
  findings?: DiffFinding[];
}

// Tokenize an entire side once, memoized on the text/language/ready signal.
// Sides beyond the highlight cap stay plain text: tokenizing them would block
// the main thread for seconds (see HIGHLIGHT_MAX_LINES).
//
// The cap is applied to the text actually handed to shiki, which is the
// reformatted one when the reformat is on. Its cost is dominated by per-line
// work, not by total characters: a 128 KiB bundle re-flows to ~5,700 lines and
// measures ~0.5s -> ~1.9s per side, so exempting reformatted sides would blow
// the very budget HIGHLIGHT_MAX_LINES exists to hold. Past the cap the reformat
// still runs — structure a reviewer can read beats colour.
function useLineTokens(text: string, lang: string | undefined): TokenLine[] | null {
  const ready = highlighterReady.value;
  return useMemo(
    () => (lang && ready && text && canHighlight(text) ? tokenizeLines(text, lang) : null),
    [text, lang, ready],
  );
}

function DiffScrollViewport({
  resetKey,
  scrollState,
  label,
  children,
}: {
  resetKey: string;
  scrollState: Signal<DiffScrollState | null>;
  label: string;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const syncScrollState = () => {
    const container = ref.current;
    if (!container) return;
    scrollState.value = {
      top: container.scrollTop,
      viewport: container.clientHeight,
      content: container.scrollHeight,
    };
  };
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const frame = window.requestAnimationFrame(() => {
      resetDiffScroll(container);
      syncScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resetKey]);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    // Content height changes without a scroll event (gap expansion, lazy
    // syntax highlighting), so observe the table as well as the viewport.
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    // overflow-anchor off: expanding a gap inserts rows at/below the clicked
    // button, which is stable with an untouched scrollTop. Browser scroll
    // anchoring can pick the button itself as anchor (when it sits at the
    // viewport top) and jump the scroll past the newly revealed rows; Safari
    // has no anchoring at all. Disabling it makes every browser behave the
    // same.
    // tabIndex + region role: an overflow div is otherwise unreachable by
    // keyboard, making the capped pane unscrollable without a mouse. The focus
    // ring is inset because the border shell clips an outer halo;
    // overscroll-contain keeps wheel momentum at the pane's edges from
    // scrolling the page underneath.
    // max-h rather than a fixed height: a two-line diff should be two lines
    // tall, not 560px of empty pane. Long files still cap and scroll.
    <div
      ref={ref}
      onScroll={syncScrollState}
      tabIndex={0}
      role="region"
      aria-label={label}
      class="overflow-auto max-h-[560px] pr-5 [overflow-anchor:none] overscroll-contain outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--color-accent-soft)]"
    >
      {children}
    </div>
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

// Display labels for the parser's magic-byte flags (sniffNativeArtifact in
// server/lib/tar-parser.js). Content-skipped binaries never get the "binary"
// flag, so this badge is the only format cue for a skipped platform binary.
const NATIVE_FLAG_BADGES: Record<string, string> = {
  "native-elf": "elf binary",
  "native-macho": "mach-o binary",
  "native-pe": "pe binary",
  "native-wasm": "wasm",
};

export function nativeBadge(side: DiffSide | null): string | null {
  for (const flag of side?.flags ?? []) {
    const label = NATIVE_FLAG_BADGES[flag];
    if (label) return label;
  }
  return null;
}

// The sha256 identity lines rendered under the size row. Only surfaced when
// there is no text body to review (binary / content-skipped / native): there
// the hash is what a reviewer takes to the registry artifact to verify bytes.
// Exported for tests.
export function diffHashLines(
  before: DiffSide | null,
  after: DiffSide | null,
  beforeLabel: string,
  afterLabel: string,
): string[] {
  const noTextBody =
    hasFlag(before, "binary") ||
    hasFlag(after, "binary") ||
    hasFlag(before, "content-skipped") ||
    hasFlag(after, "content-skipped") ||
    // A dropped display sample leaves the hash as the only evidence the
    // reviewer can take back to the artifact, so it belongs here too.
    hasFlag(before, "sample-omitted") ||
    hasFlag(after, "sample-omitted") ||
    Boolean(nativeBadge(before) ?? nativeBadge(after));
  if (!noTextBody) return [];
  // Legacy artifacts persisted before skip-hashing carry no hash — omit
  // rather than print an empty field.
  const beforeSha = before?.sha256 || null;
  const afterSha = after?.sha256 || null;
  if (beforeSha && beforeSha === afterSha) return [`sha256 ${beforeSha}`];
  const lines: string[] = [];
  if (beforeSha) lines.push(`sha256 (${beforeLabel}): ${beforeSha}`);
  if (afterSha) lines.push(`sha256 (${afterLabel}): ${afterSha}`);
  return lines;
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
  const contentSkipped = hasFlag(before, "content-skipped") || hasFlag(after, "content-skipped");
  const truncated = hasFlag(before, "truncated") || hasFlag(after, "truncated");
  // SAMPLE_OMITTED_FLAG in server/lib/public-diff.ts: the parser did capture a
  // body, but it did not fit the public diff's cached sample budget.
  const sampleOmitted = hasFlag(before, "sample-omitted") || hasFlag(after, "sample-omitted");
  const native = nativeBadge(after) ?? nativeBadge(before);
  const showDiffOptions = !binary && !contentSkipped && Boolean(beforeSample && afterSample);
  const hashLines = diffHashLines(before, after, beforeLabel, afterLabel);

  const formatLang = formatLanguageFor(langForPath(path));
  const sourceGoal = sourceGoalForPath(path);
  const reformattable =
    formatLang !== null && !binary && !contentSkipped && Boolean(beforeSample || afterSample);
  // Minified samples arrive reformatted. A one-line bundle is the case this
  // exists for, and leaving it opt-in would mean the default review surface for
  // every `dist/` artifact stays the one nobody can read.
  const autoReformat = reformattable && (looksMinified(beforeSample) || looksMinified(afterSample));
  // Keyed on the file identity so the choice applies to the file it was made on
  // and a newly selected file picks its own default, without an effect.
  const reformatKey = initialScrollResetKey(path, status, beforeSample, afterSample);
  const reformatChoice = useSignal<{ key: string; enabled: boolean } | null>(null);
  const choice = reformatChoice.value;
  const reformat =
    reformattable && (choice?.key === reformatKey ? choice.enabled : autoReformat)
      ? formatLang
      : null;

  // Re-flowing a side is a per-file, per-toggle cost; memoized so scroll-adjacent
  // rerenders never re-lex a megabyte of package bytes. It lives here rather than
  // in DiffBody because the meta row below has to describe the text that is
  // actually rendered — whether it was reformatted, and whether it still fits the
  // highlight cap once it was.
  const { before: beforeFormatted, after: afterFormatted } = useMemo(
    () =>
      reformat
        ? formatSourcePair(beforeSample, afterSample, reformat, sourceGoal)
        : { before: null, after: null },
    [beforeSample, afterSample, reformat, sourceGoal],
  );
  const beforeText = beforeFormatted?.text ?? beforeSample;
  const afterText = afterFormatted?.text ?? afterSample;
  // A source with nothing left to re-flow comes back unchanged, and saying
  // "reformatted" over bytes nobody touched is the kind of small lie that costs a
  // reviewer their trust in the whole surface.
  const reformatted = beforeFormatted !== null || afterFormatted !== null;
  // Findings are pinned by line, so a reformatted side has to carry them along or
  // every annotation lands on the wrong row. Each side gets its own mapping
  // because which side is rendered depends on the diff status.
  const beforeFindings = useMemo(
    () => remapFindingLines(findings, beforeFormatted),
    [findings, beforeFormatted],
  );
  const afterFindings = useMemo(
    () => remapFindingLines(findings, afterFormatted),
    [findings, afterFormatted],
  );
  const highlightCapped =
    !binary &&
    !contentSkipped &&
    Boolean(langForPath(path)) &&
    (!canHighlight(beforeText) || !canHighlight(afterText));

  return (
    <div class="flex flex-col gap-3 min-h-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(status)}>{status}</Badge>
          <code class="font-mono text-xs text-ink-muted break-all">{path}</code>
          {truncated ? <Badge tone="neutral">truncated</Badge> : null}
          {binary ? <Badge tone="neutral">binary</Badge> : null}
          {contentSkipped ? <Badge tone="neutral">content skipped</Badge> : null}
          {sampleOmitted ? <Badge tone="neutral">sample omitted</Badge> : null}
          {native ? <Badge tone="neutral">{native}</Badge> : null}
        </div>
        {showDiffOptions || reformattable ? (
          <DiffControls
            wordDiff={wordDiff}
            ignoreWhitespace={ignoreWhitespace}
            showDiffToggles={showDiffOptions}
            reformat={
              reformattable
                ? {
                    enabled: reformat !== null,
                    toggle: (enabled) => (reformatChoice.value = { key: reformatKey, enabled }),
                  }
                : null
            }
          />
        ) : null}
      </div>
      <div class="font-mono text-[11px] text-ink-subtle flex flex-col gap-1">
        <div class="flex flex-wrap gap-3">
          <span>
            {beforeLabel}: {formatSize(before?.size ?? null)}
          </span>
          <span>
            {afterLabel}: {formatSize(after?.size ?? null)}
          </span>
          {reformatted ? <span>reformatted for review</span> : null}
          {highlightCapped ? <span>syntax highlighting off (large file)</span> : null}
        </div>
        {hashLines.map((line) => (
          <span key={line} class="break-all">
            {line}
          </span>
        ))}
      </div>
      <DiffBody
        path={path}
        status={status}
        beforeText={beforeText}
        afterText={afterText}
        binary={binary}
        contentSkipped={contentSkipped}
        sampleOmitted={sampleOmitted}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        findings={findings}
        beforeFindings={beforeFindings}
        afterFindings={afterFindings}
        wordDiff={wordDiff.value}
        ignoreWhitespace={ignoreWhitespace.value}
      />
    </div>
  );
}

interface ReformatControl {
  enabled: boolean;
  toggle: (enabled: boolean) => void;
}

function DiffControls({
  wordDiff,
  ignoreWhitespace,
  showDiffToggles,
  reformat,
}: {
  wordDiff: Signal<boolean>;
  ignoreWhitespace: Signal<boolean>;
  // The word/whitespace toggles need two sides to compare; the reformat toggle
  // is just as useful on a single added minified file.
  showDiffToggles: boolean;
  reformat: ReformatControl | null;
}) {
  return (
    <div class="flex flex-wrap items-center gap-1.5" aria-label="Diff display options">
      {reformat ? (
        <DiffOptionToggle
          label="Reformat"
          description="Reformat minified code before diffing"
          checked={reformat.enabled}
          onChange={reformat.toggle}
        />
      ) : null}
      {showDiffToggles ? (
        <>
          <DiffOptionToggle
            label="Toggle word diff"
            description="Highlight changed words"
            checked={wordDiff.value}
            onChange={(next) => (wordDiff.value = next)}
          />
          <DiffOptionToggle
            label="Toggle whitespace"
            description="Ignore whitespace"
            checked={ignoreWhitespace.value}
            onChange={(next) => (ignoreWhitespace.value = next)}
          />
        </>
      ) : null}
    </div>
  );
}

function DiffOptionToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label class="cursor-pointer">
      <input
        type="checkbox"
        class="sr-only peer"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
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
  beforeText,
  afterText,
  binary,
  contentSkipped,
  sampleOmitted,
  beforeLabel,
  afterLabel,
  findings,
  beforeFindings,
  afterFindings,
  wordDiff,
  ignoreWhitespace,
}: {
  path: string;
  status: string;
  // Already reformatted when the reformat is on, so everything below — tokens,
  // line diff, scroll keys — works on the text the reviewer actually sees.
  beforeText: string;
  afterText: string;
  binary: boolean;
  contentSkipped: boolean;
  sampleOmitted: boolean;
  beforeLabel: string;
  afterLabel: string;
  // The unmapped findings, for the no-text-body messages that pin nothing.
  findings: DiffFinding[];
  beforeFindings: DiffFinding[];
  afterFindings: DiffFinding[];
  wordDiff: boolean;
  ignoreWhitespace: boolean;
}) {
  const lang = langForPath(path);
  const anyHighlightableSide =
    Boolean(beforeText && canHighlight(beforeText)) ||
    Boolean(afterText && canHighlight(afterText));
  if (lang && !binary && anyHighlightableSide) ensureHighlighter();
  const beforeTokens = useLineTokens(beforeText, lang);
  const afterTokens = useLineTokens(afterText, lang);

  if (binary) {
    return <DiffMessage findings={findings}>Binary file. No text diff available.</DiffMessage>;
  }

  if (contentSkipped) {
    return (
      <DiffMessage findings={findings}>
        File content was not retained. No text diff available.
      </DiffMessage>
    );
  }

  // Distinct from the cases above: the body was read and scanned, it just did
  // not fit the cached sample budget for this release pair. Say so, rather than
  // implying nothing was ever inspected.
  if (sampleOmitted && !beforeText && !afterText) {
    return (
      <DiffMessage findings={findings}>
        Text sample not cached for this file. This release pair exceeds the sample budget, which
        keeps changed files first.
      </DiffMessage>
    );
  }

  if (status === "added") {
    if (!afterText) {
      return <DiffMessage findings={findings}>No preview stored for this added file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        path={path}
        label={afterLabel}
        tone="added"
        text={afterText}
        tokens={afterTokens}
        findings={afterFindings}
        resetKey={initialScrollResetKey(path, status, "", afterText)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (status === "removed") {
    if (!beforeText) {
      return (
        <DiffMessage findings={findings}>No preview stored for this removed file.</DiffMessage>
      );
    }
    return (
      <SingleSidedView
        path={path}
        label={beforeLabel}
        tone="removed"
        text={beforeText}
        tokens={beforeTokens}
        findings={beforeFindings}
        resetKey={initialScrollResetKey(path, status, beforeText, "")}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (status === "unchanged") {
    if (!afterText && !beforeText) {
      return <DiffMessage findings={findings}>No preview stored for this file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        path={path}
        label={afterLabel || beforeLabel}
        tone="unchanged"
        text={afterText || beforeText}
        tokens={afterText ? afterTokens : beforeTokens}
        findings={afterText ? afterFindings : beforeFindings}
        resetKey={initialScrollResetKey(path, status, beforeText, afterText)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (!beforeText && !afterText) {
    return <DiffMessage findings={findings}>No text samples available to diff.</DiffMessage>;
  }
  if (!beforeText) {
    return (
      <SingleSidedView
        path={path}
        label={afterLabel}
        tone="added"
        text={afterText}
        tokens={afterTokens}
        findings={afterFindings}
        resetKey={initialScrollResetKey(path, status, "", afterText)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (!afterText) {
    return (
      <SingleSidedView
        path={path}
        label={beforeLabel}
        tone="removed"
        text={beforeText}
        tokens={beforeTokens}
        findings={beforeFindings}
        resetKey={initialScrollResetKey(path, status, beforeText, "")}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }

  return (
    <TwoSidedView
      path={path}
      status={status}
      beforeText={beforeText}
      afterText={afterText}
      beforeTokens={beforeTokens}
      afterTokens={afterTokens}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
      findings={afterFindings}
      wordDiff={wordDiff}
      ignoreWhitespace={ignoreWhitespace}
    />
  );
}

function TwoSidedView({
  path,
  status,
  beforeText,
  afterText,
  beforeTokens,
  afterTokens,
  beforeLabel,
  afterLabel,
  findings,
  wordDiff,
  ignoreWhitespace,
}: {
  path: string;
  status: string;
  beforeText: string;
  afterText: string;
  beforeTokens: TokenLine[] | null;
  afterTokens: TokenLine[] | null;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  wordDiff: boolean;
  ignoreWhitespace: boolean;
}) {
  // Line-diffing two large sides is too expensive to redo on every render.
  const { rows, paired } = useMemo(
    () =>
      buildRows(beforeText, afterText, beforeTokens, afterTokens, {
        wordDiff,
        ignoreWhitespace,
      }),
    [beforeText, afterText, beforeTokens, afterTokens, wordDiff, ignoreWhitespace],
  );
  if (!paired) {
    return (
      <WholeFileReplacementView
        path={path}
        status={status}
        beforeText={beforeText}
        afterText={afterText}
        beforeTokens={beforeTokens}
        afterTokens={afterTokens}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        findings={findings}
      />
    );
  }
  return (
    <PairedTwoSidedView
      path={path}
      status={status}
      beforeText={beforeText}
      afterText={afterText}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
      findings={findings}
      ignoreWhitespace={ignoreWhitespace}
      rows={rows}
    />
  );
}

// A timed-out Myers diff has no trustworthy pairing to render. Show the two
// source sides independently through the existing incremental renderer instead
// of manufacturing tens of thousands of "changed" rows in one DOM commit.
function WholeFileReplacementView({
  path,
  status,
  beforeText,
  afterText,
  beforeTokens,
  afterTokens,
  beforeLabel,
  afterLabel,
  findings,
}: {
  path: string;
  status: string;
  beforeText: string;
  afterText: string;
  beforeTokens: TokenLine[] | null;
  afterTokens: TokenLine[] | null;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
}) {
  return (
    <div class="flex flex-col gap-3">
      <Muted class="border border-border rounded-md bg-surface-2 px-3 py-2 text-[12px]">
        Line pairing timed out on this file, so each side is shown independently. Use the line
        expanders to review the complete samples without rendering every row at once.
      </Muted>
      <SingleSidedView
        path={path}
        label={beforeLabel}
        tone="removed"
        text={beforeText}
        tokens={beforeTokens}
        findings={[]}
        resetKey={initialScrollResetKey(`${path}:pairing-timeout:before`, status, beforeText, "")}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
      <SingleSidedView
        path={path}
        label={afterLabel}
        tone="added"
        text={afterText}
        tokens={afterTokens}
        findings={findings}
        resetKey={initialScrollResetKey(`${path}:pairing-timeout:after`, status, "", afterText)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    </div>
  );
}

function PairedTwoSidedView({
  path,
  status,
  beforeText,
  afterText,
  beforeLabel,
  afterLabel,
  findings,
  ignoreWhitespace,
  rows,
}: {
  path: string;
  status: string;
  beforeText: string;
  afterText: string;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  ignoreWhitespace: boolean;
  rows: Row[];
}) {
  // Partitioning, segment collapse, and overview markers are all O(rows);
  // memoized so scroll-adjacent rerenders never re-walk a 36k-row table.
  const { pinned, unpinned } = useMemo(() => {
    const presentLines = new Set<number>();
    for (const row of rows) if (row.afterLine !== null) presentLines.add(row.afterLine);
    return partitionFindingsByLine(findings, presentLines);
  }, [rows, findings]);
  // Gap keys embed the file identity and the whitespace mode (which reshapes
  // row indexes), so expansion state from a previously viewed file can never
  // apply to the wrong gap.
  // Known tradeoff: findings that arrive after first render add keepLines
  // anchors that reshape segments in place — a split gap re-keys its right
  // half (dropping its expansion) and revealed rows above the viewport shift
  // content without scroll compensation. Accepted because findings ship with
  // the diff payload in practice, and the alternative — keying the scroll
  // reset on findings — lost the reader's place entirely on every change.
  const gapKeyPrefix = [path, beforeText.length, afterText.length, ignoreWhitespace].join("\0");
  const expansions = useSignal<Record<string, number>>({});
  const expansionState = expansions.value;
  const segments = useMemo(
    () => buildDisplaySegments(rows, new Set(pinned.keys()), expansionState, gapKeyPrefix),
    [rows, pinned, expansionState, gapKeyPrefix],
  );
  const markers = useMemo(
    () => diffOverviewMarkers(displayOverviewRows(segments, rows), pinned),
    [segments, rows, pinned],
  );
  const expandGap = (key: string, count: number) => {
    expansions.value = {
      ...expansions.value,
      [key]: (expansions.value[key] ?? 0) + count,
    };
  };
  const scrollState = useSignal<DiffScrollState | null>(null);
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div class="bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex justify-between">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      {unpinned.length ? <AnnotationBanner findings={unpinned} /> : null}
      <div class="relative">
        <DiffScrollViewport
          resetKey={initialScrollResetKey(path, status, beforeText, afterText)}
          scrollState={scrollState}
          label={`Diff of ${path}`}
        >
          <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {segments.map((segment) => {
                if (segment.kind === "gap") {
                  return (
                    <GapRow
                      key={segment.key}
                      hiddenCount={segment.hiddenCount}
                      noun="unchanged lines"
                      colSpan={4}
                      step={GAP_EXPAND_STEP}
                      onExpand={(count) => expandGap(segment.key, count)}
                    />
                  );
                }
                const row = rows[segment.index];
                const pins = row.afterLine !== null ? pinned.get(row.afterLine) : undefined;
                return (
                  <Fragment key={segment.index}>
                    <DiffRow row={row} status={status} />
                    {pins ? (
                      <AnnotationRows
                        findings={pins}
                        colSpan={4}
                        scrollTarget={shouldSeekInitialDiffTarget(status)}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </DiffScrollViewport>
        <DiffOverview markers={markers} scrollState={scrollState} />
      </div>
    </div>
  );
}

// A collapsed run of rows, rendered as a full-width expander. "Show more"
// reveals `step` rows per edge so context grows around the changes above and
// below the gap; gaps up to GAP_SHOW_ALL_MAX also offer a one-click
// "show all" (larger gaps only step, so a bulk reveal can never rebuild the
// megabyte-scale render the collapse exists to avoid).
const GAP_BUTTON_CLASS =
  "cursor-pointer border-y border-border bg-surface-2 px-3 py-1 font-mono text-[11px] text-ink-subtle transition-colors hover:bg-accent-soft hover:text-ink";

function GapRow({
  hiddenCount,
  noun,
  colSpan,
  step,
  onExpand,
}: {
  hiddenCount: number;
  noun: string;
  colSpan: number;
  step: number;
  onExpand: (count: number) => void;
}) {
  return (
    <tr>
      <td colSpan={colSpan} class="p-0">
        <div class="flex">
          <button
            type="button"
            onClick={() => onExpand(step)}
            aria-label={`Show more of ${hiddenCount} hidden ${noun}`}
            class={cn(GAP_BUTTON_CLASS, "grow text-left")}
          >
            ⋯ {hiddenCount.toLocaleString()} {noun} · show more
          </button>
          {hiddenCount <= GAP_SHOW_ALL_MAX ? (
            <button
              type="button"
              onClick={(event) => {
                // The full reveal unmounts this row; park focus on the scroll
                // region first so keyboard users aren't dropped back to the
                // document body.
                event.currentTarget.closest<HTMLElement>("[role='region']")?.focus();
                onExpand(hiddenCount);
              }}
              aria-label={`Show all ${hiddenCount} hidden ${noun}`}
              class={cn(GAP_BUTTON_CLASS, "border-l")}
            >
              show all
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function DiffRow({ row, status }: { row: Row; status: string }) {
  const bg = row.tone === "added" ? "bg-ok-soft" : row.tone === "removed" ? "bg-danger-soft" : "";
  const sign = row.tone === "added" ? "+" : row.tone === "removed" ? "-" : " ";
  return (
    <tr
      class={cn(bg)}
      data-diff-scroll-target={isDiffScrollTarget(status, row.tone) ? "true" : undefined}
    >
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

// Every line of a single-sided view is "changed", so there is nothing to
// collapse; instead the table renders incrementally so a 36k-line added bundle
// doesn't build tens of thousands of rows in one pass.
const SINGLE_SIDED_INITIAL_LINES = 1000;
const SINGLE_SIDED_LINE_STEP = 1000;

function SingleSidedView({
  path,
  label,
  tone,
  text,
  tokens,
  findings,
  resetKey,
  seekFirstChange,
}: {
  path: string;
  label: string;
  tone: "added" | "removed" | "unchanged";
  text: string;
  tokens: TokenLine[] | null;
  findings: DiffFinding[];
  resetKey: string;
  seekFirstChange: boolean;
}) {
  const headerBg =
    tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "bg-surface-2";
  const rowBg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const lines = useMemo(() => splitLines(text), [text]);
  // The stored count only applies while its resetKey matches, so switching
  // files snaps back to the initial window without an effect.
  const visibleStore = useSignal({ key: resetKey, count: SINGLE_SIDED_INITIAL_LINES });
  const stored = visibleStore.value;
  const visibleCount = Math.min(
    lines.length,
    stored.key === resetKey ? stored.count : SINGLE_SIDED_INITIAL_LINES,
  );
  const visibleLines = useMemo(
    () => (visibleCount < lines.length ? lines.slice(0, visibleCount) : lines),
    [lines, visibleCount],
  );
  // Findings pinned past the rendered window fall back to the banner above the
  // diff (same as truncated samples), so capping rendering never hides one.
  const { pinned, unpinned } = useMemo(() => {
    const presentLines = new Set<number>(visibleLines.map((_, index) => index + 1));
    return partitionFindingsByLine(findings, presentLines);
  }, [visibleLines, findings]);
  const markers = useMemo(
    () =>
      diffOverviewMarkers(
        // Only rendered lines count toward the strip, plus one slot for the
        // trailing expander row, so the strip maps the scrollbar.
        [
          ...visibleLines.map((_, index) => ({ tone, line: index + 1 })),
          ...(visibleCount < lines.length ? [{ tone: "unchanged" as const, line: null }] : []),
        ],
        pinned,
      ),
    [visibleLines, visibleCount, lines, tone, pinned],
  );
  const scrollState = useSignal<DiffScrollState | null>(null);
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
      <div class="relative">
        <DiffScrollViewport
          resetKey={resetKey}
          scrollState={scrollState}
          label={`Contents of ${path} (${label})`}
        >
          <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {visibleLines.map((line, index) => {
                const pins = pinned.get(index + 1);
                return (
                  <Fragment key={index}>
                    <tr
                      class={cn(rowBg)}
                      data-diff-scroll-target={seekFirstChange ? "true" : undefined}
                    >
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
                    {pins ? (
                      <AnnotationRows findings={pins} colSpan={2} scrollTarget={seekFirstChange} />
                    ) : null}
                  </Fragment>
                );
              })}
              {visibleCount < lines.length ? (
                <GapRow
                  hiddenCount={lines.length - visibleCount}
                  noun="more lines"
                  colSpan={2}
                  step={SINGLE_SIDED_LINE_STEP}
                  onExpand={(count) =>
                    (visibleStore.value = {
                      key: resetKey,
                      count: visibleCount + count,
                    })
                  }
                />
              ) : null}
            </tbody>
          </table>
        </DiffScrollViewport>
        <DiffOverview markers={markers} scrollState={scrollState} />
      </div>
    </div>
  );
}

// them.

function formatSize(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
