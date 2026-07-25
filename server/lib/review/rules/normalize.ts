// Constant-folding normalization pre-pass for the deterministic code scanner.
//
// The capability rules in `scripts.ts` are literal-regex based, so identifiers
// assembled at runtime slip past them entirely: `['chi','ld_pro','cess'].join('')`,
// `'re' + 'quire'`, and `globalThis['proc' + 'ess']` never present a contiguous
// `child_process` / `require` / `process` token to a regex. This module folds
// those constructs back into their literal form *before* the regex set runs, so
// the existing rules see `"child_process"`, `globalThis.require`, etc.
//
// It deliberately uses a tokenizer rather than text substitution: folding must
// never reach into comments, string bodies, template literals, or regex literals
// (where a `'a'+'b'` is data, not assembly). A full AST would catch more (data
// flow, variable propagation) but is the heavier variant that belongs on the
// gated-target path; this lightweight pass is cheap enough for the staged path.
//
// Line numbers are preserved exactly: every fold replaces a single-line source
// span (folds spanning a newline are skipped) and folded string literals
// re-encode control characters, so `firstMatchingLine` keeps pointing at the
// real line in the original file.

// Samples are bounded to 64KB by the sandbox; this is a safety valve only.
const MAX_NORMALIZE_BYTES = 512 * 1024;
// Folds simplify monotonically (shorter text, fewer tokens), so a handful of
// passes reaches a fixpoint. `globalThis['re' + 'quire']` needs two: concat then
// member access.
const MAX_PASSES = 6;

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Keywords after which a `/` opens a regex literal rather than a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
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
]);

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

// Multi-character punctuators, longest first, so `++`/`+=` are never mistaken for
// a binary `+` concat operator and `...`/`?.` stay intact.
const PUNCTUATORS = [
  ">>>=",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "...",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

type TokenType = "ws" | "comment" | "string" | "template" | "regex" | "number" | "ident" | "punct";

interface Token {
  type: TokenType;
  start: number;
  end: number;
  // Decoded logical value; set on string tokens only.
  value?: string;
}

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
  const sig = tokenize(src).filter((t) => t.type !== "ws" && t.type !== "comment");
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
function tryConcatFold(src: string, sig: Token[], k: number): Replacement | null {
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
function tryJoinFold(src: string, sig: Token[], k: number): Replacement | null {
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
function tryMemberFold(src: string, sig: Token[], k: number): Replacement | null {
  if (!isMemberBase(src, sig[k - 1])) return null;
  if (sig[k + 1]?.type !== "string" || !isPunct(src, sig[k + 2], "]")) return null;
  const name = sig[k + 1].value ?? "";
  if (!IDENTIFIER_RE.test(name)) return null;
  const start = sig[k].start;
  const end = sig[k + 2].end;
  if (spansNewline(src, start, end)) return null;
  return { start, end, text: `.${name}`, last: k + 2 };
}

function isMemberBase(src: string, token: Token | undefined): boolean {
  if (!token) return false;
  if (token.type === "ident") return !NON_BASE_KEYWORDS.has(text(src, token));
  if (token.type === "punct") {
    const t = text(src, token);
    return t === ")" || t === "]";
  }
  return token.type === "string" || token.type === "template" || token.type === "number";
}

// --- Tokenizer ------------------------------------------------------------

function tokenize(src: string): Token[] {
  const n = src.length;
  const tokens: Token[] = [];
  let prev: Token | undefined;
  let i = 0;

  const pushSignificant = (token: Token): void => {
    tokens.push(token);
    prev = token;
  };

  while (i < n) {
    const c = src[i];

    if (isWhitespace(c)) {
      const start = i;
      while (i < n && isWhitespace(src[i])) i += 1;
      tokens.push({ type: "ws", start, end: i });
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i += 1;
      tokens.push({ type: "comment", start, end: i });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2);
      tokens.push({ type: "comment", start, end: i });
      continue;
    }

    if (c === "'" || c === '"') {
      const start = i;
      const { end, value } = scanString(src, i);
      i = end;
      pushSignificant({ type: "string", start, end: i, value });
      continue;
    }

    if (c === "`") {
      const start = i;
      i = scanTemplate(src, i);
      pushSignificant({ type: "template", start, end: i });
      continue;
    }

    if (c === "/" && regexAllowed(src, prev)) {
      const start = i;
      i = scanRegex(src, i);
      pushSignificant({ type: "regex", start, end: i });
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const start = i;
      i = scanNumber(src, i);
      pushSignificant({ type: "number", start, end: i });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(src[i])) i += 1;
      pushSignificant({ type: "ident", start, end: i });
      continue;
    }

    const start = i;
    i += matchPunctuator(src, i);
    pushSignificant({ type: "punct", start, end: i });
  }

  return tokens;
}

function scanString(src: string, i: number): { end: number; value: string } {
  const n = src.length;
  const quote = src[i];
  let j = i + 1;
  let value = "";
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      const { text: decoded, len } = decodeEscape(src, j);
      value += decoded;
      j += len;
      continue;
    }
    if (c === quote) {
      j += 1;
      break;
    }
    if (c === "\n") break; // unterminated single-line string
    value += c;
    j += 1;
  }
  return { end: j, value };
}

