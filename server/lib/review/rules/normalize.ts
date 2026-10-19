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

import { jsTokenText, tokenizeJs, type JsToken } from "../../platform/js-lexer";

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
// Kept as written: Annex B HTML-like comments (`<!--`, `-->`), which are
// comments only in Script source, so a module could hide a call behind one;
// the `${…}` bodies of template literals, which are code (string and template
// literals inside them are still literal text); regex literals.

const CODE_VIEW_PATH = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
// Single-file components mix script with markup the lexer cannot read, so
// they, and JavaScript past the lexing cap, get only the line-comment pass;
// in a component only inside its script regions (`<script>` elements and
// Astro's leading `---` frontmatter), since in template markup `//` is text
// and `{…}` / `{{ … }}` run.
const COMPONENT_PATH = /\.(?:astro|vue|svelte)$/i;
const ASTRO_FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---/;
// The lexer is linear (about 0.4 ms/KB) and the views are built lazily, only
// for files a pattern already matched raw, so the cap sits well above the
// constant folder's: bundled chunks (vite's `node.js` is 1.4 MB) are the
// files that carry the most JSDoc.
const MAX_CODE_VIEW_BYTES = 4 * 1024 * 1024;
// A whole line that is a `//` comment. It is a comment or text inside a
// multi-line string, never code, unless something on it runs or resumes code:
// a quote, backtick or `*/` that ends a string or an enclosing block comment,
// a `$` that may open a `${…}` substitution in a multi-line template, or a
// brace or `<` that may be JSX (`// {fetch(u)}` as JSX text runs). Such lines
// stay.
const LINE_COMMENT_ONLY = /^[ \t]*\/\/(?:(?!\*\/)[^`'"${}<\n])*$/gm;

function blankLineComments(source: string): string {
  return source.replace(LINE_COMMENT_ONLY, (line) => line.replace(/[^\r\n]/g, " "));
}

function blankComponentScriptComments(path: string, source: string): string {
  const regions: Array<[number, number]> = [];
  if (/\.astro$/i.test(path)) {
    const frontmatter = ASTRO_FRONTMATTER.exec(source);
    if (frontmatter) {
      const start = frontmatter.index + frontmatter[0].indexOf(frontmatter[1]);
      regions.push([start, start + frontmatter[1].length]);
    }
  }
  // indexOf rather than a lazy regex keeps an unterminated `<script>` linear;
  // a tag spelled any other way is simply not blanked.
  for (let open = source.indexOf("<script"); open >= 0;) {
    const start = source.indexOf(">", open) + 1;
    const end = start > 0 ? source.indexOf("</script", start) : -1;
    if (end < 0) break;
    regions.push([start, end]);
    open = source.indexOf("<script", end);
  }
  let out = "";
  let pos = 0;
  for (const [start, end] of regions.sort((a, b) => a[0] - b[0])) {
    if (start < pos) continue;
    out += source.slice(pos, start) + blankLineComments(source.slice(start, end));
    pos = end;
  }
  return out + source.slice(pos);
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
  const javascript = CODE_VIEW_PATH.test(path);
  if (!javascript || source.length > MAX_CODE_VIEW_BYTES) {
    if (!javascript && !COMPONENT_PATH.test(path)) return { code: source, codeNoStrings: source };
    const code = javascript
      ? blankLineComments(source)
      : blankComponentScriptComments(path, source);
    return { code, codeNoStrings: code };
  }
  if (templateMarkersExceed(source, MAX_TEMPLATE_MARKERS)) {
    return { code: source, codeNoStrings: source };
  }
  const comments: JsToken[] = [];
  const literals: JsToken[] = [];
  const budget = { left: Math.max(TEMPLATE_RELEX_BUDGET, 2 * source.length) };
  for (const token of tokenizeJs(source)) {
    if (token.type === "comment") {
      const text = jsTokenText(source, token);
      if (!text.startsWith("<!--") && !text.startsWith("-->")) comments.push(token);
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
  for (const token of tokenizeJs(expression)) {
    const at = exprStart + token.start;
    if (token.type === "punct") {
      const text = jsTokenText(expression, token);
      if (text === "{") braces += 1;
      else if (text === "}") {
        if (braces === 0) {
          out.push(...inner);
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
