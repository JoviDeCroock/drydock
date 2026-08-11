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
//   2. Breaks land only after `;`, `{`, `,` and around container braces/brackets
//      — positions where a newline can never change how the engine parses the
//      program (none of them is an automatic-semicolon-insertion site), so the
//      reformatted text stays semantically the source it came from.
//   3. It never parses, evaluates, or executes anything: the JS side is a pure
//      lexer walk (`server/lib/platform/js-lexer.ts`), the CSS side a character
//      scanner.
//
// Every output line records the source line it came from, so deterministic
// findings stay pinned to real evidence (`remapFindingLines`).

import { jsTokenText, tokenizeJs, type JsToken } from "../../server/lib/platform/js-lexer";

export type FormatLanguage = "js" | "json" | "css";

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
// JSX text and SCSS line comments carry whitespace-sensitive syntax that the
// deliberately small scanners below do not understand. Fail closed for those
// grammars instead of presenting a transformed view that changes their meaning.
const JS_LANGS = new Set(["javascript", "typescript"]);
const CSS_LANGS = new Set(["css"]);

export function formatLanguageFor(lang: string | undefined): FormatLanguage | null {
  if (!lang) return null;
  if (JS_LANGS.has(lang)) return "js";
  if (lang === "json") return "json";
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
  const breaks = language === "css" ? cssBreaks(text) : jsBreaks(text, language === "json");
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
const BLOCK_CONTINUATION_KEYWORDS = new Set([
  "as",
  "catch",
  "else",
  "finally",
  "satisfies",
  "while",
]);

function jsBreaks(src: string, splitArrays: boolean): SourceBreak[] {
  // Comments stay in the significant stream: they are content a reviewer reads,
  // and keeping them means the gap between two consecutive entries is always
  // pure whitespace.
  const tokens = tokenizeJs(src).filter((token) => token.type !== "ws");
  const breaks: SourceBreak[] = [];
  // Open brackets, innermost last. `;` inside `(` is a `for(;;)` separator, and
  // `,` only earns a line of its own inside an object literal/block, plus arrays
  // in JSON mode where every comma is a data separator rather than JS syntax.
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
    const closesFormattedContainer = text === "}" || (splitArrays && text === "]");
    const matchingOpen = text === "}" ? "{" : "[";
    if (closesFormattedContainer && previous && !isPunctText(src, previous, matchingOpen)) {
      push(token.start, previous.end);
    }

    if (text === "{" || text === "[" || text === "(") stack.push(text);

    if (!next) continue;
    if (breaksAfter(src, text, stack, next, splitArrays)) push(next.start, token.end);
  }

  return breaks;
}

function breaksAfter(
  src: string,
  text: string,
  stack: string[],
  next: JsToken,
  splitArrays: boolean,
): boolean {
  // A `//` comment trailing the token it annotates stays with it. It runs to the
  // end of its line, so keeping it in place can never swallow following code.
  if (next.type === "comment" && src[next.start + 1] === "/") return false;
  const top = stack[stack.length - 1];
  if (text === "{") return !isPunctText(src, next, "}");
  if (splitArrays && text === "[") return !isPunctText(src, next, "]");
  if (text === ";") return top !== "(";
  if (text === ",") return top === "{" || (splitArrays && top === "[");
  // After a closing brace, a punctuator is always a continuation of the same
  // expression (`}),`, `}.then(`, `}]`), and so is `else`/`catch`/`finally`/
  // `while`. Anything else starts a new statement and earns a line.
  if (text === "}" || (splitArrays && text === "]")) {
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
    const identifier = scanCssIdentifier(src, index);
    if (identifier) {
      if (identifier.value.toLowerCase() === "url" && src[identifier.end] === "(") {
        index = skipCssUrl(src, identifier.end + 1);
      } else {
        index = identifier.end;
      }
      continue;
    }
    if (char === "/" && src[index + 1] === "*") {
      const close = src.indexOf("*/", index + 2);
      index = close === -1 ? src.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipCssString(src, index);
      continue;
    }
    // CSS escapes make the next code point data even when it is normally a
    // structural delimiter (`.foo\;bar`, for example). Never split there.
    if (char === "\\") {
      index = scanCssEscape(src, index).end;
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
      index = scanCssEscape(src, index).end;
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
    if (src[index] === "\\") {
      index = scanCssEscape(src, index).end;
      continue;
    }
    if (src[index] === '"' || src[index] === "'") {
      index = skipCssString(src, index);
      continue;
    }
    index += 1;
  }
  return index;
}

interface CssIdentifier {
  end: number;
  value: string;
}

// CSS identifiers may spell any code point with a backslash escape, including
// the name of the url() function itself (`u\72l(...)`). Decode just enough of
// the identifier to recognize that function before the structural scan walks
// its opaque payload.
function scanCssIdentifier(src: string, start: number): CssIdentifier | null {
  const first = src[start];
  if (!isCssNameStart(first) && first !== "-" && first !== "\\") return null;
  let value = "";
  let index = start;
  while (index < src.length) {
    const char = src[index];
    if (isCssNameChar(char)) {
      value += char;
      index += 1;
      continue;
    }
    if (char !== "\\") break;
    const escape = scanCssEscape(src, index);
    // A backslash-newline is not an identifier escape. Leave it to the generic
    // hostile-input path rather than joining tokens the CSS parser keeps apart.
    if (escape.value === null) break;
    value += escape.value;
    index = escape.end;
  }
  return index === start ? null : { end: index, value };
}

function scanCssEscape(src: string, start: number): { end: number; value: string | null } {
  const next = src[start + 1];
  if (next === undefined) return { end: start + 1, value: "" };
  if (next === "\r") {
    return { end: src[start + 2] === "\n" ? start + 3 : start + 2, value: null };
  }
  if (next === "\n" || next === "\f") return { end: start + 2, value: null };
  if (!/[0-9a-fA-F]/.test(next)) return { end: start + 2, value: next };

  let end = start + 1;
  while (end < src.length && end < start + 7 && /[0-9a-fA-F]/.test(src[end])) end += 1;
  const codePoint = Number.parseInt(src.slice(start + 1, end), 16);
  if (src[end] === "\r") end += src[end + 1] === "\n" ? 2 : 1;
  else if (src[end] === " " || src[end] === "\t" || src[end] === "\n" || src[end] === "\f") {
    end += 1;
  }
  const value =
    codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "\uFFFD"
      : String.fromCodePoint(codePoint);
  return { end, value };
}

function isCssNameStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return /[A-Za-z_]/.test(char) || code >= 0x80;
}

function isCssNameChar(char: string | undefined): boolean {
  return isCssNameStart(char) || char === "-" || (char !== undefined && /[0-9]/.test(char));
}

function pushBreak(src: string, breaks: SourceBreak[], item: SourceBreak): void {
  // The source already breaks the line here — a partially minified file, a
  // license banner above the bundle, or simply code that was never minified.
  // Adding a break would only insert a blank line. Both sides matter: the CSS
  // scanner lands `at` on the newline itself when a `{` or `;` already ends its
  // line, and the text after that newline is already at a line start.
  if (endsLineAt(src, item.at) || alreadyLineStart(src, item.at)) return;
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

// True when the source's own newline is the next thing at `at`, so a break here
// would push an empty line ahead of a line the source already started.
function endsLineAt(src: string, at: number): boolean {
  return src[at] === "\n" || src[at] === "\r";
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
