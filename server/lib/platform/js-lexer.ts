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
type BracketKind = "head-paren" | "paren" | "block" | "value-block" | "object" | "bracket";

interface BracketState {
  brackets: BracketKind[];
  closed: BracketKind | null;
  // Class/interface/enum/namespace bodies are blocks even though the token
  // immediately before `{` is usually the declaration name or extends
  // expression. Remember the bracket depth at which the header started so
  // nested calls/objects do not consume it.
  pendingDeclarationDepth: number | null;
  // Function/class expressions end in blocks that produce values. Keep every
  // pending depth so a nested expression in a parameter/default/extends clause
  // cannot overwrite the outer body's marker.
  pendingValueBodyDepths: number[];
  // TypeScript permits a return annotation between a function/method's `)` and
  // body. Without remembering the annotation's colon, `(): void {}` looks like
  // an object literal and a following regex is consequently read as division.
  pendingTypedBodyDepth: number | null;
  // A `case` expression may contain nested objects and conditional expressions
  // before its terminating `:`. Keep the switch-block depth so that colon can
  // be distinguished from an object property or conditional-expression colon.
  pendingCaseDepth: number | null;
  conditionalDepths: number[];
  // Whether the immediately preceding identifier can be a statement label, and
  // whether the immediately preceding colon ended a label/case clause. These
  // are the contexts where `{` opens a block even though `:` is also used by
  // object literals and conditional expressions.
  labelCandidate: boolean;
  statementColon: boolean;
  // Type aliases are declarations even though their right-hand side may end in
  // a value-shaped token (`type T = string`) or an object-shaped brace. Keep the
  // declaration depth so an object-type body is classified as a declaration
  // block rather than an object value.
  pendingTypeAliasDepth: number | null;
  pendingTypeAliasHasName: boolean;
  pendingTypeAliasObjectDepth: number | null;
  // Once `type Name =` has been seen, remember the declaration until its
  // terminating line/semicolon. A slash after that line starts a regex even
  // when the aliased type ends in an identifier or a composite object type.
  typeAliasBodyDepth: number | null;
  typeAliasBodySawToken: boolean;
  // Static import/export declarations are statement-shaped even when their last
  // token is a string or `}`. These fields let a slash after their terminating
  // line open a regex without mistaking dynamic import() or export default.
  moduleDeclarationDepth: number | null;
  moduleDeclarationKind: "import" | "export" | null;
  moduleDeclarationSawSource: boolean;
  moduleDeclarationClosedClause: boolean;
  // Export declarations can also contain object/class/function initializers.
  // Only a brace opened directly by `export` (or `export type`) is an export
  // clause whose closing brace terminates the module declaration.
  moduleExportClauseDepth: number | null;
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

const TYPE_BLOCK_DECLARATION_KEYWORDS = new Set(["enum", "interface", "module", "namespace"]);
const DECLARATION_PREFIX_KEYWORDS = new Set(["const", "declare", "export"]);
const TYPE_ALIAS_PREFIX_KEYWORDS = new Set(["declare", "export"]);

// A line terminator is syntactically significant after these statements. A
// following slash starts a new regex expression; it cannot continue the prior
// statement as division. `return`/`yield`/`await` already live in
// REGEX_PRECEDING_KEYWORDS because they also accept a regex without a newline.
const LINE_TERMINATED_REGEX_KEYWORDS = new Set(["break", "continue", "debugger"]);

// While a typed body is pending, these punctuators introduce a type literal
// rather than the implementation body. The pending marker survives that nested
// object and is consumed by the next brace at the annotation's original depth.
const TYPE_LITERAL_PRECEDING_PUNCTUATORS = new Set([":", "<", "(", "?", "|", "&", "=", ",", "=>"]);

// Keywords after which a `/` opens a regex literal rather than a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "default",
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "extends",
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
  let beforePrev: JsToken | undefined;
  let lineTerminatorBefore = false;
  let lineTerminatorBeforePrev = false;
  let prevEndsModuleDeclaration = false;
  let i = 0;
  // Open brackets, innermost last, and the kind the most recent closer popped.
  // `closed` is only ever read while `prev` is that closer.
  const state = createBracketState();

