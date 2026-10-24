// Constant-folding normalization pre-pass for the deterministic code scanner.
//
// The capability rules in `scripts.ts` are literal-regex based, so identifiers
// assembled at runtime slip past them entirely: `['chi','ld_pro','cess'].join('')`,
// `'re' + 'quire'`, and `globalThis['proc' + 'ess']` never present a contiguous
// `child_process` / `require` / `process` token to a regex. This module folds
// those constructs back into their literal form *before* the regex set runs, so
// the existing rules see `"child_process"`, `globalThis.require`, etc.
//
// It deliberately uses a tokenizer (`platform/js-lexer.ts`) rather than text
// substitution: folding must never reach into comments, string bodies, template
// literals, or regex literals (where a `'a'+'b'` is data, not assembly). A full
// AST would catch more (data flow, variable propagation) but is the heavier
// variant that belongs on the gated-target path; this lightweight pass is cheap
// enough for the staged path.
//
// Line numbers are preserved exactly: every fold replaces a single-line source
// span (folds spanning a newline are skipped) and folded string literals
// re-encode control characters, so `firstMatchingLine` keeps pointing at the
// real line in the original file.

import {
  jsTokenText,
  tokenizeJs,
  tokenizeJsWithinBudget,
  type JsToken,
} from "../../platform/js-lexer";

// Every pass lexes the whole file unbounded, so larger files are scanned
// unfolded (raw text only).
const MAX_NORMALIZE_BYTES = 512 * 1024;
// Folds simplify monotonically (shorter text, fewer tokens), so a handful of
// passes reaches a fixpoint. `globalThis['re' + 'quire']` needs two: concat then
// member access.
const MAX_PASSES = 6;

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Reserved words that cannot be the base of a member access (`return['x']` is an
// array literal after a keyword, not `return.x`). `this`/`super` are values and
// stay valid bases, so they are intentionally excluded.
const NON_BASE_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "case",
  "throw",
  "yield",
  "await",
  "function",
  "var",
  "let",
  "const",
  "if",
  "while",
  "for",
  "switch",
  "default",
  "export",
  "import",
  "extends",
  "with",
  "class",
  "from",
]);

interface Replacement {
  start: number;
  end: number;
  text: string;
  last: number;
}

export interface NormalizeOptions {
  // Fold literal decodes (see "Decode folds"). Off for the patterns whose
  // evidence is the decode call itself, which a fold would erase.
  decode?: boolean;
}

// Every rule family normalizes the same samples, so one synchronous scan
// shares the results: `withNormalizeMemo` holds them only for the duration of
// its callback, which no other scan can interleave with.
let normalizeMemo: Map<string, string>[] | null = null;

export function withNormalizeMemo<T>(scan: () => T): T {
  if (normalizeMemo) return scan();
  normalizeMemo = [new Map(), new Map()];
  try {
    return scan();
  } finally {
    normalizeMemo = null;
  }
}

export function normalizeCodeForScanning(
  source: string,
  { decode = true }: NormalizeOptions = {},
): string {
  if (!source || source.length > MAX_NORMALIZE_BYTES) return source;
  const memo = normalizeMemo?.[decode ? 1 : 0];
  const hit = memo?.get(source);
  if (hit !== undefined) return hit;
  let current = source;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = foldOnce(current, decode);
    if (next === current) break;
    current = next;
  }
  memo?.set(source, current);
  return current;
}

// --- Code views ------------------------------------------------------------
//
// Same-length copies of a JavaScript source with inert text blanked to spaces,
// so a capability pattern stops matching prose (`// fetch() leaves them alone`,
// a JSDoc `import … from 'node:http'`) or code emitted as data
// (`"WebAssembly.compile(bytes)"` in a bundler's runtime template). Offsets,
// line terminators and therefore line numbers and changed regions are
// unchanged. Blanking removes matches, so it is limited to what the lexer
// classifies unambiguously and to JavaScript-family paths: lexing a shell
// script as JavaScript would read `https://host` as a `//` comment.
//
// A source containing `<!--` or `-->` is not blanked at all. The lexer reads
// both as Annex B HTML-like comments, which they are only in Script source; in
// a module `a <!--b` is `a < !(--b)`, so the lexer's view of every later token,
// a template literal's extent included, can be wrong. The package's own module
// type is not trusted to decide which goal applies.
//
// Kept as written: the `${…}` bodies of template literals, which are code
// (string and template literals inside them are still literal text); regex
// literals.

