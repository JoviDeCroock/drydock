// Re-flow minified sources so the diff view has something to diff.
//
// A minified bundle is one line. `diffLines` therefore reports exactly one
// removed line and one added line for any change at all — a comma tweak and a
// swapped-in credential exfiltrator render identically, as two 300 KiB rows.
// That is the single worst review surface in the product, and it is the shape
// most `dist/` npm artifacts ship in.
//
// This module inserts line breaks at statement and block boundaries so the
// existing line diff, hunk collapse, and finding pinning all start working on
// bundled artifacts. Three properties keep it honest on hostile bytes:
//
//   1. It only ever *inserts* whitespace between tokens (and drops redundant
//      horizontal whitespace at those same points). No token is rewritten,
//      reordered, or dropped, so the reformatted view can never show the
//      reviewer something the artifact does not contain. `test/format-source`
//      asserts the token stream round-trips.
//   2. Breaks land only after `;`, `{`, `,` and around `}` — positions where a
//      newline can never change how the engine parses the program (none of them
//      is an automatic-semicolon-insertion site), so the reformatted text stays
//      semantically the source it came from.
//   3. It never parses, evaluates, or executes anything: the JS side is a pure
//      lexer walk (`server/lib/platform/js-lexer.ts`), the CSS side a character
//      scanner.
//
// Every output line records the source line it came from, so deterministic
// findings stay pinned to real evidence (`remapFindingLines`).

import { jsTokenText, tokenizeJs, type JsToken } from "../../server/lib/platform/js-lexer";

export type FormatLanguage = "js" | "css";

export interface FormattedSource {
  text: string;
  // 1-based source line for each output line: `sourceLines[i]` is the line of
  // the original sample that output line `i + 1` was taken from. Many output
  // lines share a source line — that is the whole point for a one-line bundle.
  sourceLines: number[];
}

// Samples are capped at 128 KiB upstream (SCAN_FILE_SAMPLE_LIMIT); this is the
// safety valve for anything that arrives larger, since formatting multiplies the
// line count the line diff downstream has to pair up.
export const FORMAT_MAX_CHARS = 256 * 1024;

// A line this long is not something a human wrote. Real sources wrap well before
// it; bundlers and minifiers routinely emit a single line of hundreds of KiB.
const MINIFIED_LINE_CHARS = 500;

const INDENT_UNIT = "  ";
// Minified code nests deeply and the diff pane is narrow, so past this depth the
// indent stops growing rather than pushing every line off the right edge.
const MAX_INDENT_DEPTH = 24;

// Shiki language ids (`langForPath`) we know how to re-flow. Everything else —
// markdown, yaml, python, toml — either does not minify or carries meaning in
// its own line structure, so it is left exactly as shipped.
const JS_LANGS = new Set(["javascript", "jsx", "typescript", "tsx", "json"]);
const CSS_LANGS = new Set(["css", "scss"]);

export function formatLanguageFor(lang: string | undefined): FormatLanguage | null {
  if (!lang) return null;
  if (JS_LANGS.has(lang)) return "js";
  if (CSS_LANGS.has(lang)) return "css";
  return null;
}

export function looksMinified(text: string): boolean {
  if (text.length < MINIFIED_LINE_CHARS) return false;
  let lineStart = 0;
  for (;;) {
    const next = text.indexOf("\n", lineStart);
    const end = next === -1 ? text.length : next;
    if (end - lineStart >= MINIFIED_LINE_CHARS) return true;
    if (next === -1) return false;
    lineStart = next + 1;
  }
}

/**
 * Returns the reformatted sample, or null when there is nothing to gain (the
 * source is too large to re-flow, or it already breaks at every point we would).
 * A null result means callers should keep rendering the original bytes.
 */
export function formatSource(text: string, language: FormatLanguage): FormattedSource | null {
  if (!text || text.length > FORMAT_MAX_CHARS) return null;
  const breaks = language === "css" ? cssBreaks(text) : jsBreaks(text);
  if (!breaks.length) return null;
  return applyBreaks(text, breaks);
}