  const pushSignificant = (token: JsToken): void => {
    updateBracketState(src, token, prev, beforePrev, state, lineTerminatorBefore);
    tokens.push(token);
    beforePrev = prev;
    prev = token;
    lineTerminatorBeforePrev = lineTerminatorBefore;
    prevEndsModuleDeclaration = tokenEndsModuleDeclaration(src, token, state);
    lineTerminatorBefore = false;
  };

  while (i < n) {
    const c = src[i];

    if (isWhitespace(c)) {
      const start = i;
      while (i < n && isWhitespace(src[i])) {
        if (isLineTerminator(src[i])) lineTerminatorBefore = true;
        i += 1;
      }
      tokens.push({ type: "ws", start, end: i });
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && !isLineTerminator(src[i])) i += 1;
      tokens.push({ type: "comment", start, end: i });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2);
      if (containsLineTerminator(src, start, i)) lineTerminatorBefore = true;
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

    if (
      c === "/" &&
      regexAllowed(
        src,
        prev,
        beforePrev,
        state.closed,
        lineTerminatorBefore,
        lineTerminatorBeforePrev,
        prevEndsModuleDeclaration,
        typeAliasEndsBeforeNextToken(state, lineTerminatorBefore),
      )
    ) {
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

    const identifierStart = scanIdentifierUnit(src, i, true);
    if (identifierStart) {
      const start = i;
      i = identifierStart.end;
      while (i < n) {
        const part = scanIdentifierUnit(src, i, false);
        if (!part) break;
        i = part.end;
      }
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
    // U+2028/U+2029 are valid unescaped string contents in modern ECMAScript
    // (the JSON-superset grammar). Only physical CR/LF terminate a quoted string.
    if (c === "\n" || c === "\r") break; // unterminated single-line string
    value += c;
    j += 1;
  }
  return { end: j, value };
}

interface TemplateLiteralFrame {
  kind: "template";
  start: number;
}

interface TemplateExpressionFrame {
  kind: "expression";
  depth: number;
  state: BracketState;
  prev?: JsToken;
  beforePrev?: JsToken;
  lineTerminatorBefore: boolean;
  lineTerminatorBeforePrev: boolean;
  prevEndsModuleDeclaration: boolean;
}

type TemplateScanFrame = TemplateLiteralFrame | TemplateExpressionFrame;

// Scan a template and every nested `${...}` / template with an explicit stack.
// Package bytes can nest these deeply enough to overflow recursive scanners
// while still fitting comfortably inside the retained-sample cap.
function scanTemplate(src: string, i: number): number {
  const n = src.length;
  const frames: TemplateScanFrame[] = [{ kind: "template", start: i }];
  let j = i + 1;
  while (j < n) {
    const frame = frames[frames.length - 1];
    const c = src[j];
    if (frame.kind === "template") {
      if (c === "\\") {
        j = Math.min(n, j + 2);
        continue;
      }
      if (c === "`") {
        j += 1;
        frames.pop();
        const parent = frames[frames.length - 1];
        if (!parent) return j;
        if (parent.kind === "expression") {
          pushTemplateExpressionToken(src, parent, {
            type: "template",
            start: frame.start,
            end: j,
          });
        }
        continue;
      }
      if (c === "$" && src[j + 1] === "{") {
        frames.push({
          kind: "expression",
          depth: 1,
          state: createBracketState(),
          lineTerminatorBefore: false,
          lineTerminatorBeforePrev: false,
          prevEndsModuleDeclaration: false,
        });
        j += 2;
        continue;
      }
      j += 1;
      continue;
    }

    if (isWhitespace(c)) {
      if (isLineTerminator(c)) frame.lineTerminatorBefore = true;
      j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j += 2;
      while (j < n && !isLineTerminator(src[j])) j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const start = j;
      j += 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(n, j + 2);
      if (containsLineTerminator(src, start, j)) frame.lineTerminatorBefore = true;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = j;
      const scanned = scanString(src, j);
      j = scanned.end;
      pushTemplateExpressionToken(src, frame, {
        type: "string",
        start,
        end: j,
        value: scanned.value,
      });
      continue;
    }
    if (c === "`") {
      frames.push({ kind: "template", start: j });
      j += 1;
      continue;
    }
    if (
      c === "/" &&
      regexAllowed(
        src,
        frame.prev,
        frame.beforePrev,
        frame.state.closed,
        frame.lineTerminatorBefore,
        frame.lineTerminatorBeforePrev,
        frame.prevEndsModuleDeclaration,
        typeAliasEndsBeforeNextToken(frame.state, frame.lineTerminatorBefore),
      )
    ) {
      const start = j;
      j = scanRegex(src, j);
      pushTemplateExpressionToken(src, frame, { type: "regex", start, end: j });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[j + 1]))) {
      const start = j;
      j = scanNumber(src, j);
      pushTemplateExpressionToken(src, frame, { type: "number", start, end: j });
      continue;
    }
    const identifierStart = scanIdentifierUnit(src, j, true);
    if (identifierStart) {
      const start = j;
      j = identifierStart.end;
      while (j < n) {
        const part = scanIdentifierUnit(src, j, false);
        if (!part) break;
        j = part.end;
      }
      pushTemplateExpressionToken(src, frame, { type: "ident", start, end: j });
      continue;
    }

