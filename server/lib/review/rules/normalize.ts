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

// Hard ceiling on what the folder will tokenize. Samples are NOT bounded by the
// sandbox any more — issue #191 made staged and public parses retain whole file
// bodies — so this is real enforcement, not a safety valve. The regex pass that
// consumes the folded text bounds itself separately (see
// `platform/text-utils.ts`); a file over this size is scanned unfolded rather
// than tokenized.
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
