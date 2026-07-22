import { diffArrays, diffLines, diffWordsWithSpace, type ChangeObject } from "diff";
import { Fragment, type ComponentChildren } from "preact";
import { useSignal, type Signal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { Badge, severityTone, statusTone } from "./Badge";
import {
  annotationLabel,
  partitionFindingsByLine,
  severityGroup,
  type DiffFinding,
  type SeverityGroup,
} from "./diff-annotations";
import { buildDisplaySegments, GAP_EXPAND_STEP, GAP_SHOW_ALL_MAX } from "./diff-hunks";
import { diffOverviewMarkers, displayOverviewRows, type DiffOverviewMarker } from "./diff-overview";
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

const INITIAL_SCROLL_TARGET_SELECTOR = "[data-diff-scroll-target='true']";
const INITIAL_SCROLL_PADDING = 8;

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
  if (options.wordDiff) applyWordDiff(chunks);
  return chunks.flatMap((chunk) => chunk.rows);
}

export function shouldSeekInitialDiffTarget(status: string): boolean {
  return status === "added" || status === "removed" || status === "modified";
}

export function isDiffScrollTarget(
  status: string,
  tone: "added" | "removed" | "unchanged",
): boolean {
  return shouldSeekInitialDiffTarget(status) && tone !== "unchanged";
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

// pairChangedRows scores every removed×added line pair with a word diff, so a
// single huge changed block (common in bundled artifacts) turns quadratic.
// Beyond this cell budget the word-diff decoration is skipped for that block;
// line tones still render.
const WORD_DIFF_MAX_PAIR_CELLS = 10_000;

function applyWordDiff(chunks: RowChunk[]) {
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const removed = chunks[index];
    const added = chunks[index + 1];
    if (removed.tone !== "removed" || added.tone !== "added") continue;
    if (removed.rows.length * added.rows.length > WORD_DIFF_MAX_PAIR_CELLS) continue;
    for (const [beforeRow, afterRow] of pairChangedRows(removed.rows, added.rows)) {
      const parts = buildWordParts(beforeRow.text, afterRow.text);
      beforeRow.wordParts = parts.before;
      afterRow.wordParts = parts.after;
    }
  }
}

function pairChangedRows(beforeRows: Row[], afterRows: Row[]): [Row, Row][] {
  const scores = beforeRows.map((beforeRow) =>
    afterRows.map((afterRow) => rowPairScore(beforeRow.text, afterRow.text)),
  );
  const dp = Array.from({ length: beforeRows.length + 1 }, () =>
    Array.from({ length: afterRows.length + 1 }, () => 0),
  );
  const choices: ("match" | "before" | "after")[][] = Array.from(
    { length: beforeRows.length + 1 },
    () => Array.from({ length: afterRows.length + 1 }, () => "before"),
  );

  for (let beforeIndex = 1; beforeIndex <= beforeRows.length; beforeIndex += 1) {
    for (let afterIndex = 1; afterIndex <= afterRows.length; afterIndex += 1) {
      const score = scores[beforeIndex - 1][afterIndex - 1];
      const match = score > 0 ? dp[beforeIndex - 1][afterIndex - 1] + score : -Infinity;
      const skipBefore = dp[beforeIndex - 1][afterIndex];
      const skipAfter = dp[beforeIndex][afterIndex - 1];
      if (match > skipBefore && match > skipAfter) {
        dp[beforeIndex][afterIndex] = match;
        choices[beforeIndex][afterIndex] = "match";
      } else if (skipBefore >= skipAfter) {
        dp[beforeIndex][afterIndex] = skipBefore;
        choices[beforeIndex][afterIndex] = "before";
      } else {
        dp[beforeIndex][afterIndex] = skipAfter;
        choices[beforeIndex][afterIndex] = "after";
      }
    }
  }

  const pairs: [Row, Row][] = [];
  let beforeIndex = beforeRows.length;
  let afterIndex = afterRows.length;
  while (beforeIndex > 0 && afterIndex > 0) {
    const choice = choices[beforeIndex][afterIndex];
    if (choice === "match") {
      pairs.push([beforeRows[beforeIndex - 1], afterRows[afterIndex - 1]]);
      beforeIndex -= 1;
      afterIndex -= 1;
    } else if (choice === "before") {
      beforeIndex -= 1;
    } else {
      afterIndex -= 1;
    }
  }
  return pairs.reverse();
}

