/**
 * Regex matching over package text.
 *
 * File bodies are unbounded evidence — issue #191 removed the text-sample cap so
 * detection sees whole files — and a minified bundle is a single multi-megabyte
 * "line". A pattern whose cost is superlinear in the length of the string it is
 * handed therefore turns a published package into a CPU-exhaustion payload
 * against the *parent* Worker (the sandbox's `cpuMs` cap covers parsing, not the
 * rule pass), and that payload is reachable anonymously through /diff.
 *
 * Individual patterns are kept linear where they can be (see
 * `review/rules/patterns.ts`), but "every pattern anyone ever adds is linear" is
 * not an invariant a regex set can hold. So the bound is structural in these
 * helpers instead: no pattern is handed more than `SCAN_WINDOW_CHARS`, and long
 * inputs are scanned as a sliding window. Cost stays linear in input length
 * whatever shape a pattern has, and the worst a future quadratic pattern can do
 * is pay its quadratic cost against a fixed 8 KB window.
 *
 * Windows overlap by `SCAN_WINDOW_OVERLAP_CHARS` so ordinary matches that
 * straddle a seam are still found. Patterns that intentionally recognize a
 * larger payload must also expose a bounded prefix or suffix signal that fits in
 * the overlap; regex windowing cannot preserve an arbitrarily long match while
 * also bounding the input handed to the regex engine.
 */
const SCAN_WINDOW_CHARS = 8 * 1024;
const SCAN_WINDOW_OVERLAP_CHARS = 1024;
const SCAN_WINDOW_STRIDE = SCAN_WINDOW_CHARS - SCAN_WINDOW_OVERLAP_CHARS;

/**
 * Whether any pattern matches, scanning long input in bounded windows. Short
 * input (the overwhelming majority of lines) is tested directly, so the common
 * path costs no slicing.
 */
export function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  if (text.length <= SCAN_WINDOW_CHARS) return testAll(text, patterns);
  for (let offset = 0; offset < text.length; offset += SCAN_WINDOW_STRIDE) {
    if (testAll(text.slice(offset, offset + SCAN_WINDOW_CHARS), patterns)) return true;
  }
  return false;
}

function testAll(window: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(window)) return true;
  }
  return false;
}

/**
 * Index of the earliest match of any pattern, scanning in the same bounded
 * windows. A match near the right edge of one window can begin earlier than a
 * match that was already complete there, so keep scanning until subsequent
 * windows can no longer report an earlier start.
 */
function firstMatchIndex(text: string, patterns: RegExp[]): number | undefined {
  if (text.length <= SCAN_WINDOW_CHARS) return earliestIn(text, patterns, 0);
  let earliest: number | undefined;
  for (let offset = 0; offset < text.length; offset += SCAN_WINDOW_STRIDE) {
    const index = earliestIn(text.slice(offset, offset + SCAN_WINDOW_CHARS), patterns, offset);
    if (index !== undefined && (earliest === undefined || index < earliest)) earliest = index;
    if (earliest !== undefined && earliest < offset + SCAN_WINDOW_STRIDE) return earliest;
  }
  return earliest;
}

function earliestIn(window: string, patterns: RegExp[], offset: number): number | undefined {
  let earliest: number | undefined;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(window);
    if (match && (earliest === undefined || match.index < earliest)) earliest = match.index;
  }
  return earliest === undefined ? undefined : earliest + offset;
}

export function firstMatchingLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (matchesAnyPattern(lines[index], patterns)) return index + 1;
  }
  return undefined;
}

// Comment-only source lines, in both the JS (`//`, `/* … */`, leading `*` of a
// block continuation) and Python/shell (`#`) flavors. A line that merely *ends*
// in a comment still counts as code — only lines whose entire content is a
// comment are skipped.
const LINE_COMMENT_START = /^\s*(?:\/\/|#|\*(?!\/)|\/\*|\*\/)/;

/**
 * The line opens a block comment it does not also close.
 *
 * Written with `indexOf` rather than the regex it replaced
 * (`/\/\*(?![\s\S]*?\*\/)/`): that form rescans the rest of the line from every
 * `/*`, which is quadratic in line length and — since this runs on every line of
 * every file — was reachable from any published package. Checking only the last
 * `/*` is exactly equivalent: if the last opener is closed then every earlier
 * one is closed by that same closing marker, and if it is not, the line ends
 * inside a comment.
 */
function opensUnclosedBlockComment(line: string): boolean {
  const lastOpen = line.lastIndexOf("/*");
  return lastOpen !== -1 && line.indexOf("*/", lastOpen + 2) === -1;
}

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
  if (!text) return undefined;
  const lines = text.split("\n");
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const wasInBlockComment = inBlockComment;
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
    } else if (opensUnclosedBlockComment(line)) {
      inBlockComment = true;
    }
    if (wasInBlockComment || LINE_COMMENT_START.test(line)) continue;
    if (matchesAnyPattern(line, patterns)) return index + 1;
  }
  return undefined;
}

export function firstMatchingSourceLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const firstIndex = firstMatchIndex(text, patterns);
  if (firstIndex === undefined) return undefined;
  return text.slice(0, firstIndex).split("\n").length;
}