    const start = j;
    j += matchPunctuator(src, j);
    const token: JsToken = { type: "punct", start, end: j };
    const text = jsTokenText(src, token);
    if (text === "}" && frame.depth === 1) {
      frames.pop();
      continue;
    }
    if (text === "{") frame.depth += 1;
    else if (text === "}") frame.depth -= 1;
    pushTemplateExpressionToken(src, frame, token);
  }

  return j;
}

function pushTemplateExpressionToken(
  src: string,
  frame: TemplateExpressionFrame,
  token: JsToken,
): void {
  updateBracketState(
    src,
    token,
    frame.prev,
    frame.beforePrev,
    frame.state,
    frame.lineTerminatorBefore,
  );
  frame.beforePrev = frame.prev;
  frame.prev = token;
  frame.lineTerminatorBeforePrev = frame.lineTerminatorBefore;
  frame.prevEndsModuleDeclaration = tokenEndsModuleDeclaration(src, token, frame.state);
  frame.lineTerminatorBefore = false;
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
    if (isLineTerminator(c)) return j; // unterminated; bail
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
    case "\u2028":
    case "\u2029":
      return { text: "", len: 2 }; // line continuation
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
  beforePrev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): void {
  const text = jsTokenText(src, token);
  if (
    state.typeAliasBodyDepth === state.brackets.length &&
    state.typeAliasBodySawToken &&
    lineTerminatorBefore &&
    !continuesTypeAliasAcrossLine(src, token, prev)
  ) {
    clearTypeAliasBody(state);
  }
  const followsModuleDeclaration =
    Boolean(state.moduleDeclarationKind) &&
    lineTerminatorBefore &&
    tokenEndsModuleDeclaration(src, prev, state) &&
    !continuesModuleDeclaration(src, token);
  if (followsModuleDeclaration) clearModuleDeclaration(state);
  if (token.type === "ident") {
    const statementStart = followsModuleDeclaration || canStartStatement(src, prev, state);
    if (state.pendingTypeAliasDepth === state.brackets.length && text !== "type") {
      state.pendingTypeAliasHasName = true;
    }
    state.labelCandidate = statementStart && text !== "case" && text !== "default";
    state.statementColon = false;
    if ((text === "case" || text === "default") && statementStart) {
      state.pendingCaseDepth = state.brackets.length;
    }
    if ((text === "import" || text === "export") && statementStart) {
      state.moduleDeclarationDepth = state.brackets.length;
      state.moduleDeclarationKind = text;
      state.moduleDeclarationSawSource = false;
      state.moduleDeclarationClosedClause = false;
      state.moduleExportClauseDepth = null;
    } else if (
      state.moduleDeclarationKind === "export" &&
      state.moduleDeclarationDepth === state.brackets.length &&
      text === "default"
    ) {
      clearModuleDeclaration(state);
    }
    const blockDeclaration =
      text === "class" ||
      (TYPE_BLOCK_DECLARATION_KEYWORDS.has(text) &&
        (statementStart ||
          (prev?.type === "ident" && DECLARATION_PREFIX_KEYWORDS.has(jsTokenText(src, prev)))));
    if (
      blockDeclaration &&
      !(prev?.type === "punct" && [".", "?."].includes(jsTokenText(src, prev)))
    ) {
      state.pendingDeclarationDepth = state.brackets.length;
      if (text === "class" && isClassExpression(src, prev, statementStart)) {
        state.pendingValueBodyDepths.push(state.brackets.length);
      }
    }
    if (
      text === "function" &&
      !(prev?.type === "punct" && [".", "?."].includes(jsTokenText(src, prev)))
    ) {
      if (isFunctionExpression(src, prev, beforePrev, state, statementStart)) {
        state.pendingValueBodyDepths.push(state.brackets.length);
      }
    }
    const typeAliasDeclaration =
      text === "type" &&
      (statementStart ||
        (prev?.type === "ident" && TYPE_ALIAS_PREFIX_KEYWORDS.has(jsTokenText(src, prev))));
    if (typeAliasDeclaration) {
      state.pendingTypeAliasDepth = state.brackets.length;
      state.pendingTypeAliasHasName = false;
      state.pendingTypeAliasObjectDepth = null;
      clearTypeAliasBody(state);
    }
    if (state.pendingTypeAliasObjectDepth === state.brackets.length) {
      state.pendingTypeAliasObjectDepth = null;
    }
    markTypeAliasBodyToken(state);
    return;
  }
  if (token.type !== "punct") {
    if (
      token.type === "string" &&
      state.moduleDeclarationKind &&
      state.moduleDeclarationDepth === state.brackets.length
    ) {
      state.moduleDeclarationSawSource = true;
    }
    if (state.pendingTypeAliasObjectDepth === state.brackets.length) {
      state.pendingTypeAliasObjectDepth = null;
    }
    state.labelCandidate = false;
    state.statementColon = false;
    markTypeAliasBodyToken(state);
    return;
  }

  const followsStatementColon = state.statementColon;
  state.statementColon = false;

  if (state.pendingTypeAliasDepth === state.brackets.length) {
    if (text === "=") {
      state.pendingTypeAliasObjectDepth = state.pendingTypeAliasHasName
        ? state.brackets.length
        : null;
      state.typeAliasBodyDepth = state.pendingTypeAliasHasName ? state.brackets.length : null;
      state.typeAliasBodySawToken = false;
      state.pendingTypeAliasDepth = null;
      state.pendingTypeAliasHasName = false;
    } else if (!state.pendingTypeAliasHasName) {
      // `type.foo`, `type()`, and a `type:` label are ordinary JavaScript, not
      // aliases. An alias name is always the next significant identifier.
      state.pendingTypeAliasDepth = null;
    }
  }
  if (state.pendingTypeAliasObjectDepth === state.brackets.length && text !== "=" && text !== "{") {
    state.pendingTypeAliasObjectDepth = null;
  }

  if (
    state.pendingDeclarationDepth === state.brackets.length &&
    (text === ":" || text === ";" || text === "=")
  ) {
    // The keyword was an object key or malformed/truncated header, not a
    // declaration whose body is still ahead.
    state.pendingDeclarationDepth = null;
  }
  if (text === ";") {
    state.pendingValueBodyDepths = state.pendingValueBodyDepths.filter(
      (depth) => depth !== state.brackets.length,
    );
    clearTypeAliasBody(state);
  }
  if (state.pendingTypedBodyDepth === state.brackets.length && text === ";") {
    // A method signature or truncated annotation has no implementation body.
    state.pendingTypedBodyDepth = null;
  }
  if (text === "(") {
    if (
      state.moduleDeclarationKind === "import" &&
      state.moduleDeclarationDepth === state.brackets.length &&
      !state.moduleDeclarationSawSource &&
      !state.moduleDeclarationClosedClause
    ) {
      clearModuleDeclaration(state); // dynamic import(...)
    }
    state.brackets.push(isStatementHead(src, prev, beforePrev) ? "head-paren" : "paren");
  } else if (text === "[") {
    state.brackets.push("bracket");
  } else if (text === "{") {
    if (
      state.moduleDeclarationKind === "export" &&
      state.moduleDeclarationDepth === state.brackets.length &&
      (isIdentText(src, prev, "export") ||
        (isIdentText(src, prev, "type") && isIdentText(src, beforePrev, "export")))
    ) {
      state.moduleExportClauseDepth = state.brackets.length;
    }
    const declarationBody = state.pendingDeclarationDepth === state.brackets.length;
    const valueBodyIndex = state.pendingValueBodyDepths.lastIndexOf(state.brackets.length);
    const valueBody =
      valueBodyIndex !== -1 &&
      !(prev?.type === "punct" && TYPE_LITERAL_PRECEDING_PUNCTUATORS.has(jsTokenText(src, prev)));
    const typeAliasObject = state.pendingTypeAliasObjectDepth === state.brackets.length;
    const typedBody =
      state.pendingTypedBodyDepth === state.brackets.length &&
      !(prev?.type === "punct" && TYPE_LITERAL_PRECEDING_PUNCTUATORS.has(jsTokenText(src, prev)));
    state.brackets.push(
      valueBody
        ? "value-block"
        : declarationBody ||
            typeAliasObject ||
            typedBody ||
            followsStatementColon ||
            followsModuleDeclaration ||
            opensBlock(src, prev)
          ? "block"
          : "object",
    );
    if (declarationBody) {
      state.pendingDeclarationDepth = null;
    }
    if (valueBody) state.pendingValueBodyDepths.splice(valueBodyIndex, 1);
    if (typeAliasObject) state.pendingTypeAliasObjectDepth = null;
    if (typedBody) state.pendingTypedBodyDepth = null;
  } else if (text === ")" || text === "]" || text === "}") {
    state.closed = state.brackets.pop() ?? null;
    if (
      text === "}" &&
      state.moduleDeclarationKind &&
      state.moduleDeclarationDepth === state.brackets.length &&
      (state.moduleDeclarationKind === "import" ||
        state.moduleExportClauseDepth === state.brackets.length)
    ) {
      state.moduleDeclarationClosedClause = true;
      state.moduleExportClauseDepth = null;
    }
  } else if (
    text === "." &&
    state.moduleDeclarationKind === "import" &&
    state.moduleDeclarationDepth === state.brackets.length &&
    !state.moduleDeclarationSawSource &&
    !state.moduleDeclarationClosedClause
  ) {
    clearModuleDeclaration(state); // import.meta
  } else if (text === ";") {
    clearModuleDeclaration(state);
  } else if (text === "?") {
    state.conditionalDepths.push(state.brackets.length);
  } else if (text === ":") {
    const conditionalDepth = state.conditionalDepths[state.conditionalDepths.length - 1];
    if (conditionalDepth === state.brackets.length) {
      state.conditionalDepths.pop();
    } else if (state.labelCandidate || state.pendingCaseDepth === state.brackets.length) {
      state.statementColon = true;
      state.pendingCaseDepth = null;
    } else if (
      prev?.type === "punct" &&
      jsTokenText(src, prev) === ")" &&
      state.closed === "paren"
    ) {
      state.pendingTypedBodyDepth = state.brackets.length;
    }
  }
  state.labelCandidate = false;
  if (text !== "=") markTypeAliasBodyToken(state);
}

