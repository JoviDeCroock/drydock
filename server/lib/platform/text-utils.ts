export function firstMatchingLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}

// Comment-only source lines, in both the JS (`//`, `/* … */`, leading `*` of a
// block continuation) and Python/shell (`#`) flavors. A line that merely *ends*
// in a comment still counts as code — only lines whose entire content is a
// comment are skipped. Code after a block comment that closes on the same line
// is code: a minified bundle is one line behind a `/*! license */` banner.
const LINE_COMMENT_START = /^\s*(?:\/\/|#|\*(?!\/)|\/\*|\*\/)/;
const BLOCK_COMMENT_OPEN = /\/\*(?![\s\S]*?\*\/)/;
const BLOCK_COMMENT_CLOSE = /\*\//;
// Closed block comments (and the tail of one the previous line opened) at the
// start of a line; the `*/` search is a plain lazy scan, linear per line.
const LEADING_CLOSED_BLOCK_COMMENTS = /^(?:\s*\/\*[\s\S]*?\*\/)+/;

/**
 * `firstMatchingLine`, but blind to comment-only lines.
 *
 * The capability regexes match command *strings*, and a shell command quoted in
 * prose is documentation, not a capability: an SDK that writes
 * `// equivalent to: curl -X POST https://api…` is describing its own HTTP call,
 * not shelling out. Matching those raises a finding on a package that does
 * nothing, which is the expensive direction of a false positive.
 *
 * Line numbers still count comment lines, so a hit keeps pointing at the real
 * line in the original file.
 */
export function firstMatchingCodeLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  return firstMatchingAllowedCodeLine(text, patterns);
}

export function hasMatchingCodeLine(
  text: string | undefined | null,
  patterns: RegExp[],
  allowedLines: ReadonlySet<number>,
): boolean {
  return firstMatchingAllowedCodeLine(text, patterns, allowedLines) !== undefined;
}

function firstMatchingAllowedCodeLine(
  text: string | undefined | null,
  patterns: RegExp[],
  allowedLines?: ReadonlySet<number>,
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const wasInBlockComment = inBlockComment;
    if (inBlockComment) {
      if (BLOCK_COMMENT_CLOSE.test(raw)) inBlockComment = false;
    } else if (BLOCK_COMMENT_OPEN.test(raw)) {
      inBlockComment = true;
    }
    if (allowedLines && !allowedLines.has(index + 1)) continue;
    const close = wasInBlockComment ? raw.indexOf("*/") : -2;
    if (close === -1) continue;
    const line = (close >= 0 ? raw.slice(close + 2) : raw).replace(
      LEADING_CLOSED_BLOCK_COMMENTS,
      "",
    );
    if (!line.trim() || LINE_COMMENT_START.test(line)) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) return index + 1;
    }
  }
  return undefined;
}

export function firstMatchingSourceLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  let firstIndex: number | undefined;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && (firstIndex === undefined || match.index < firstIndex)) {
      firstIndex = match.index;
    }
  }
  if (firstIndex === undefined) return undefined;
  return text.slice(0, firstIndex).split("\n").length;
}

const UTF8_ENCODER = new TextEncoder();

export function utf8Size(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/**
 * Staged line numbers whose text occurs more often than in the previous
 * version: every copy of such a line, since nothing says which copy is new.
 * Linear time, where an LCS diff of one rewritten bundle takes seconds. A
 * moved line is not new text. Line endings are ignored, indentation is not
 * (Python reads it).
 */
export function addedLineNumbers(previous: string, staged: string): Set<number> {
  const key = (line: string) => line.replace(/\r$/, "");
  const counts = new Map<string, number>();
  for (const line of previous.split("\n")) counts.set(key(line), (counts.get(key(line)) ?? 0) + 1);
  const stagedLines = staged.split("\n").map(key);
  for (const line of stagedLines) counts.set(line, (counts.get(line) ?? 0) - 1);
  const added = new Set<number>();
  stagedLines.forEach((line, index) => {
    if ((counts.get(line) ?? 0) < 0) added.add(index + 1);
  });
  return added;
}
