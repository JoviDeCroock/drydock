/**
 * The pure side-by-side row model behind DiffView.
 *
 * Everything here is deliberately DOM-free: given two text samples it decides
 * which lines pair up, which are added/removed, and which word spans inside a
 * paired line actually changed. Keeping it separate from the components lets
 * the pairing heuristics — the part with real budgets and give-up paths — be
 * tested directly, without rendering.
 */
import { diffArrays, diffLines, diffWordsWithSpace, type ChangeObject } from "diff";
import { type TokenLine } from "./highlight";

export interface Row {
  tone: "added" | "removed" | "unchanged";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
  tokens: TokenLine | null;
  wordParts: WordPart[] | null;
}

export interface WordPart {
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
  // Line-pairing budget, defaulting to LINE_DIFF_TIMEOUT_MS. Only tests pass it,
  // so the give-up path below is reachable without staging a four-second diff.
  timeoutMs?: number;
}

export interface DiffRows {
  rows: Row[];
  // False when line pairing was abandoned. The caller renders each source side
  // independently and incrementally instead of manufacturing changed rows.
  paired: boolean;
}

export function buildRows(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
  options: DiffOptions = {},
): DiffRows {
  const timeoutMs = options.timeoutMs ?? LINE_DIFF_TIMEOUT_MS;
  const result = options.ignoreWhitespace
    ? buildRowsIgnoringWhitespace(before, after, beforeTokens, afterTokens, timeoutMs)
    : buildRowsFromLineDiff(before, after, beforeTokens, afterTokens, timeoutMs);
  if (options.wordDiff) applyWordDiff(result.chunks);
  return { rows: result.chunks.flatMap((chunk) => chunk.rows), paired: result.paired };
}

interface DiffChunks {
  chunks: RowChunk[];
  paired: boolean;
}

// Myers diff is O(N·D), and reformatting a minified bundle turns a 1×1 line
// comparison into a several-thousand-line one. Two rebuilds of the same source
// keep D small and finish in tens of milliseconds; two *unrelated* bundles at
// the 128 KiB sample cap take about four seconds of blocked main thread. This
// bound keeps that case from freezing the tab, and `paired: false` tells the
// reader the rows below are a whole-file replacement rather than a real pairing.
const LINE_DIFF_TIMEOUT_MS = 1500;

function buildRowsFromLineDiff(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
  timeoutMs: number,
): DiffChunks {
  const parts = diffLines(before, after, { timeout: timeoutMs });
  if (!parts) {
    return { chunks: [], paired: false };
  }
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
  return { chunks, paired: true };
}

function buildRowsIgnoringWhitespace(
  before: string,
  after: string,
  beforeTokens: TokenLine[] | null,
  afterTokens: TokenLine[] | null,
  timeoutMs: number,
): DiffChunks {
  const parts = diffArrays(splitLines(before), splitLines(after), {
    comparator: linesEqualIgnoringWhitespace,
    timeout: timeoutMs,
  });
  if (!parts) {
    return { chunks: [], paired: false };
  }
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
  return { chunks, paired: true };
}

export function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  // Strip the CR of CRLF endings: shiki's tokenizer drops it, so a CRLF file
  // would otherwise render differently plain vs highlighted (a stray \r is a
  // segment break under whitespace-pre-wrap in some engines). Diffing still
  // runs on the raw samples, so both sides stay consistent.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.endsWith("\r")) lines[index] = line.slice(0, -1);
  }
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