function createBracketState(): BracketState {
  return {
    brackets: [],
    closed: null,
    pendingDeclarationDepth: null,
    pendingValueBodyDepths: [],
    pendingTypedBodyDepth: null,
    pendingCaseDepth: null,
    conditionalDepths: [],
    labelCandidate: false,
    statementColon: false,
    pendingTypeAliasDepth: null,
    pendingTypeAliasHasName: false,
    pendingTypeAliasObjectDepth: null,
    typeAliasBodyDepth: null,
    typeAliasBodySawToken: false,
    moduleDeclarationDepth: null,
    moduleDeclarationKind: null,
    moduleDeclarationSawSource: false,
    moduleDeclarationClosedClause: false,
    moduleExportClauseDepth: null,
  };
}

function typeAliasEndsBeforeNextToken(state: BracketState, lineTerminatorBefore: boolean): boolean {
  return (
    lineTerminatorBefore &&
    state.typeAliasBodySawToken &&
    state.typeAliasBodyDepth === state.brackets.length
  );
}

const TYPE_ALIAS_LINE_CONTINUATION_PUNCTUATORS = new Set([
  "|",
  "&",
  "[",
  ".",
  "<",
  ">",
  "?",
  ":",
  ",",
  "(",
  ")",
  "{",
  "}",
  "=>",
]);