const CODE_VIEW_PATH = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
// Single-file components mix script with markup the lexer cannot read. Only
// whole-line `//` comments inside their script regions are blanked, and only
// where the lexer, run over that region, also reads a comment: a `//` line
// inside a template literal is template text that an eval can still run. A
// region is trusted only in the component's leading run of script blocks
// (Astro's `---` frontmatter, or plain `<script …>…</script>` elements
// separated by whitespace): once markup starts, a `<script>` could sit in an
// attribute value, an expression string or an HTML comment, which only a full
// parser of each dialect could tell apart. A blanked line must also carry
// nothing that runs in markup or resumes code: no quote, backtick, `$`, brace,
// `<` or `*/`. Strings are never blanked in a component.
const COMPONENT_PATH = /\.(?:astro|vue|svelte)$/i;
const ASTRO_FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---/;
// Plain attributes only; any other opening tag ends the leading run.
const SCRIPT_OPEN_TAG = /^<script(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[\w-]+))?)*\s*>/;
// The close every dialect agrees on; any other spelling ends the leading run,
// since Svelte matches it case-sensitively and HTML parsers do not.
const SCRIPT_CLOSE_TAG = /^<\/script\s*>/;
const INERT_LINE_COMMENT = /^\/\/(?:(?!\*\/)[^`'"${}<\n])*$/;
// The lexer is linear (about 0.4 ms/KB) and the views are built lazily, only
// for files a pattern already matched raw, so the cap sits well above the
// constant folder's: bundled chunks (vite's `node.js` is 1.4 MB) are the
// files that carry the most JSDoc.
const MAX_CODE_VIEW_BYTES = 4 * 1024 * 1024;
function leadingScriptRegions(path: string, source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let pos = 0;
  if (/\.astro$/i.test(path)) {
    const frontmatter = ASTRO_FRONTMATTER.exec(source);
    if (frontmatter) {
      const start = frontmatter.index + frontmatter[0].indexOf(frontmatter[1]);
      const body = frontmatter[1];
      // A fence-like line inside means the real fence may close earlier.
      if (/^\s*---/m.test(body)) return regions;
      // The real fence may close later (a `---` line inside a frontmatter
      // template): lexing this prefix still reads it right, but what follows
      // may be frontmatter code, not a top-level `<script>`.
      regions.push([start, start + body.length]);
      return regions;
    }
  }
  for (;;) {
    while (pos < source.length && /\s/.test(source[pos])) pos += 1;
    // Bounded so the attribute pattern cannot backtrack over a long run.
    const open = SCRIPT_OPEN_TAG.exec(source.slice(pos, pos + 512));
    if (!open) return regions;
    const start = pos + open[0].length;
    const closeFinder = /<\/script/gi;
    closeFinder.lastIndex = start;
    const end = closeFinder.exec(source)?.index ?? -1;
    if (end < 0) return regions;
    const close = SCRIPT_CLOSE_TAG.exec(source.slice(end, end + 64));
    if (!close) return regions;
    regions.push([start, end]);
    pos = end + close[0].length;
  }
}

function componentScriptViews(path: string, source: string): CodeViews {
  const comments: JsToken[] = [];
  for (const [start, end] of leadingScriptRegions(path, source)) {
    const region = source.slice(start, end);
    if (templateMarkersExceed(region, MAX_TEMPLATE_MARKERS)) continue;
    const tokens = tokenizeJsWithinBudget(region, { rejectJsx: true });
    if (!tokens) continue;
    for (const token of tokens) {
      if (token.type !== "comment") continue;
      // Pattern first: a line holds at most one `//` comment, so the look back
      // to the line start below is linear over the region.
      if (!INERT_LINE_COMMENT.test(jsTokenText(region, token))) continue;
      const lineStart = region.lastIndexOf("\n", token.start - 1) + 1;
      if (region.slice(lineStart, token.start).trim()) continue;
      comments.push({ ...token, start: start + token.start, end: start + token.end });
    }
  }
  const code = blankSpans(source, comments);
  return { code, codeNoStrings: code };
}
// The lexer keeps state per open template and substitution, about 2 KB a
// level, so a file of nested `` `${ `` can exhaust memory. Every level needs a
// backtick or a `${`; past this many of them (the largest bundles under the
// size cap carry about 40,000) the view is the raw text, which blanks nothing.
const MAX_TEMPLATE_MARKERS = 64 * 1024;