const linePairScoreFloor = 0.08;

function rowPairScore(before: string, after: string): number {
  if (!compatibleLineKinds(before, after)) return 0;
  const beforeText = before.trim();
  const afterText = after.trim();
  if (!beforeText || !afterText) return 0;

  let unchangedLength = 0;
  for (const part of diffWordsWithSpace(beforeText, afterText) as ChangeObject<string>[]) {
    if (!part.added && !part.removed) unchangedLength += part.value.length;
  }
  const score = unchangedLength / Math.max(beforeText.length, afterText.length);
  return score >= linePairScoreFloor ? score : 0;
}

function compatibleLineKinds(before: string, after: string): boolean {
  return lineKind(before) === lineKind(after);
}

function lineKind(text: string): "blank" | "comment" | "code" {
  const trimmed = text.trim();
  if (!trimmed) return "blank";
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#")
  ) {
    return "comment";
  }
  return "code";
}

function buildWordParts(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const beforeParts: WordPart[] = [];
  const afterParts: WordPart[] = [];
  for (const part of diffWordsWithSpace(before, after) as ChangeObject<string>[]) {
    const tone = partTone(part);
    if (!part.added) appendWordParts(beforeParts, part.value, tone);
    if (!part.removed) appendWordParts(afterParts, part.value, tone);
  }
  return { before: beforeParts, after: afterParts };
}

const wordDiffWordPattern = /[\p{L}\p{N}_$]+/gu;

function appendWordParts(parts: WordPart[], text: string, tone: WordPart["tone"]) {
  if (tone === "unchanged") {
    appendWordPart(parts, text, tone);
    return;
  }
  let offset = 0;
  for (const match of text.matchAll(wordDiffWordPattern)) {
    const index = match.index;
    if (index > offset) appendWordPart(parts, text.slice(offset, index), "unchanged");
    appendWordPart(parts, match[0], tone);
    offset = index + match[0].length;
  }
  if (offset < text.length) appendWordPart(parts, text.slice(offset), "unchanged");
}

function appendWordPart(parts: WordPart[], text: string, tone: WordPart["tone"]) {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous?.tone === tone) {
    previous.text += text;
    return;
  }
  parts.push({ text, tone });
}

function partTone(part: ChangeObject<string>): WordPart["tone"] {
  if (part.added) return "added";
  if (part.removed) return "removed";
  return "unchanged";
}

// Tokenize an entire side once, memoized on the sample/language/ready signal.
// Sides beyond the highlight cap stay plain text: tokenizing them would block
// the main thread for seconds (see HIGHLIGHT_MAX_LINES).
function useLineTokens(text: string, lang: string | undefined): TokenLine[] | null {
  const ready = highlighterReady.value;
  return useMemo(
    () => (lang && ready && text && canHighlight(text) ? tokenizeLines(text, lang) : null),
    [text, lang, ready],
  );
}

// Keyed on the file identity and content only — deliberately not on findings.
// Findings arriving after the diff is on screen must not yank the scroll back
// to the first change (or reset the single-sided render window) mid-read.
// Exported for tests.
export function initialScrollResetKey(
  path: string,
  status: string,
  beforeSample: string,
  afterSample: string,
): string {
  return [
    path,
    status,
    beforeSample.length,
    afterSample.length,
    beforeSample.slice(0, 64),
    afterSample.slice(0, 64),
  ].join("\0");
}

// Scroll geometry mirrored into a signal so the overview thumb can track the
// viewport without rerendering the diff table on every scroll frame.
interface DiffScrollState {
  top: number;
  viewport: number;
  content: number;
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
    // keyboard, making the 560px pane unscrollable without a mouse. The focus
    // ring is inset because the border shell clips an outer halo;
    // overscroll-contain keeps wheel momentum at the pane's edges from
    // scrolling the page underneath.
    <div
      ref={ref}
      onScroll={syncScrollState}
      tabIndex={0}
      role="region"
      aria-label={label}
      class="overflow-auto h-full pr-5 [overflow-anchor:none] overscroll-contain outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--color-accent-soft)]"
    >
      {children}
    </div>
  );
}