const TYPE_ALIAS_OPERAND_KEYWORDS = new Set([
  "extends",
  "infer",
  "keyof",
  "new",
  "readonly",
  "typeof",
]);

function continuesTypeAliasAcrossLine(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
): boolean {
  if (
    token.type === "punct" &&
    TYPE_ALIAS_LINE_CONTINUATION_PUNCTUATORS.has(jsTokenText(src, token))
  ) {
    return true;
  }
  if (token.type === "ident" && jsTokenText(src, token) === "extends") return true;
  return prev?.type === "ident" && TYPE_ALIAS_OPERAND_KEYWORDS.has(jsTokenText(src, prev));
}

function markTypeAliasBodyToken(state: BracketState): void {
  if (state.typeAliasBodyDepth !== null) state.typeAliasBodySawToken = true;
}

function clearTypeAliasBody(state: BracketState): void {
  state.typeAliasBodyDepth = null;
  state.typeAliasBodySawToken = false;
}

function canStartStatement(src: string, prev: JsToken | undefined, state: BracketState): boolean {
  const top = state.brackets[state.brackets.length - 1];
  if (top !== undefined && top !== "block") return false;
  if (!prev) return true;
  const text = jsTokenText(src, prev);
  if (prev.type === "ident") return text === "else" || text === "do";
  if (prev.type !== "punct") return false;
  if (text === "{") return top === "block";
  if (text === ";") return true;
  if (text === ":") return state.statementColon;
  if (text === ")") return state.closed === "head-paren";
  if (text === "}") return state.closed === "block";
  return false;
}