function templateMarkersExceed(source: string, limit: number): boolean {
  let count = 0;
  for (let i = source.indexOf("`"); i >= 0; i = source.indexOf("`", i + 1)) {
    if (++count > limit) return true;
  }
  for (let i = source.indexOf("${"); i >= 0; i = source.indexOf("${", i + 2)) {
    if (++count > limit) return true;
  }
  return false;
}

export interface CodeViews {
  // Comments blanked.
  code: string;
  // Comments, string literal bodies and substitution-free template bodies
  // blanked. Only for patterns that are call-shaped outside any string.
  codeNoStrings: string;
}

export function codeViewsForScanning(path: string, source: string): CodeViews {
  if (!source) return { code: source, codeNoStrings: source };
  // Past the cap the view is the raw text: a line-based comment pass cannot
  // tell a `//` line inside a template literal from a comment.
  if (source.length > MAX_CODE_VIEW_BYTES) return { code: source, codeNoStrings: source };
  if (source.includes("<!--") || source.includes("-->")) {
    return { code: source, codeNoStrings: source };
  }
  if (!CODE_VIEW_PATH.test(path)) {
    return COMPONENT_PATH.test(path)
      ? componentScriptViews(path, source)
      : { code: source, codeNoStrings: source };
  }
  if (templateMarkersExceed(source, MAX_TEMPLATE_MARKERS)) {
    return { code: source, codeNoStrings: source };
  }
  const comments: JsToken[] = [];
  const literals: JsToken[] = [];
  // JSX text is not JavaScript: `<p>/*</p>` would open a comment that hides
  // every call up to a later `*/`. The lexer gives up at JSX, and on input
  // that would cost it more than linear work; the view is then the raw text.
  const tokens = tokenizeJsWithinBudget(source, { rejectJsx: true });
  if (!tokens) return { code: source, codeNoStrings: source };
  const budget = { left: Math.max(TEMPLATE_RELEX_BUDGET, 2 * source.length) };
  for (const token of tokens) {
    if (token.type === "comment") {
      comments.push(token);
    } else if (token.type === "string") {
      literals.push({ ...token, start: token.start + 1, end: token.end - 1 });
    } else if (token.type === "template") {
      pushTemplateLiteralSpans(source, token.start, token.end, 0, literals, budget);
    }
  }
  const code = blankSpans(source, comments);
  return { code, codeNoStrings: blankSpans(code, literals) };
}

// The lexer returns a template with substitutions as one token, so each
// `${…}` is re-lexed on its own to find where it closes. Past a per-file
// budget of re-lexed characters (about twice the file) or a nesting cap, the
// remaining text stays unblanked, which can only keep a finding.
const TEMPLATE_RELEX_BUDGET = 256 * 1024;
const TEMPLATE_NESTING_LIMIT = 8;

function pushTemplateLiteralSpans(
  source: string,
  start: number,
  end: number,
  depth: number,
  out: JsToken[],
  budget: { left: number },
): void {
  const close = end - 1 > start && source[end - 1] === "`" ? end - 1 : end;
  let chunkStart = start + 1;
  let i = start + 1;
  while (i < close) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "$" && source[i + 1] === "{") {
      out.push({ type: "template", start: chunkStart, end: i });
      const exprEnd =
        depth < TEMPLATE_NESTING_LIMIT
          ? pushSubstitutionLiteralSpans(source, i + 2, close, depth, out, budget)
          : -1;
      if (exprEnd < 0) return;
      i = exprEnd + 1;
      chunkStart = i;
      continue;
    }
    i += 1;
  }
  out.push({ type: "template", start: chunkStart, end: Math.min(i, close) });
}

// Returns the offset of the `}` closing the substitution, or -1 when it
// cannot be found within the budget. The window grows from a small prefix:
// lexing is left to right, so every token before the cut is final and a `}`
// found there is the real close.
function pushSubstitutionLiteralSpans(
  source: string,
  exprStart: number,
  limit: number,
  depth: number,
  out: JsToken[],
  budget: { left: number },
): number {
  for (let window = 64; ; window *= 4) {
    const end = Math.min(limit, exprStart + window);
    budget.left -= end - exprStart;
    if (budget.left < 0) return -1;
    const close = substitutionClose(source, exprStart, end, depth, out, budget);
    if (close >= 0 || end === limit) return close;
  }
}

