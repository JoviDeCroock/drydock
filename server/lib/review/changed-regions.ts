import { diffChars, diffLines } from "diff";

// Where a modified file changed, for release-delta classification.
//
// Ordinary source changes line by line, and a changed line is the natural
// unit. Minified bundles are the exception: the whole bundle is one or a few
// lines, so a 19-byte version-string edit makes the line "changed" and every
// capability anywhere in it reads as new in this release. A long changed line
// is therefore narrowed to the character ranges that actually changed, and a
// rule counts as touched only when one of its matches sits within a margin of
// such a range. When narrowing would be too expensive, the whole line stays
// changed, which is the line-level behaviour: the fallback can only keep a
// finding in the release, never drop one.

interface ChangedSpan {
  start: number;
  end: number;
}

export interface ChangedRegions {
  /** Staged line numbers (1-based) changed as whole lines. */
  lines: Set<number>;
  /** Long staged lines whose change was narrowed to `spans`. */
  refinedLines: Set<number>;
  /** Staged character ranges that changed inside `refinedLines`. */
  spans: ChangedSpan[];
}

// Longer than any hand-written source line; short of every minified bundle.
const LONG_LINE_CHARS = 1024;
// A rule match this close to a changed range counts as touched: a call whose
// argument (a URL, a command) changed keeps the unchanged callee within reach.
export const CHANGED_SPAN_MARGIN = 256;
// After trimming the common prefix and suffix, a middle this small is one span.
const SINGLE_SPAN_CHARS = 4096;
// Character-level diffing of a larger middle is bounded in size and edits;
// past either bound the whole middle is one span.
const REFINE_MAX_CHARS = 256 * 1024;
const REFINE_MAX_EDITS = 64;

export function changedRegions(previous: string, staged: string): ChangedRegions {
  const regions: ChangedRegions = { lines: new Set(), refinedLines: new Set(), spans: [] };
  const parts = diffLines(previous, staged);
  let stagedOffset = 0;
  let stagedLine = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.removed) continue;
    const partLines = lineOffsets(part.value);
    if (!part.added) {
      stagedOffset += part.value.length;
      stagedLine += partLines.length;
      continue;
    }
    // jsdiff emits a replacement as the removed part immediately before the
    // added one. Only a single long replaced line is narrowed.
    const removed = index > 0 && parts[index - 1].removed ? parts[index - 1].value : null;
    const [only] = partLines;
    if (removed !== null && partLines.length === 1 && only.length > LONG_LINE_CHARS) {
      stagedLine += 1;
      regions.refinedLines.add(stagedLine);
      const lineText = part.value.slice(0, only.length);
      for (const span of narrowedSpans(stripTrailingNewline(removed), lineText)) {
        regions.spans.push({ start: stagedOffset + span.start, end: stagedOffset + span.end });
      }
    } else {
      for (const _line of partLines) {
        stagedLine += 1;
        regions.lines.add(stagedLine);
      }
    }
    stagedOffset += part.value.length;
  }
  return regions;
}

// Whether any pattern matches on a changed line, or within the margin of a
// changed span. Patterns are tested against the given text, which must be the
// text `regions` was computed from.
export function patternsTouchChangedRegions(
  text: string,
  regions: ChangedRegions,
  patterns: RegExp[],
): boolean {
  if (!patterns.length) return false;
  if (regions.lines.size) {
    const lines = splitLines(text, regions);
    for (const lineNumber of regions.lines) {
      const line = lines[lineNumber - 1];
      if (line !== undefined && anyMatch(patterns, line)) return true;
    }
  }
  for (const span of regions.spans) {
    const window = text.slice(
      Math.max(0, span.start - CHANGED_SPAN_MARGIN),
      Math.min(text.length, span.end + CHANGED_SPAN_MARGIN),
    );
    if (anyMatch(patterns, window)) return true;
  }
  return false;
}

// The text within reach of every changed line and span, for callers that
// look for literals (hosts) rather than rule patterns.
export function changedRegionTexts(text: string, regions: ChangedRegions): string[] {
  const texts: string[] = [];
  if (regions.lines.size) {
    const lines = splitLines(text, regions);
    for (const lineNumber of regions.lines) {
      const line = lines[lineNumber - 1];
      if (line !== undefined) texts.push(line);
    }
  }
  for (const span of regions.spans) {
    texts.push(
      text.slice(
        Math.max(0, span.start - CHANGED_SPAN_MARGIN),
        Math.min(text.length, span.end + CHANGED_SPAN_MARGIN),
      ),
    );
  }
  return texts;
}

// Classification tests many rules and patterns against the same file; split
// its text once per regions object (each belongs to exactly one text).
const splitCache = new WeakMap<ChangedRegions, string[]>();

function splitLines(text: string, regions: ChangedRegions): string[] {
  let lines = splitCache.get(regions);
  if (!lines) {
    lines = text.split("\n");
    splitCache.set(regions, lines);
  }
  return lines;
}

function anyMatch(patterns: RegExp[], text: string): boolean {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

// Lengths of the lines in a diff part, without their newlines. A trailing
// newline does not start another line.
function lineOffsets(value: string): Array<{ length: number }> {
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => ({ length: line.length }));
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

// Character ranges of `next` that differ from `previous`, relative to `next`.
// A pure deletion is a zero-width range at the deletion point, so a removed
// guard still puts the code around it within reach.
function narrowedSpans(previous: string, next: string): ChangedSpan[] {
  const shorter = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shorter && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const middle = { start: prefix, end: next.length - suffix };
  const previousMiddle = previous.slice(prefix, previous.length - suffix);
  const nextMiddle = next.slice(middle.start, middle.end);
  if (
    nextMiddle.length <= SINGLE_SPAN_CHARS ||
    nextMiddle.length > REFINE_MAX_CHARS ||
    previousMiddle.length > REFINE_MAX_CHARS
  ) {
    return [middle];
  }
  const changes = diffChars(previousMiddle, nextMiddle, { maxEditLength: REFINE_MAX_EDITS });
  if (!changes) return [middle];
  const spans: ChangedSpan[] = [];
  let offset = middle.start;
  for (const change of changes) {
    if (change.added) {
      spans.push({ start: offset, end: offset + change.value.length });
      offset += change.value.length;
    } else if (change.removed) {
      spans.push({ start: offset, end: offset });
    } else {
      offset += change.value.length;
    }
  }
  return spans;
}
