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

// Samples are bounded to 64KB by the sandbox; this is a safety valve only.
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

export function normalizeCodeForScanning(source: string): string {
  if (!source || source.length > MAX_NORMALIZE_BYTES) return source;
  let current = source;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = foldOnce(current);
    if (next === current) break;
    current = next;
  }
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

function foldOnce(src: string): string {
  // Unbounded: a lexer that gave up here would leave the source unfolded and
  // hide what the fold reveals.
  const sig = tokenizeJs(src).filter((t) => t.type !== "ws" && t.type !== "comment");
  const replacements: Replacement[] = [];
  let consumed = -1;
  for (let k = 0; k < sig.length; k += 1) {
    if (k <= consumed) continue;
    const token = sig[k];
    let rep: Replacement | null = null;
    if (isPunct(src, token, "[")) {
      rep = tryJoinFold(src, sig, k) ?? tryMemberFold(src, sig, k);
    } else if (token.type === "string") {
      rep = tryConcatFold(src, sig, k);
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
  if (spansNewline(src, start, end)) return null;
  return { start, end, text: encodeString(values.join("")), last: j };
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
  if (spansNewline(src, start, end)) return null;
  return { start, end, text: encodeString(parts.join(separator)), last: closeIdx };
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
// would shift every downstream line number).
function encodeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

function spansNewline(src: string, start: number, end: number): boolean {
  const span = src.slice(start, end);
  return span.includes("\n") || span.includes("\r");
}

function isPunct(src: string, token: JsToken | undefined, value: string): boolean {
  return token?.type === "punct" && jsTokenText(src, token) === value;
}

function isIdent(src: string, token: JsToken | undefined, value: string): boolean {
  return token?.type === "ident" && jsTokenText(src, token) === value;
}
