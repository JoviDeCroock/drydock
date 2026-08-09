// A dependency-free, non-executing JavaScript lexer.
//
// It exists because two very different consumers need the same "where does a
// token start and end" answer over untrusted package bytes, and both of them
// must get regex-vs-division, template interpolation, and comment boundaries
// right or they corrupt what a reviewer sees:
//
//   - `review/rules/normalize.ts` constant-folds assembled identifiers before
//     the deterministic regex set runs, and must never fold inside a string,
//     comment, or regex literal;
//   - `src/components/format-source.ts` re-flows minified one-liners for the
//     diff view, and must never insert a line break inside a token.
//
// It is a lexer, not a parser: no AST, no evaluation, and nothing here ever
// executes package code. Malformed input is scanned to EOF rather than thrown
// on — package bytes are hostile evidence, and a lexer that throws would blank
// a review surface.

type JsTokenType =
  | "ws"
  | "comment"
  | "string"
  | "template"
  | "regex"
  | "number"
  | "ident"
  | "punct";

export interface JsToken {
  type: JsTokenType;
  start: number;
  end: number;
  // Decoded logical value; set on string tokens only.
  value?: string;
}

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

export function tokenizeJs(src: string): JsToken[] {
  const n = src.length;
  const tokens: JsToken[] = [];
  let prev: JsToken | undefined;
  let i = 0;

  const pushSignificant = (token: JsToken): void => {
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

export function jsTokenText(src: string, token: JsToken): string {
  return src.slice(token.start, token.end);
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

function matchPunctuator(src: string, i: number): number {
  for (const op of PUNCTUATORS) {
    if (src.startsWith(op, i)) return op.length;
  }
  return 1;
}

function regexAllowed(src: string, prev: JsToken | undefined): boolean {
  if (!prev) return true;
  if (prev.type === "punct") {
    const t = jsTokenText(src, prev);
    return t !== ")" && t !== "]" && t !== "}";
  }
  if (prev.type === "ident") return REGEX_PRECEDING_KEYWORDS.has(jsTokenText(src, prev));
  return false; // value-producing token -> division
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