function resetDiffScroll(container: HTMLElement) {
  const target = container.querySelector<HTMLElement>(INITIAL_SCROLL_TARGET_SELECTOR);
  if (!target) {
    container.scrollTop = 0;
    return;
  }
  const targetTop =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTop = Math.max(0, targetTop - INITIAL_SCROLL_PADDING);
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
  const native = nativeBadge(after) ?? nativeBadge(before);
  const showDiffOptions = !binary && !contentSkipped && Boolean(beforeSample && afterSample);
  const hashLines = diffHashLines(before, after, beforeLabel, afterLabel);
  const highlightCapped =
    !binary &&
    !contentSkipped &&
    Boolean(langForPath(path)) &&
    (!canHighlight(beforeSample) || !canHighlight(afterSample));

  return (
    <div class="flex flex-col gap-3 min-h-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(status)}>{status}</Badge>
          <code class="font-mono text-xs text-ink-muted break-all">{path}</code>
          {truncated ? <Badge tone="neutral">truncated</Badge> : null}
          {binary ? <Badge tone="neutral">binary</Badge> : null}
          {contentSkipped ? <Badge tone="neutral">content skipped</Badge> : null}
          {native ? <Badge tone="neutral">{native}</Badge> : null}
        </div>
        {showDiffOptions ? (
          <DiffControls wordDiff={wordDiff} ignoreWhitespace={ignoreWhitespace} />
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
        beforeSample={beforeSample}
        afterSample={afterSample}
        binary={binary}
        contentSkipped={contentSkipped}
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
        checked={checked}
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
  contentSkipped,
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
  contentSkipped: boolean;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  wordDiff: boolean;
  ignoreWhitespace: boolean;
}) {
  const lang = langForPath(path);
  const anyHighlightableSide =
    Boolean(beforeSample && canHighlight(beforeSample)) ||
    Boolean(afterSample && canHighlight(afterSample));
  if (lang && !binary && anyHighlightableSide) ensureHighlighter();
  const beforeTokens = useLineTokens(beforeSample, lang);
  const afterTokens = useLineTokens(afterSample, lang);

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

  if (status === "added") {
    if (!afterSample) {
      return <DiffMessage findings={findings}>No preview stored for this added file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        path={path}
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
        resetKey={initialScrollResetKey(path, status, "", afterSample)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
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
        path={path}
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
        resetKey={initialScrollResetKey(path, status, beforeSample, "")}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (status === "unchanged") {
    if (!afterSample && !beforeSample) {
      return <DiffMessage findings={findings}>No preview stored for this file.</DiffMessage>;
    }
    return (
      <SingleSidedView
        path={path}
        label={afterLabel || beforeLabel}
        tone="unchanged"
        text={afterSample || beforeSample}
        tokens={afterSample ? afterTokens : beforeTokens}
        findings={findings}
        resetKey={initialScrollResetKey(path, status, beforeSample, afterSample)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (!beforeSample && !afterSample) {
    return <DiffMessage findings={findings}>No text samples available to diff.</DiffMessage>;
  }
  if (!beforeSample) {
    return (
      <SingleSidedView
        path={path}
        label={afterLabel}
        tone="added"
        text={afterSample}
        tokens={afterTokens}
        findings={findings}
        resetKey={initialScrollResetKey(path, status, "", afterSample)}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }
  if (!afterSample) {
    return (
      <SingleSidedView
        path={path}
        label={beforeLabel}
        tone="removed"
        text={beforeSample}
        tokens={beforeTokens}
        findings={findings}
        resetKey={initialScrollResetKey(path, status, beforeSample, "")}
        seekFirstChange={shouldSeekInitialDiffTarget(status)}
      />
    );
  }

  return (
    <TwoSidedView
      path={path}
      status={status}
      beforeSample={beforeSample}
      afterSample={afterSample}
      beforeTokens={beforeTokens}
      afterTokens={afterTokens}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
      findings={findings}
      wordDiff={wordDiff}
      ignoreWhitespace={ignoreWhitespace}
    />
  );
}

function TwoSidedView({
  path,
  status,
  beforeSample,
  afterSample,
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
  beforeSample: string;
  afterSample: string;
  beforeTokens: TokenLine[] | null;
  afterTokens: TokenLine[] | null;
  beforeLabel: string;
  afterLabel: string;
  findings: DiffFinding[];
  wordDiff: boolean;
  ignoreWhitespace: boolean;
}) {
  // Line-diffing two large sides is too expensive to redo on every render.
  const rows = useMemo(
    () =>
      buildRows(beforeSample, afterSample, beforeTokens, afterTokens, {
        wordDiff,
        ignoreWhitespace,
      }),
    [beforeSample, afterSample, beforeTokens, afterTokens, wordDiff, ignoreWhitespace],
  );
  const presentLines = new Set<number>();
  for (const row of rows) if (row.afterLine !== null) presentLines.add(row.afterLine);
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
  // Gap keys embed the file identity and the whitespace mode (which reshapes
  // row indexes), so expansion state from a previously viewed file can never
  // apply to the wrong gap.
  const gapKeyPrefix = [path, beforeSample.length, afterSample.length, ignoreWhitespace].join("\0");
  const expansions = useSignal<Record<string, number>>({});
  const segments = buildDisplaySegments(
    rows,
    new Set(pinned.keys()),
    expansions.value,
    gapKeyPrefix,
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
      <div class="relative h-[560px]">
        <DiffScrollViewport
          resetKey={initialScrollResetKey(path, status, beforeSample, afterSample)}
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
        <DiffOverview
          markers={diffOverviewMarkers(displayOverviewRows(segments, rows), pinned)}
          scrollState={scrollState}
        />
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
              onClick={() => onExpand(hiddenCount)}
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
  const visibleLines = visibleCount < lines.length ? lines.slice(0, visibleCount) : lines;
  // Findings pinned past the rendered window fall back to the banner above the
  // diff (same as truncated samples), so capping rendering never hides one.
  const presentLines = new Set<number>(visibleLines.map((_, index) => index + 1));
  const { pinned, unpinned } = partitionFindingsByLine(findings, presentLines);
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
      <div class="relative h-[560px]">
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
        <DiffOverview
          markers={diffOverviewMarkers(
            // Only rendered lines count toward the strip, plus one slot for
            // the trailing expander row, so the strip maps the scrollbar.
            [
              ...visibleLines.map((_, index) => ({ tone, line: index + 1 })),
              ...(visibleCount < lines.length ? [{ tone: "unchanged" as const, line: null }] : []),
            ],
            pinned,
          )}
          scrollState={scrollState}
        />
      </div>
    </div>
  );
}

function DiffOverview({
  markers,
  scrollState,
}: {
  markers: DiffOverviewMarker[];
  scrollState: Signal<DiffScrollState | null>;
}) {
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
      <DiffOverviewThumb scrollState={scrollState} />
    </div>
  );
}

// The viewport's position over the strip, in the same neutral ink used for
// structure (never a severity hue — color = signal). Reads the scroll signal
// in its own component so scrolling rerenders only this span, never the diff
// table.
function DiffOverviewThumb({ scrollState }: { scrollState: Signal<DiffScrollState | null> }) {
  const state = scrollState.value;
  if (!state || state.content <= state.viewport) return null;
  return (
    <span
      class="absolute left-[-1px] right-[-1px] z-20 rounded-full bg-ink/15"
      style={{
        top: `${(state.top / state.content) * 100}%`,
        height: `${(state.viewport / state.content) * 100}%`,
      }}
    />
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
function AnnotationRows({
  findings,
  colSpan,
  scrollTarget = false,
}: {
  findings: DiffFinding[];
  colSpan: number;
  scrollTarget?: boolean;
}) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id} data-diff-scroll-target={scrollTarget ? "true" : undefined}>
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