/**
 * Re-point findings from source line numbers onto the reformatted view's line
 * numbers, keeping the original line in `sourceLine` so the annotation caption
 * keeps naming the line that exists in the artifact.
 *
 * A finding lands on the *first* output line carved out of its source line, and
 * never on a row belonging to any other line. Findings carry no column, so a rule
 * that matched halfway through a minified bundle cannot be pinned tighter than
 * the top of its source line — but that is exactly as tight as the unformatted
 * view, which pins it to the top of the file.
 *
 * A line that does not exist on this side — the rules ran on the scan's 128 KiB
 * sample while this surface cached a shorter one — is unpinned outright rather
 * than left pointing at a raw line number. Reformatting multiplies the row count,
 * so a stale line that correctly fell off the end of the unformatted view would
 * otherwise start landing on an unrelated row.
 */
export function remapFindingLines<T extends { line?: number | null; sourceLine?: number | null }>(
  findings: T[],
  formatted: FormattedSource | null,
): T[] {
  if (!formatted) return findings;
  const firstOutputLine = new Map<number, number>();
  const { sourceLines } = formatted;
  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    firstOutputLine.set(sourceLines[index], index + 1);
  }
  return findings.map((finding) => {
    if (typeof finding.line !== "number") return finding;
    const mapped = firstOutputLine.get(finding.line);
    if (mapped === undefined) return { ...finding, line: null, sourceLine: finding.line };
    if (mapped === finding.line) return finding;
    return { ...finding, line: mapped, sourceLine: finding.line };
  });
}

interface SourceBreak {
  // Offset of the token the break is inserted in front of.
  at: number;
  // End of the preceding token: everything between it and `at` is whitespace,
  // and is dropped in favour of the inserted newline + indent.
  gapStart: number;
  indent: number;
}

function applyBreaks(src: string, breaks: SourceBreak[]): FormattedSource {
  let out = "";
  let sourceLine = 1;
  const sourceLines: number[] = [1];
  let pos = 0;

  const emit = (chunk: string): void => {
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] === "\n") {
        sourceLine += 1;
        sourceLines.push(sourceLine);
      }
    }
    out += chunk;
  };

  for (const item of breaks) {
    // Clamp so overlapping breaks can only drop whitespace, never source text.
    emit(src.slice(pos, Math.max(pos, item.gapStart)));
    out += `\n${INDENT_UNIT.repeat(Math.min(item.indent, MAX_INDENT_DEPTH))}`;
    // The dropped gap is horizontal whitespace only (`pushBreak` refuses to
    // break across an existing newline), so the source line counter is unmoved.
    sourceLines.push(sourceLine);
    pos = item.at;
  }
  emit(src.slice(pos));

  return { text: out, sourceLines };
}

// Keywords that continue the statement a `}` just closed, so the block's closing
// brace and what follows stay on one line (`}else{`, `}catch(e){`).
const BLOCK_CONTINUATION_KEYWORDS = new Set(["else", "catch", "finally", "while"]);

function jsBreaks(src: string): SourceBreak[] {
  // Comments stay in the significant stream: they are content a reviewer reads,
  // and keeping them means the gap between two consecutive entries is always
  // pure whitespace.
  const tokens = tokenizeJs(src).filter((token) => token.type !== "ws");
  const breaks: SourceBreak[] = [];
  // Open brackets, innermost last. `;` inside `(` is a `for(;;)` separator, and
  // `,` only earns a line of its own inside an object literal or block.
  const stack: string[] = [];

  const push = (at: number, gapStart: number): void => {
    pushBreak(src, breaks, { at, gapStart, indent: stack.length });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const text = token.type === "punct" ? jsTokenText(src, token) : "";

    if (text === "}" || text === "]" || text === ")") stack.pop();

    const previous = tokens[index - 1];
    if (text === "}" && previous && !isPunctText(src, previous, "{")) {
      push(token.start, previous.end);
    }

    if (text === "{" || text === "[" || text === "(") stack.push(text);

    if (!next) continue;
    if (breaksAfter(src, text, stack, next)) push(next.start, token.end);
  }

  return breaks;
}

