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
// comment are skipped.
const LINE_COMMENT_START = /^\s*(?:\/\/|#|\*(?!\/)|\/\*|\*\/)/;
const BLOCK_COMMENT_OPEN = /\/\*(?![\s\S]*?\*\/)/;
const BLOCK_COMMENT_CLOSE = /\*\//;

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
      if (BLOCK_COMMENT_CLOSE.test(line)) inBlockComment = false;
    } else if (BLOCK_COMMENT_OPEN.test(line)) {
      inBlockComment = true;
    }
    if (wasInBlockComment || LINE_COMMENT_START.test(line)) continue;
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