function regexAllowed(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  closed: BracketKind | null,
  lineTerminatorBefore: boolean,
  lineTerminatorBeforePrev: boolean,
  prevEndsModuleDeclaration: boolean,
  prevEndsTypeAliasDeclaration: boolean,
): boolean {
  if (!prev) return true;
  if (lineTerminatorBefore && prevEndsModuleDeclaration) return true;
  if (prevEndsTypeAliasDeclaration) return true;
  if (prev.type === "punct") {
    const t = jsTokenText(src, prev);
    // `if(a)/re/.test(a)` and `if(a){b()}/re/.test(a)` both continue with a
    // statement, so the `/` opens a regex; `f(a)/2` and `({}).x/2` are values.
    if (t === ")") return closed === "head-paren";
    if (t === "}") return closed === "block";
    // Both punctuators may be prefix or postfix, but valid code cannot start a
    // regex operand after the postfix form (`value++/2`, `value--/2`). Treating
    // the slash as division is the conservative reading: it keeps following
    // statements visible instead of swallowing them into a fake regex token.
    if (t === "++" || t === "--") return false;
    return t !== "]";
  }
  if (prev.type === "ident") {
    // Keyword-shaped property names are values (`result.default/2`), not the
    // expression-leading keyword forms (`export default /re/`).
    if (
      beforePrev?.type === "punct" &&
      (jsTokenText(src, beforePrev) === "." || jsTokenText(src, beforePrev) === "?.")
    ) {
      return false;
    }
    if (
      lineTerminatorBefore &&
      (LINE_TERMINATED_REGEX_KEYWORDS.has(jsTokenText(src, prev)) ||
        (beforePrev?.type === "ident" &&
          !lineTerminatorBeforePrev &&
          (jsTokenText(src, beforePrev) === "break" ||
            jsTokenText(src, beforePrev) === "continue")))
    ) {
      return true;
    }
    return REGEX_PRECEDING_KEYWORDS.has(jsTokenText(src, prev));
  }
  return false; // value-producing token -> division
}

function isClassExpression(
  src: string,
  prev: JsToken | undefined,
  statementStart: boolean,
): boolean {
  if (statementStart) return false;
  const prevText = prev ? jsTokenText(src, prev) : "";
  return !["export", "default", "declare", "abstract"].includes(prevText);
}