function substitutionClose(
  source: string,
  exprStart: number,
  end: number,
  depth: number,
  out: JsToken[],
  budget: { left: number },
): number {
  const expression = source.slice(exprStart, end);
  const inner: JsToken[] = [];
  let braces = 0;
  const tokens = tokenizeJsWithinBudget(expression, { rejectJsx: true });
  if (!tokens) return -1;
  for (const token of tokens) {
    const at = exprStart + token.start;
    if (token.type === "punct") {
      const text = jsTokenText(expression, token);
      if (text === "{") braces += 1;
      else if (text === "}") {
        if (braces === 0) {
          for (const token of inner) out.push(token);
          return at;
        }
        braces -= 1;
      }
    } else if (token.type === "string") {
      inner.push({ ...token, start: at + 1, end: exprStart + token.end - 1 });
    } else if (token.type === "template") {
      pushTemplateLiteralSpans(source, at, exprStart + token.end, depth + 1, inner, budget);
    }
  }
  return -1;
}

function blankSpans(source: string, spans: JsToken[]): string {
  if (spans.length === 0) return source;
  let out = "";
  let pos = 0;
  for (const span of spans) {
    if (span.end <= span.start) continue;
    out +=
      source.slice(pos, span.start) + source.slice(span.start, span.end).replace(/[^\r\n]/g, " ");
    pos = span.end;
  }
  return out + source.slice(pos);
}

function foldOnce(src: string, decode: boolean): string {
  // Unbounded: a lexer that gave up here would leave the source unfolded and
  // hide what the fold reveals.
  const sig = tokenizeJs(src).filter(isSignificantToken);
  const replacements: Replacement[] = [];
  let consumed = -1;
  for (let k = 0; k < sig.length; k += 1) {
    if (k <= consumed) continue;
    const token = sig[k];
    let rep: Replacement | null = null;
    if (isPunct(src, token, "[")) {
      rep = tryJoinFold(src, sig, k) ?? tryMemberFold(src, sig, k);
    } else if (token.type === "string") {
      rep = tryConcatFold(src, sig, k) ?? tryEscapeFold(src, token, k);
    } else if (decode && token.type === "ident") {
      rep = tryDecodeFold(src, sig, k);
    }
    if (rep) {
      replacements.push(rep);
      consumed = rep.last;
    }
  }
  if (replacements.length === 0) return src;
  return applyReplacements(src, replacements);
}

// --- Fold detection -------------------------------------------------------

// `'a' + 'b' + 'c'` -> `"abc"`. Greedily consumes a run of string literals
// joined by binary `+`.
function tryConcatFold(src: string, sig: JsToken[], k: number): Replacement | null {
  if (sig[k].type !== "string") return null;
  const values: string[] = [sig[k].value ?? ""];
  let j = k;
  while (isPunct(src, sig[j + 1], "+") && sig[j + 2]?.type === "string") {
    values.push(sig[j + 2].value ?? "");
    j += 2;
  }
  if (j === k) return null;
  const start = sig[k].start;
  const end = sig[j].end;
  return { start, end, text: padLines(src, start, end, encodeString(values.join(""))), last: j };
}

// `['a','b'].join('')` -> `"ab"` (and `.join()` -> `,` separator, `.join('-')`
// -> dash). Only fires for genuine array literals, never computed access.
function tryJoinFold(src: string, sig: JsToken[], k: number): Replacement | null {
  if (isMemberBase(src, sig[k - 1])) return null;
  const parts: string[] = [];
  let j = k + 1;
  if (!isPunct(src, sig[j], "]")) {
    for (;;) {
      if (sig[j]?.type !== "string") return null;
      parts.push(sig[j].value ?? "");
      j += 1;
      if (isPunct(src, sig[j], ",")) {
        j += 1;
        if (isPunct(src, sig[j], "]")) break;
        continue;
      }
      if (isPunct(src, sig[j], "]")) break;
      return null;
    }
  }
  if (!isPunct(src, sig[j], "]")) return null;
  if (!isPunct(src, sig[j + 1], ".") || !isIdent(src, sig[j + 2], "join")) return null;
  if (!isPunct(src, sig[j + 3], "(")) return null;
  let separator = ",";
  let closeIdx: number;
  if (isPunct(src, sig[j + 4], ")")) {
    closeIdx = j + 4;
  } else if (sig[j + 4]?.type === "string" && isPunct(src, sig[j + 5], ")")) {
    separator = sig[j + 4].value ?? "";
    closeIdx = j + 5;
  } else {
    return null;
  }
  const start = sig[k].start;
  const end = sig[closeIdx].end;
  const text = padLines(src, start, end, encodeString(parts.join(separator)));
  return { start, end, text, last: closeIdx };
}

