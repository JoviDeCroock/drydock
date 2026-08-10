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

// Bracket kinds, tracked so the regex-vs-division decision can see past the
// single preceding token. `)` and `}` are the two closers whose meaning depends
// on what they closed: `if(a)` and a statement block are followed by a
// *statement*, where a leading `/` opens a regex, while a call's `)` and an
// object literal's `}` are values, where `/` divides. Without this, `if(a)/x;y/`
// lexes as a division and everything downstream — folding, line breaking — walks
// into the middle of a regex literal.
type BracketKind = "head-paren" | "paren" | "block" | "object" | "bracket";

interface BracketState {
  brackets: BracketKind[];
  closed: BracketKind | null;
  // `class` bodies are blocks even though the token immediately before `{` is
  // usually the class name or extends expression. Remember the bracket depth at
  // which the class header started so nested calls/objects do not consume it.
  pendingClassDepth: number | null;
}

// Keywords whose parenthesised head is followed by a statement.
const STATEMENT_HEAD_KEYWORDS = new Set(["if", "for", "while", "with"]);

// Keywords after which a `{` opens a block rather than an object literal. Every
// other block form is caught by the preceding punctuator (`)`, `;`, `{`, `}`,
// `=>`) or the pending-class state below; anything else before a `{` — such as
// a property key — leaves it an object literal, the conservative reading that
// keeps `/` a division.
const BLOCK_PRECEDING_KEYWORDS = new Set(["else", "do", "try", "catch", "finally"]);

// Punctuators after which a `{` opens a block: statement boundaries, another
// block's braces, a parenthesised head (`if(a){`, `function f(){`), and an
// arrow body — `x=>({})` is how an arrow returns an object, so `x=>{` is a block.
const BLOCK_PRECEDING_PUNCTUATORS = new Set([";", "{", "}", ")", "=>"]);

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
  // Open brackets, innermost last, and the kind the most recent closer popped.
  // `closed` is only ever read while `prev` is that closer.
  const state: BracketState = { brackets: [], closed: null, pendingClassDepth: null };

  const pushSignificant = (token: JsToken): void => {
    updateBracketState(src, token, prev, state);
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

    if (c === "/" && regexAllowed(src, prev, state.closed)) {
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
      j = scanTemplateExpression(src, j + 2);
      continue;
    }
    j += 1;
  }
  return j;
}

// Scan one `${ … }` body with the same literal boundaries as the outer lexer.
// Counting braces character-by-character is not enough: `}` and backticks are
// ordinary data inside comments and regex literals, and misreading either can
// make the formatter insert newlines into a nested template's actual contents.
function scanTemplateExpression(src: string, i: number): number {
  const n = src.length;
  const state: BracketState = { brackets: [], closed: null, pendingClassDepth: null };
  let depth = 1;
  let prev: JsToken | undefined;
  let j = i;

  const pushSignificant = (token: JsToken): void => {
    updateBracketState(src, token, prev, state);
    prev = token;
  };

  while (j < n) {
    const c = src[j];
    if (isWhitespace(c)) {
      j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j += 2;
      while (j < n && src[j] !== "\n") j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j += 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(n, j + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      const start = j;
      const scanned = scanString(src, j);
      j = scanned.end;
      pushSignificant({ type: "string", start, end: j, value: scanned.value });
      continue;
    }
    if (c === "`") {
      const start = j;
      j = scanTemplate(src, j);
      pushSignificant({ type: "template", start, end: j });
      continue;
    }
    if (c === "/" && regexAllowed(src, prev, state.closed)) {
      const start = j;
      j = scanRegex(src, j);
      pushSignificant({ type: "regex", start, end: j });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[j + 1]))) {
      const start = j;
      j = scanNumber(src, j);
      pushSignificant({ type: "number", start, end: j });
      continue;
    }
    if (isIdentStart(c)) {
      const start = j;
      j += 1;
      while (j < n && isIdentPart(src[j])) j += 1;
      pushSignificant({ type: "ident", start, end: j });
      continue;
    }

    const start = j;
    j += matchPunctuator(src, j);
    const token: JsToken = { type: "punct", start, end: j };
    const text = jsTokenText(src, token);
    if (text === "}" && depth === 1) return j;
    if (text === "{") depth += 1;
    else if (text === "}") depth -= 1;
    pushSignificant(token);
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

function updateBracketState(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
): void {
  const text = jsTokenText(src, token);
  if (token.type === "ident") {
    if (
      text === "class" &&
      !(prev?.type === "punct" && [".", "?."].includes(jsTokenText(src, prev)))
    ) {
      state.pendingClassDepth = state.brackets.length;
    }
    return;
  }
  if (token.type !== "punct") return;

  if (
    state.pendingClassDepth === state.brackets.length &&
    (text === ":" || text === ";" || text === "=")
  ) {
    // `class` was an object key or malformed/truncated header, not a class
    // declaration/expression whose body is still ahead.
    state.pendingClassDepth = null;
  }
  if (text === "(") {
    state.brackets.push(isStatementHead(src, prev) ? "head-paren" : "paren");
  } else if (text === "[") {
    state.brackets.push("bracket");
  } else if (text === "{") {
    const classBody = state.pendingClassDepth === state.brackets.length;
    state.brackets.push(classBody || opensBlock(src, prev) ? "block" : "object");
    if (classBody) state.pendingClassDepth = null;
  } else if (text === ")" || text === "]" || text === "}") {
    state.closed = state.brackets.pop() ?? null;
  }
}

function regexAllowed(src: string, prev: JsToken | undefined, closed: BracketKind | null): boolean {
  if (!prev) return true;
  if (prev.type === "punct") {
    const t = jsTokenText(src, prev);
    // `if(a)/re/.test(a)` and `if(a){b()}/re/.test(a)` both continue with a
    // statement, so the `/` opens a regex; `f(a)/2` and `({}).x/2` are values.
    if (t === ")") return closed === "head-paren";
    if (t === "}") return closed === "block";
    return t !== "]";
  }
  if (prev.type === "ident") return REGEX_PRECEDING_KEYWORDS.has(jsTokenText(src, prev));
  return false; // value-producing token -> division
}

// `(` of `if (…)`, `for (…)`, `while (…)`, `with (…)` — the forms whose closing
// `)` is followed by a statement rather than by more of an expression.
function isStatementHead(src: string, prev: JsToken | undefined): boolean {
  return prev?.type === "ident" && STATEMENT_HEAD_KEYWORDS.has(jsTokenText(src, prev));
}

// Whether a `{` opens a statement block (`if(a){`, `else{`, `function f(){`) as
// opposed to an object literal (`={`, `({`, `,{`, `return{`).
function opensBlock(src: string, prev: JsToken | undefined): boolean {
  if (!prev) return true; // a program starting with `{` starts with a block
  const text = jsTokenText(src, prev);
  if (prev.type === "punct") return BLOCK_PRECEDING_PUNCTUATORS.has(text);
  if (prev.type === "ident") return BLOCK_PRECEDING_KEYWORDS.has(text);
  return false;
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