function isFunctionExpression(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  state: BracketState,
  statementStart: boolean,
): boolean {
  if (statementStart) return false;
  const prevText = prev ? jsTokenText(src, prev) : "";
  if (["export", "default", "declare"].includes(prevText)) return false;
  if (prevText !== "async") return true;
  if (!beforePrev || canStartStatement(src, beforePrev, state)) return false;
  return !["export", "default", "declare"].includes(jsTokenText(src, beforePrev));
}

function tokenEndsModuleDeclaration(
  src: string,
  token: JsToken | undefined,
  state: BracketState,
): boolean {
  if (!token || !state.moduleDeclarationKind) return false;
  if (
    token.type === "string" &&
    state.moduleDeclarationSawSource &&
    state.moduleDeclarationDepth === state.brackets.length
  ) {
    return true;
  }
  return (
    token.type === "punct" &&
    jsTokenText(src, token) === "}" &&
    state.moduleDeclarationClosedClause &&
    state.moduleDeclarationDepth === state.brackets.length
  );
}

function continuesModuleDeclaration(src: string, token: JsToken): boolean {
  if (token.type !== "ident") return false;
  return ["assert", "from", "with"].includes(jsTokenText(src, token));
}

function clearModuleDeclaration(state: BracketState): void {
  state.moduleDeclarationDepth = null;
  state.moduleDeclarationKind = null;
  state.moduleDeclarationSawSource = false;
  state.moduleDeclarationClosedClause = false;
  state.moduleExportClauseDepth = null;
}

// `(` of `if (…)`, `for (…)`, `for await (…)`, `while (…)`, `with (…)` — the
// forms whose closing `)` is followed by a statement rather than by more of an
// expression.
function isStatementHead(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
): boolean {
  if (prev?.type !== "ident") return false;
  if (STATEMENT_HEAD_KEYWORDS.has(jsTokenText(src, prev))) return true;
  return (
    jsTokenText(src, prev) === "await" &&
    beforePrev?.type === "ident" &&
    jsTokenText(src, beforePrev) === "for"
  );
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

function isWhitespace(c: string | undefined): boolean {
  return c !== undefined && /^\s$/u.test(c);
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return c === "_" || c === "$" || /^\p{ID_Start}$/u.test(c);
}

function isIdentPart(c: string): boolean {
  return c === "$" || c === "\u200C" || c === "\u200D" || /^\p{ID_Continue}$/u.test(c);
}

function codePointAt(src: string, index: number): string {
  const value = src.codePointAt(index);
  return value === undefined ? "" : String.fromCodePoint(value);
}

interface IdentifierUnit {
  end: number;
}

// IdentifierName permits Unicode escapes in both the start and continuation
// positions. Treat the complete escape as one lexical unit so braces in
// `\u{...}` can never be mistaken for source blocks by the formatter.
function scanIdentifierUnit(src: string, index: number, start: boolean): IdentifierUnit | null {
  const direct = codePointAt(src, index);
  if (start ? isIdentStart(direct) : isIdentPart(direct)) {
    return { end: index + direct.length };
  }
  if (src[index] !== "\\" || src[index + 1] !== "u") return null;
  const escaped = scanIdentifierUnicodeEscape(src, index);
  if (!escaped) return null;
  if (!(start ? isIdentStart(escaped.value) : isIdentPart(escaped.value))) return null;
  return { end: escaped.end };
}

function scanIdentifierUnicodeEscape(
  src: string,
  start: number,
): { end: number; value: string } | null {
  if (src[start + 2] === "{") {
    const close = src.indexOf("}", start + 3);
    if (close === -1) return null;
    const digits = src.slice(start + 3, close);
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) return null;
    return { end: close + 1, value: String.fromCodePoint(codePoint) };
  }
  const digits = src.slice(start + 2, start + 6);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
  return { end: start + 6, value: String.fromCharCode(Number.parseInt(digits, 16)) };
}

function isIdentText(src: string, token: JsToken | undefined, value: string): boolean {
  return token?.type === "ident" && jsTokenText(src, token) === value;
}

function isLineTerminator(c: string | undefined): boolean {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
}

function containsLineTerminator(src: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (isLineTerminator(src[index])) return true;
  }
  return false;
}