// `obj['require']` -> `obj.require` when the key is a valid identifier and the
// `[` follows a member base (so array literals are left alone).
function tryMemberFold(src: string, sig: JsToken[], k: number): Replacement | null {
  if (!isMemberBase(src, sig[k - 1])) return null;
  if (sig[k + 1]?.type !== "string" || !isPunct(src, sig[k + 2], "]")) return null;
  const name = sig[k + 1].value ?? "";
  if (!IDENTIFIER_RE.test(name)) return null;
  const start = sig[k].start;
  const end = sig[k + 2].end;
  if (spansNewline(src, start, end)) return null;
  return { start, end, text: `.${name}`, last: k + 2 };
}

// `'\x63hild_process'` -> `"child_process"`. A lone literal spelled with hex,
// unicode, octal or identity escapes (`\d` is "d") reads as its value. The
// escapes every encoder emits (`\n`, `\'`, `\\`…) leave a literal as written.
function tryEscapeFold(src: string, token: JsToken, k: number): Replacement | null {
  const raw = jsTokenText(src, token);
  if (!/\\(?![nrtbfv'"\\\r\n]|0(?![0-9]))/.test(raw)) return null;
  const value = token.value ?? "";
  if (!isMostlyText(value)) return null;
  const text = padLines(src, token.start, token.end, encodeString(value));
  return text === raw ? null : { start: token.start, end: token.end, text, last: k };
}

// --- Decode folds ----------------------------------------------------------
//
// A literal run through a standard decoder is the payload it decodes to:
// `atob("…")`, `Buffer.from("…", "base64" | "base64url" | "hex")` with or
// without a text `.toString()`, `String.fromCharCode(…)`/`fromCodePoint`, and
// `decodeURIComponent`/`decodeURI`/`unescape`. The bytes are decoded as data
// here and never run. A decode that yields binary or control characters is a
// byte table, not text, and stays as written.
//
// When the decode is the whole argument of a primitive that runs a string as
// code (`eval(atob("…"))`, `new Function(Buffer.from(…).toString())`,
// `vm.runInThisContext(…)`), the decoded source is spliced in as code rather
// than as a string, comments dropped and lines joined, so the capability
// patterns see the calls it would make. Each fold shrinks the text, and nested
// encodings unwrap one level a pass up to `MAX_PASSES`.
const MAX_DECODE_LITERAL = 256 * 1024;
const MAX_CHAR_CODES = 64 * 1024;
const GLOBAL_RECEIVERS = new Set(["globalThis", "window", "self", "global"]);
const URI_DECODERS = new Set(["decodeURIComponent", "decodeURI", "unescape"]);
const BUFFER_TEXT_ENCODINGS = new Set(["utf8", "utf-8", "ascii", "latin1", "binary"]);
const CODE_SINKS = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "runInThisContext",
  "runInNewContext",
  "runInContext",
  "compileFunction",
  "_compile",
  "Script",
  "setTimeout",
  "setInterval",
  "execScript",
]);

function tryDecodeFold(src: string, sig: JsToken[], k: number): Replacement | null {
  const call = decodeCall(src, sig, k);
  if (!call) return null;
  const code = isCodeSinkArgument(src, sig, call.first, call.last)
    ? singleLineCode(call.decoded)
    : null;
  const text = code === null ? encodeString(call.decoded) : `(${code})`;
  return {
    start: call.start,
    end: call.end,
    text: padLines(src, call.start, call.end, text),
    last: call.last,
  };
}

interface DecodeCall {
  start: number;
  end: number;
  // Indices of the call's first token (its global receiver, when written) and
  // closing parenthesis.
  first: number;
  last: number;
  decoded: string;
}

function decodeCall(src: string, sig: JsToken[], k: number): DecodeCall | null {
  const name = jsTokenText(src, sig[k]);
  let first = k;
  if (isPunct(src, sig[k - 1], ".") || isPunct(src, sig[k - 1], "?.")) {
    const receiver = sig[k - 2];
    if (receiver?.type !== "ident" || !GLOBAL_RECEIVERS.has(jsTokenText(src, receiver))) {
      return null;
    }
    first = k - 2;
  }
  let decoded: string | null = null;
  let last = -1;
  if (name === "atob" || URI_DECODERS.has(name)) {
    const arg = literalValue(src, sig[k + 2]);
    if (!isPunct(src, sig[k + 1], "(") || arg === null) return null;
    if (!isPunct(src, sig[k + 3], ")")) return null;
    decoded = name === "atob" ? decodeAtob(arg) : decodeUri(name, arg);
    last = k + 3;
  } else if (name === "Buffer" && first === k) {
    const buffer = decodeBufferFrom(src, sig, k);
    if (!buffer) return null;
    decoded = buffer.decoded;
    last = buffer.last;
  } else if (name === "String" && first === k) {
    const chars = decodeFromCharCode(src, sig, k);
    if (!chars) return null;
    decoded = chars.decoded;
    last = chars.last;
  }
  if (decoded === null || !isMostlyText(decoded)) return null;
  return { start: sig[first].start, end: sig[last].end, first, last, decoded };
}

// A string literal's value, or a substitution-free template's text when it
// has no escapes to cook.
function literalValue(src: string, token: JsToken | undefined): string | null {
  if (token?.type === "string") return token.value ?? "";
  if (token?.type !== "template") return null;
  const raw = jsTokenText(src, token);
  if (raw.length < 2 || !raw.endsWith("`") || /\\|\$\{/.test(raw)) return null;
  return raw.slice(1, -1);
}

// `Buffer.from(LIT, ENC)` plus an optional text `.toString()`. A `.toString`
// back to a binary encoding re-encodes rather than decodes and is left alone.
function decodeBufferFrom(
  src: string,
  sig: JsToken[],
  k: number,
): { decoded: string | null; last: number } | null {
  if (!isPunct(src, sig[k + 1], ".") || !isIdent(src, sig[k + 2], "from")) return null;
  if (!isPunct(src, sig[k + 3], "(")) return null;
  const value = literalValue(src, sig[k + 4]);
  const encoding = literalValue(src, sig[k + 6]);
  if (value === null || !isPunct(src, sig[k + 5], ",")) return null;
  if (encoding === null || !isPunct(src, sig[k + 7], ")")) return null;
  let last = k + 7;
  if (isPunct(src, sig[last + 1], ".") && isIdent(src, sig[last + 2], "toString")) {
    if (!isPunct(src, sig[last + 3], "(")) return null;
    if (isPunct(src, sig[last + 4], ")")) {
      last += 4;
    } else if (
      sig[last + 4]?.type === "string" &&
      BUFFER_TEXT_ENCODINGS.has((sig[last + 4].value ?? "").toLowerCase()) &&
      isPunct(src, sig[last + 5], ")")
    ) {
      last += 5;
    } else {
      return null;
    }
  }
  if (value.length > MAX_DECODE_LITERAL) return null;
  const bytes = decodeBufferBytes(value, encoding.toLowerCase());
  return { decoded: bytes ? decodeUtf8(bytes) : null, last };
}

function decodeBufferBytes(value: string, encoding: string): Uint8Array | null {
  if (encoding === "base64" || encoding === "base64url") {
    const latin1 = decodeBase64Latin1(value.replace(/-/g, "+").replace(/_/g, "/"));
    return latin1 === null ? null : Uint8Array.from(latin1, (ch) => ch.charCodeAt(0));
  }
  if (encoding === "hex") {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  return null;
}

// `String.fromCharCode(104, 0x69)` with numeric literal arguments only.
function decodeFromCharCode(
  src: string,
  sig: JsToken[],
  k: number,
): { decoded: string | null; last: number } | null {
  if (!isPunct(src, sig[k + 1], ".")) return null;
  const method = sig[k + 2];
  const codePoints = isIdent(src, method, "fromCodePoint");
  if (!codePoints && !isIdent(src, method, "fromCharCode")) return null;
  if (!isPunct(src, sig[k + 3], "(")) return null;
  const units: number[] = [];
  let j = k + 4;
  while (sig[j]?.type === "number") {
    if (units.length >= MAX_CHAR_CODES) return null;
    const unit = Number(jsTokenText(src, sig[j]));
    if (!Number.isInteger(unit) || unit < 0 || unit > (codePoints ? 0x10ffff : 0xffff)) {
      return null;
    }
    units.push(unit);
    j += 1;
    if (!isPunct(src, sig[j], ",")) break;
    j += 1;
  }
  if (!units.length || !isPunct(src, sig[j], ")")) return null;
  // Chunked: spreading a long argument list overflows the call stack.
  let decoded = "";
  for (let i = 0; i < units.length; i += 4096) {
    const chunk = units.slice(i, i + 4096);
    decoded += codePoints ? String.fromCodePoint(...chunk) : String.fromCharCode(...chunk);
  }
  return { decoded, last: j };
}

// `atob` returns one character per byte; a payload is usually UTF-8 text, so
// valid UTF-8 reads as the text it encodes (emoji included).
function decodeAtob(value: string): string | null {
  const latin1 = decodeBase64Latin1(value);
  if (latin1 === null || !/[\x80-\xff]/.test(latin1)) return latin1;
  return decodeUtf8(Uint8Array.from(latin1, (ch) => ch.charCodeAt(0))) ?? latin1;
}

// `atob` semantics: whitespace is ignored, padding is optional, and the result
// is one character per byte.
function decodeBase64Latin1(value: string): string | null {
  const compact = value.replace(/[\t\n\f\r ]+/g, "");
  if (!compact || compact.length > MAX_DECODE_LITERAL) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  try {
    return atob(compact);
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUri(name: string, value: string | undefined): string | null {
  if (!value || !value.includes("%") || value.length > MAX_DECODE_LITERAL) return null;
  if (name === "unescape") {
    return value.replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, (_match, wide, byte) =>
      String.fromCharCode(Number.parseInt(wide ?? byte, 16)),
    );
  }
  try {
    return name === "decodeURI" ? decodeURI(value) : decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Text rather than bytes: at most one character in ten is a control
// character. A stray control byte cannot keep a payload from folding (they are
// escaped in the folded literal and blanked in spliced code), while an image or
// byte table stays as written.
function isMostlyText(value: string): boolean {
  let control = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (isControlCharacter(value.charCodeAt(i))) control += 1;
  }
  return control * 10 <= value.length;
}

// Control characters other than tab, line feed and carriage return, plus
// U+2028/U+2029, which some consumers of the folded text split lines on.
function isControlCharacter(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

// True when the decode spanning `sig[first..last]` is the whole argument of a
// code-running call: `eval(D)`, `eval?.(D)`, `(0, eval)(D)`, `vm.Script(D)`,
// or the body after literal parameter names in `Function("a", D)`.
function isCodeSinkArgument(src: string, sig: JsToken[], first: number, last: number): boolean {
  if (!isPunct(src, sig[last + 1], ")")) return false;
  let open = first - 1;
  while (isPunct(src, sig[open], ",") && sig[open - 1]?.type === "string") open -= 2;
  if (!isPunct(src, sig[open], "(")) return false;
  let callee = sig[open - 1];
  if (isPunct(src, callee, "?.")) callee = sig[open - 2];
  if (isPunct(src, callee, ")")) {
    // `(0, eval)(D)`: the indirect-eval idiom.
    const inner = sig[open - 2];
    return isIdent(src, inner, "eval") && isPunct(src, sig[open - 3], ",");
  }
  return callee?.type === "ident" && CODE_SINKS.has(jsTokenText(src, callee));
}

// The decoded source on one line, so the spliced code keeps every later line
// number: comments become a space, line breaks between tokens become a space,
// a template literal's line breaks become `\n` escapes, and control characters
// become spaces. Null when the source cannot be joined safely (the decode then
// folds to a string literal): an HTML-like comment, which is one only in Script
// source (see the code views) and would swallow the rest of the joined line,
// a token left open, which would swallow the code after the splice, or an
// unbalanced bracket, which would change how the code after the splice lexes.
function singleLineCode(source: string): string | null {
  if (source.includes("<!--") || source.includes("-->")) return null;
  const tokens = tokenizeJsWithinBudget(source, { rejectJsx: true });
  if (!tokens || !balancedBrackets(source, tokens)) return null;
  let out = "";
  let pos = 0;
  for (const token of tokens) {
    const text = jsTokenText(source, token);
    if (!isClosedToken(token, text)) return null;
    out += source.slice(pos, token.start).replace(/[\r\n]+/g, " ");
    if (token.type === "comment") out += " ";
    else if (token.type === "template") out += text.replace(/\r\n|\r|\n/g, "\\n");
    else if (token.type === "string") out += text.replace(/\\(?:\r\n|\r|\n)/g, "");
    else out += text.replace(/[\r\n]+/g, " ");
    pos = token.end;
  }
  out += source.slice(pos).replace(/[\r\n]+/g, " ");
  const joined = Array.from(out, (ch) => (isControlCharacter(ch.charCodeAt(0)) ? " " : ch)).join(
    "",
  );
  // Joining can change what the tokens are (a `//` comment inside a template
  // substitution now runs to the end of the joined line), so the join is only
  // spliced when it re-lexes to the same significant tokens, and a sentinel
  // after it survives: a token left open swallows it, whatever text it ends in.
  return sameSignificantTokens(source, tokens, joined) ? joined : null;
}

const CLOSING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function balancedBrackets(source: string, tokens: JsToken[]): boolean {
  const open: string[] = [];
  for (const token of tokens) {
    if (token.type !== "punct") continue;
    const text = jsTokenText(source, token);
    if (text === "(" || text === "[" || text === "{") open.push(text);
    else if (text in CLOSING_BRACKETS && open.pop() !== CLOSING_BRACKETS[text]) return false;
  }
  return open.length === 0;
}

function sameSignificantTokens(source: string, tokens: JsToken[], joined: string): boolean {
  const withSentinel = `${joined}\n;`;
  const rejoined = tokenizeJsWithinBudget(withSentinel, { rejectJsx: true });
  if (!rejoined) return false;
  const before = tokens.filter(isSignificantToken);
  const after = rejoined.filter(isSignificantToken);
  const sentinel = after.pop();
  if (sentinel?.start !== withSentinel.length - 1 || sentinel.end !== withSentinel.length) {
    return false;
  }
  if (before.length !== after.length) return false;
  return after.every((token, i) => {
    if (token.type !== before[i].type) return false;
    if (token.type === "template") return true;
    if (token.type === "string") return token.value === before[i].value;
    return jsTokenText(joined, token) === jsTokenText(source, before[i]);
  });
}

function isClosedToken(token: JsToken, text: string): boolean {
  if (token.type === "string") return text.length >= 2 && endsUnescaped(text, text[0]);
  if (token.type === "template") return text.length >= 2 && endsUnescaped(text, "`");
  if (token.type === "comment") return !text.startsWith("/*") || /^\/\*[\s\S]*\*\/$/.test(text);
  if (token.type === "regex") return /^\/[\s\S]*\/[a-z]*$/i.test(text) && text.length >= 2;
  return true;
}

function endsUnescaped(text: string, close: string): boolean {
  if (!text.endsWith(close)) return false;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

function isSignificantToken(token: JsToken): boolean {
  return token.type !== "ws" && token.type !== "comment";
}

function isMemberBase(src: string, token: JsToken | undefined): boolean {
  if (!token) return false;
  if (token.type === "ident") return !NON_BASE_KEYWORDS.has(jsTokenText(src, token));
  if (token.type === "punct") {
    const t = jsTokenText(src, token);
    return t === ")" || t === "]";
  }
  return token.type === "string" || token.type === "template" || token.type === "number";
}

// --- Serialization & helpers ---------------------------------------------

function applyReplacements(src: string, reps: Replacement[]): string {
  let out = "";
  let pos = 0;
  for (const rep of reps) {
    out += src.slice(pos, rep.start) + rep.text;
    pos = rep.end;
  }
  return out + src.slice(pos);
}

// Re-encode a folded value as a single-line double-quoted literal. Control
// characters are escaped so a decoded `\n` never becomes a real newline (which
// would shift every downstream line number). `<!--` and `-->` are escaped too:
// either one in the folded text turns comment blanking off for the whole
// folded view (see the code views), so a fold that spelled one would turn a
// commented-out call into a finding.
function encodeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (isControlCharacter(code)) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out.replace(/<!--/g, "\\x3C!--").replace(/-->/g, "--\\x3E")}"`;
}

// A replacement spanning lines keeps them: the folded text goes on the first
// line, followed by the span's own line terminators.
function padLines(src: string, start: number, end: number, text: string): string {
  const breaks = src.slice(start, end).match(/\r\n|[\r\n\u2028\u2029]/g);
  return breaks ? text + breaks.join("") : text;
}

function spansNewline(src: string, start: number, end: number): boolean {
  return /[\r\n\u2028\u2029]/.test(src.slice(start, end));
}

function isPunct(src: string, token: JsToken | undefined, value: string): boolean {
  return token?.type === "punct" && jsTokenText(src, token) === value;
}

function isIdent(src: string, token: JsToken | undefined, value: string): boolean {
  return token?.type === "ident" && jsTokenText(src, token) === value;
}