function scanTemplate(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") {
      j += 2;
      let depth = 1;
      while (j < n && depth > 0) {
        const cc = src[j];
        if (cc === "\\") {
          j += 2;
          continue;
        }
        if (cc === "`") {
          j = scanTemplate(src, j);
          continue;
        }
        if (cc === "'" || cc === '"') {
          j = scanString(src, j).end;
          continue;
        }
        if (cc === "{") depth += 1;
        else if (cc === "}") depth -= 1;
        j += 1;
      }
      continue;
    }
    j += 1;
  }
  return j;
}

function scanRegex(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return j; // unterminated; bail
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j += 1;
      break;
    }
    j += 1;
  }
  while (j < n && /[a-z]/i.test(src[j])) j += 1;
  return j;
}

function scanNumber(src: string, i: number): number {
  const n = src.length;
  let j = i;
  if (src[j] === "0" && /[xXbBoO]/.test(src[j + 1] ?? "")) {
    j += 2;
    while (j < n && /[0-9a-fA-F_]/.test(src[j])) j += 1;
    if (src[j] === "n") j += 1;
    return j;
  }
  while (j < n && /[0-9_]/.test(src[j])) j += 1;
  if (src[j] === ".") {
    j += 1;
    while (j < n && /[0-9_]/.test(src[j])) j += 1;
  }
  if (/[eE]/.test(src[j] ?? "")) {
    j += 1;
    if (src[j] === "+" || src[j] === "-") j += 1;
    while (j < n && /[0-9_]/.test(src[j])) j += 1;
  }
  if (src[j] === "n") j += 1;
  return j;
}

function decodeEscape(src: string, p: number): { text: string; len: number } {
  const c = src[p + 1];
  switch (c) {
    case "n":
      return { text: "\n", len: 2 };
    case "t":
      return { text: "\t", len: 2 };
    case "r":
      return { text: "\r", len: 2 };
    case "b":
      return { text: "\b", len: 2 };
    case "f":
      return { text: "\f", len: 2 };
    case "v":
      return { text: "\v", len: 2 };
    case "0":
      return isDigit(src[p + 2]) ? { text: "0", len: 2 } : { text: "\0", len: 2 };
    case "x": {
      const hex = src.slice(p + 2, p + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { text: String.fromCharCode(parseInt(hex, 16)), len: 4 };
      }
      return { text: "x", len: 2 };
    }
    case "u": {
      if (src[p + 2] === "{") {
        const close = src.indexOf("}", p + 3);
        if (close !== -1) {
          const hex = src.slice(p + 3, close);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            try {
              return { text: String.fromCodePoint(parseInt(hex, 16)), len: close - p + 1 };
            } catch {
              // out-of-range code point; fall through
            }
          }
        }
        return { text: "u", len: 2 };
      }
      const hex = src.slice(p + 2, p + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { text: String.fromCharCode(parseInt(hex, 16)), len: 6 };
      }
      return { text: "u", len: 2 };
    }
    case "\n":
      return { text: "", len: 2 }; // line continuation
    case "\r":
      return src[p + 2] === "\n" ? { text: "", len: 3 } : { text: "", len: 2 };
    case undefined:
      return { text: "", len: 1 }; // trailing backslash
    default:
      return { text: c, len: 2 }; // \' \" \` \\ \/ and anything else
  }
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

function matchPunctuator(src: string, i: number): number {
  for (const op of PUNCTUATORS) {
    if (src.startsWith(op, i)) return op.length;
  }
  return 1;
}

function regexAllowed(src: string, prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.type === "punct") {
    const t = text(src, prev);
    return t !== ")" && t !== "]" && t !== "}";
  }
  if (prev.type === "ident") return REGEX_PRECEDING_KEYWORDS.has(text(src, prev));
  return false; // value-producing token -> division
}

function spansNewline(src: string, start: number, end: number): boolean {
  const span = src.slice(start, end);
  return span.includes("\n") || span.includes("\r");
}

function text(src: string, token: Token): string {
  return src.slice(token.start, token.end);
}

function isPunct(src: string, token: Token | undefined, value: string): boolean {
  return token?.type === "punct" && text(src, token) === value;
}

function isIdent(src: string, token: Token | undefined, value: string): boolean {
  return token?.type === "ident" && text(src, token) === value;
}

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