function breaksAfter(src: string, text: string, stack: string[], next: JsToken): boolean {
  // A `//` comment trailing the token it annotates stays with it. It runs to the
  // end of its line, so keeping it in place can never swallow following code.
  if (next.type === "comment" && src[next.start + 1] === "/") return false;
  const top = stack[stack.length - 1];
  if (text === "{") return !isPunctText(src, next, "}");
  if (text === ";") return top !== "(";
  if (text === ",") return top === "{";
  // After a closing brace, a punctuator is always a continuation of the same
  // expression (`}),`, `}.then(`, `}]`), and so is `else`/`catch`/`finally`/
  // `while`. Anything else starts a new statement and earns a line.
  if (text === "}") {
    if (next.type === "punct") return false;
    return !(next.type === "ident" && BLOCK_CONTINUATION_KEYWORDS.has(jsTokenText(src, next)));
  }
  return false;
}

function isPunctText(src: string, token: JsToken, value: string): boolean {
  return token.type === "punct" && jsTokenText(src, token) === value;
}

// CSS has no regex-vs-division ambiguity to resolve, so it gets a direct
// character scan instead of the JS lexer: `//` is not a comment in CSS, and an
// unquoted `url(//cdn…)` would otherwise swallow the rest of the file.
function cssBreaks(src: string): SourceBreak[] {
  const breaks: SourceBreak[] = [];
  let depth = 0;
  let index = 0;

  const push = (at: number, gapStart: number, indent: number): void => {
    pushBreak(src, breaks, { at, gapStart, indent });
  };
  const skipSpace = (from: number): number => {
    let cursor = from;
    while (cursor < src.length && (src[cursor] === " " || src[cursor] === "\t")) cursor += 1;
    return cursor;
  };

  while (index < src.length) {
    const char = src[index];
    if (char === "/" && src[index + 1] === "*") {
      const close = src.indexOf("*/", index + 2);
      index = close === -1 ? src.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipCssString(src, index);
      continue;
    }
    if ((char === "u" || char === "U") && /^url\(/i.test(src.slice(index, index + 4))) {
      index = skipCssUrl(src, index + 4);
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      // The `}` itself moves to a fresh line, and so does whatever follows it.
      push(index, backSkipSpace(src, index), depth);
      const after = skipSpace(index + 1);
      if (after < src.length) push(after, index + 1, depth);
      index += 1;
      continue;
    }
    if (char === "{" || char === ";") {
      if (char === "{") depth += 1;
      const after = skipSpace(index + 1);
      if (after < src.length && src[after] !== "}") push(after, index + 1, depth);
      index += 1;
      continue;
    }
    index += 1;
  }

  return breaks;
}

function skipCssString(src: string, start: number): number {
  const quote = src[start];
  let index = start + 1;
  while (index < src.length) {
    if (src[index] === "\\") {
      index += 2;
      continue;
    }
    if (src[index] === quote) return index + 1;
    if (src[index] === "\n") return index;
    index += 1;
  }
  return index;
}

function skipCssUrl(src: string, start: number): number {
  let index = start;
  while (index < src.length && src[index] !== ")" && src[index] !== "\n") {
    if (src[index] === '"' || src[index] === "'") {
      index = skipCssString(src, index);
      continue;
    }
    index += 1;
  }
  return index;
}

function pushBreak(src: string, breaks: SourceBreak[], item: SourceBreak): void {
  // The source already starts a line here — a partially minified file, a license
  // banner above the bundle, or simply code that was never minified. Adding a
  // break would only insert a blank line.
  if (alreadyLineStart(src, item.at)) return;
  const last = breaks[breaks.length - 1];
  if (last && last.at === item.at) {
    // Two rules want the same position (`,` before a closing `}`). The shallower
    // indent is the closing one, which is the level the line should sit at.
    last.indent = Math.min(last.indent, item.indent);
    last.gapStart = Math.min(last.gapStart, item.gapStart);
    return;
  }
  breaks.push(item);
}

// True when only horizontal whitespace separates `at` from the start of its
// line, so the text there is already at a line start.
function alreadyLineStart(src: string, at: number): boolean {
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = src[index];
    if (char === "\n") return true;
    if (!isHorizontalSpace(char)) return false;
  }
  return true; // start of file
}

function backSkipSpace(src: string, from: number): number {
  let cursor = from;
  while (cursor > 0 && isHorizontalSpace(src[cursor - 1])) cursor -= 1;
  return cursor;
}

function isHorizontalSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\v" || char === "\f";
}
