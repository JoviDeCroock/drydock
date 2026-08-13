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
type BracketKind =
  | "head-paren"
  | "catch-params"
  | "function-params"
  | "paren"
  | "block"
  | "value-block"
  | "class-block"
  | "class-value-block"
  | "object"
  | "bracket";

type PendingBodyKind = "value-block" | "class-block" | "class-value-block";

interface ContextualKeywordMode {
  awaitIsKeyword: boolean;
  yieldIsKeyword: boolean;
}

interface PendingArrowBody {
  depth: number;
  mode: ContextualKeywordMode;
}

interface ExpressionFunctionMode extends PendingArrowBody {}

interface PendingContextualBindingCandidate {
  target: "variable" | "catch";
  depth: number;
  name: string;
}

interface PendingMethodHead {
  depth: number;
  mode: ContextualKeywordMode;
  genericDepth: number;
}

interface PendingAsyncArrowTypeParameters {
  depth: number;
  genericDepth: number;
}

interface ConditionalContext {
  depth: number;
  expressionFunctionModeCount: number;
}

interface BracketState {
  brackets: BracketKind[];
  closed: BracketKind | null;
  // Class/interface/enum/namespace bodies are blocks even though the token
  // immediately before `{` is usually the declaration name or extends
  // expression. Remember the bracket depth at which the header started so
  // nested calls/objects do not consume it.
  pendingDeclarationDepth: number | null;
  // Decorators precede class declarations with an arbitrary expression, so the
  // token immediately before `class` is not enough to distinguish a declaration
  // from a class expression. Preserve the statement-level `@` until that class
  // arrives; nested classes inside decorator arguments live at a deeper depth.
  pendingDecoratorDepth: number | null;
  // Function/class expressions end in blocks that produce values, while class
  // declarations end in statement blocks. Keep the ordered markers at each
  // depth: a heritage expression can itself be an unparenthesized function or
  // class expression, so an aggregate count cannot tell which body opens first.
  pendingBodies: Map<number, PendingBodyKind[]>;
  // Function parameter bindings and contextual keyword modes cross the closing
  // `)` before an implementation body exists. The binding sets retain exact
  // names for top-level lexical lookup; the modes make ordinary function,
  // method, and arrow bodies inherit identifier-shaped `await`/`yield` through
  // nested syntax while async/generator bodies restore their keyword roles.
  pendingFunctionParametersDepth: number | null;
  pendingFunctionParametersAmbient: boolean;
  pendingFunctionParametersMode: ContextualKeywordMode | null;
  functionParameterBindings: Map<number, Set<string>>;
  functionParameterAmbientDepths: Set<number>;
  functionParameterModes: Map<number, ContextualKeywordMode>;
  pendingFunctionBodyBindings: Map<number, Set<string>[]>;
  pendingFunctionBodyModes: Map<number, ContextualKeywordMode[]>;
  functionBodyModes: Map<number, ContextualKeywordMode>;
  activeFunctionModeDepths: number[];
  parenAsyncPrefixes: Map<number, boolean>;
  lastClosedParen: { depth: number; async: boolean } | null;
  pendingArrowBody: PendingArrowBody | null;
  expressionFunctionModes: ExpressionFunctionMode[];
  // Computed and generic method names do not leave the method name immediately
  // before `(`. Carry their mode across `]` / `<...>` so the body still creates
  // a fresh await/yield scope rather than inheriting its containing function.
  computedMethodModes: Map<number, ContextualKeywordMode>;
  pendingMethodHead: PendingMethodHead | null;
  // Likewise, `async <T>(value) => ...` has a type-parameter list between the
  // async prefix and parameter list. Remember it until the parameter `(` opens.
  pendingAsyncArrowTypeParameters: PendingAsyncArrowTypeParameters | null;
  catchParameterBindings: Map<number, Set<string>>;
  pendingCatchBodyBindings: { depth: number; bindings: Set<string> } | null;
  bindingPatternKinds: Map<number, "object" | "array" | "computed">;
  pendingContextualBindingCandidate: PendingContextualBindingCandidate | null;
  // Ambient functions have no implementation body. Their semicolon is optional,
  // so a line-start slash after the completed signature begins a regex statement.
  pendingAmbientFunctionDeclarationDepth: number | null;
  // TypeScript permits a return annotation between a function/method's `)` and
  // body. Without remembering the annotation's colon, `(): void {}` looks like
  // an object literal and a following regex is consequently read as division.
  pendingTypedBodyDepth: number | null;
  // A `case` expression may contain nested objects and conditional expressions
  // before its terminating `:`. Keep the switch-block depth so that colon can
  // be distinguished from an object property or conditional-expression colon.
  pendingCaseDepth: number | null;
  // A concise arrow in a conditional consequent ends at the matching `:`. Keep
  // the mode-stack size from `?` so colon can discard only functions that began
  // inside that consequent while retaining an enclosing concise arrow.
  conditionalDepths: ConditionalContext[];
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
  // TypeScript's `import Foo = require("foo")` and `import Foo = Bar.Baz`
  // declarations end at the RHS value even though they contain a call/member
  // expression. Keep them distinct from dynamic `import(...)` expressions.
  moduleImportEquals: boolean;
  // Export declarations can also contain object/class/function initializers.
  // Only a brace opened directly by `export` (or `export type`) is an export
  // clause whose closing brace terminates the module declaration.
  moduleExportClauseDepth: number | null;
  // A bare `let`/`var` declarator is complete before a following line-start
  // regex (`let value\n/re/`). Keep that declaration context distinct from an
  // initialized declarator, whose value can continue as division across a line.
  bareVariableDeclarationDepth: number | null;
  bareVariableDeclarationCanEnd: boolean;
  variableDeclaratorHasInitializer: boolean;
  variableDeclaratorInType: boolean;
  variableTypeSawToken: boolean;
  variableTypeAngleDepth: number;
  // `of` is only an operator inside a for-of head; elsewhere it is an ordinary
  // IdentifierName and a following slash divides. Keep the active for-head
  // depths so the spelling alone never decides the lexical goal.
  forHeadDepths: Set<number>;
  // `await` and `yield` are valid bindings in script/sloppy contexts. Remember
  // contextual bindings at their current lexical bracket depth so their uses
  // remain value-shaped without changing genuine async/generator keywords in a
  // nested function body.
  contextualBindingsByDepth: Map<number, Set<string>>;
  previousContextualIdentifierIsValue: boolean;
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

const TYPE_BLOCK_DECLARATION_KEYWORDS = new Set([
  "enum",
  "global",
  "interface",
  "module",
  "namespace",
]);
const DECLARATION_PREFIX_KEYWORDS = new Set(["const", "declare", "default", "export"]);
const TYPE_ALIAS_PREFIX_KEYWORDS = new Set(["declare", "export"]);

// These tokens start declarations rather than continue a preceding expression.
// When one follows a line-terminable value in a statement list, ASI ends the
// previous statement even though the previous token is not one of the explicit
// boundaries handled by `canStartStatement`.
const LINE_TERMINATED_DECLARATION_KEYWORDS = new Set([
  "class",
  "const",
  "enum",
  "export",
  "function",
  "import",
  "interface",
  "let",
  "module",
  "namespace",
  "type",
  "var",
]);

// Prefix/operator keywords whose operand may continue on the following line.
// They cannot end a statement immediately before a declaration-shaped token.
const EXPRESSION_CONTINUATION_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "throw",
  "typeof",
  "void",
]);

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

const CONTEXTUAL_REGEX_KEYWORDS = new Set(["await", "of", "yield"]);

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
  let beforeBeforePrev: JsToken | undefined;
  let lineTerminatorBefore = false;
  let lineTerminatorBeforePrev = false;
  let prevEndsModuleDeclaration = false;
  let atLineStart = true;
  let i = 0;
  // Open brackets, innermost last, and the kind the most recent closer popped.
  // `closed` is only ever read while `prev` is that closer.
  const state = createBracketState();

  const pushSignificant = (token: JsToken): void => {
    updateBracketState(src, token, prev, beforePrev, beforeBeforePrev, state, lineTerminatorBefore);
    tokens.push(token);
    beforeBeforePrev = beforePrev;
    beforePrev = prev;
    prev = token;
    lineTerminatorBeforePrev = lineTerminatorBefore;
    prevEndsModuleDeclaration = tokenEndsModuleDeclaration(src, token, state);
    lineTerminatorBefore = false;
    atLineStart = false;
  };

  while (i < n) {
    const c = src[i];

    // Hashbang comments are only recognized at the absolute start of a script.
    // Package executables commonly put interpreter flags here; treating their
    // punctuation as JavaScript would let the review formatter split the
    // shipped first line into code that does not exist in the artifact.
    if (i === 0 && c === "#" && src[i + 1] === "!") {
      const start = i;
      i += 2;
      while (i < n && !isLineTerminator(src[i])) i += 1;
      tokens.push({ type: "comment", start, end: i });
      atLineStart = false;
      continue;
    }

    if (isWhitespace(c)) {
      const start = i;
      while (i < n && isWhitespace(src[i])) {
        if (isLineTerminator(src[i])) {
          lineTerminatorBefore = true;
          atLineStart = true;
        }
        i += 1;
      }
      tokens.push({ type: "ws", start, end: i });
      continue;
    }

    // Annex B HTML-like comments are valid in Script source, including inside
    // template interpolations. If they are exposed as punctuation, the review
    // formatter can split inert comment text into apparent executable lines.
    if (src.startsWith("<!--", i) || (atLineStart && src.startsWith("-->", i))) {
      const start = i;
      i += src.startsWith("<!--", i) ? 4 : 3;
      while (i < n && !isLineTerminator(src[i])) i += 1;
      tokens.push({ type: "comment", start, end: i });
      atLineStart = false;
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && !isLineTerminator(src[i])) i += 1;
      tokens.push({ type: "comment", start, end: i });
      atLineStart = false;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2);
      if (containsLineTerminator(src, start, i)) lineTerminatorBefore = true;
      tokens.push({ type: "comment", start, end: i });
      atLineStart = false;
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
        bareVariableDeclarationEndsBeforeNextToken(state, lineTerminatorBefore),
        ambientFunctionDeclarationEndsBeforeNextToken(state, lineTerminatorBefore),
        state.previousContextualIdentifierIsValue,
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
  beforeBeforePrev?: JsToken;
  lineTerminatorBefore: boolean;
  lineTerminatorBeforePrev: boolean;
  prevEndsModuleDeclaration: boolean;
  atLineStart: boolean;
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
          atLineStart: false,
        });
        j += 2;
        continue;
      }
      j += 1;
      continue;
    }

    if (isWhitespace(c)) {
      if (isLineTerminator(c)) {
        frame.lineTerminatorBefore = true;
        frame.atLineStart = true;
      }
      j += 1;
      continue;
    }
    if (src.startsWith("<!--", j) || (frame.atLineStart && src.startsWith("-->", j))) {
      j += src.startsWith("<!--", j) ? 4 : 3;
      while (j < n && !isLineTerminator(src[j])) j += 1;
      frame.atLineStart = false;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j += 2;
      while (j < n && !isLineTerminator(src[j])) j += 1;
      frame.atLineStart = false;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const start = j;
      j += 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(n, j + 2);
      if (containsLineTerminator(src, start, j)) frame.lineTerminatorBefore = true;
      frame.atLineStart = false;
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
        bareVariableDeclarationEndsBeforeNextToken(frame.state, frame.lineTerminatorBefore),
        ambientFunctionDeclarationEndsBeforeNextToken(frame.state, frame.lineTerminatorBefore),
        frame.state.previousContextualIdentifierIsValue,
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
    frame.beforeBeforePrev,
    frame.state,
    frame.lineTerminatorBefore,
  );
  frame.beforeBeforePrev = frame.beforePrev;
  frame.beforePrev = frame.prev;
  frame.prev = token;
  frame.lineTerminatorBeforePrev = frame.lineTerminatorBefore;
  frame.prevEndsModuleDeclaration = tokenEndsModuleDeclaration(src, token, frame.state);
  frame.lineTerminatorBefore = false;
  frame.atLineStart = false;
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
  beforeBeforePrev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): void {
  const text = jsTokenText(src, token);
  if (expressionFunctionModeEndsBeforeToken(src, token, prev, state, lineTerminatorBefore)) {
    clearExpressionFunctionModesAtDepth(state, state.brackets.length);
  }
  activatePendingExpressionFunctionMode(state, text);
  resolvePendingContextualBindingCandidate(state, text);
  const pendingMethodMode = methodModeForCurrentToken(
    src,
    token,
    prev,
    beforePrev,
    beforeBeforePrev,
    state,
  );
  const asyncGenericArrowParameters = asyncGenericArrowParametersForCurrentToken(
    src,
    token,
    prev,
    beforePrev,
    state,
    lineTerminatorBefore,
  );
  state.previousContextualIdentifierIsValue = false;
  if (ambientFunctionDeclarationEndsBeforeToken(src, token, prev, state, lineTerminatorBefore)) {
    clearAmbientFunctionDeclaration(state);
    state.pendingTypedBodyDepth = null;
  }
  if (
    bareVariableDeclarationEndsBeforeNextToken(state, lineTerminatorBefore) &&
    !continuesBareVariableDeclaration(src, token, prev, state)
  ) {
    clearBareVariableDeclaration(state);
  }
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
    const statementStart =
      followsModuleDeclaration ||
      canStartStatement(src, prev, state) ||
      (LINE_TERMINATED_DECLARATION_KEYWORDS.has(text) &&
        startsStatementAfterLineTerminator(src, prev, state, lineTerminatorBefore));
    if (lineTerminatorBefore && statementStart && LINE_TERMINATED_DECLARATION_KEYWORDS.has(text)) {
      clearExpressionFunctionModesAtDepth(state, state.brackets.length);
    }
    const decoratedClass =
      text === "class" && state.pendingDecoratorDepth === state.brackets.length;
    const prefixedVariableDeclaration =
      prev?.type === "ident" &&
      ["declare", "export"].includes(jsTokenText(src, prev)) &&
      !isMemberAccess(src, beforePrev);
    const exportedAmbientVariableDeclaration =
      prev?.type === "ident" &&
      jsTokenText(src, prev) === "declare" &&
      beforePrev?.type === "ident" &&
      jsTokenText(src, beforePrev) === "export";
    const bareVariableDeclaration =
      (text === "let" || text === "var" || text === "const") &&
      (statementStart || prefixedVariableDeclaration || exportedAmbientVariableDeclaration);
    if (
      state.pendingTypedBodyDepth === state.brackets.length &&
      lineTerminatorBefore &&
      statementStart
    ) {
      // An expression-bodied typed arrow can end by ASI. Do not let its return
      // annotation make a brace in the next declaration look like its body.
      state.pendingTypedBodyDepth = null;
    }
    const declaresContextualBinding =
      state.bareVariableDeclarationDepth === state.brackets.length &&
      !state.bareVariableDeclarationCanEnd &&
      CONTEXTUAL_REGEX_KEYWORDS.has(text);
    if (declaresContextualBinding) {
      const bindings = state.contextualBindingsByDepth.get(state.brackets.length);
      if (bindings) bindings.add(text);
      else state.contextualBindingsByDepth.set(state.brackets.length, new Set([text]));
    }
    const destructuredVariableBindingDepth = contextualVariableBindingDepth(
      src,
      token,
      prev,
      state,
    );
    if (destructuredVariableBindingDepth !== null) {
      captureContextualBinding(
        state,
        "variable",
        destructuredVariableBindingDepth,
        text,
        prev,
        src,
      );
    }
    const functionParameterDepth = contextualFunctionParameterBindingDepth(src, token, prev, state);
    if (functionParameterDepth !== null) {
      state.functionParameterBindings.get(functionParameterDepth)?.add(text);
    }
    if (
      CONTEXTUAL_REGEX_KEYWORDS.has(text) &&
      contextualBindingFollows(prev, src) &&
      contextualCatchBindingPosition(state, prev, src)
    ) {
      const catchParameterDepth = state.brackets.lastIndexOf("catch-params") + 1;
      if (catchParameterDepth > 0) {
        captureContextualBinding(state, "catch", catchParameterDepth, text, prev, src);
      }
    }
    if (bareVariableDeclaration) {
      state.bareVariableDeclarationDepth = state.brackets.length;
      state.bareVariableDeclarationCanEnd = false;
      state.variableDeclaratorHasInitializer = false;
      state.variableDeclaratorInType = false;
      state.variableTypeSawToken = false;
      state.variableTypeAngleDepth = 0;
    } else if (
      state.bareVariableDeclarationDepth === state.brackets.length &&
      !state.bareVariableDeclarationCanEnd
    ) {
      state.bareVariableDeclarationCanEnd = true;
    }
    if (state.variableDeclaratorInType) state.variableTypeSawToken = true;
    state.previousContextualIdentifierIsValue = contextualIdentifierIsValue(src, text, prev, state);
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
      state.moduleImportEquals = false;
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
      if (text === "class") {
        const classExpression = !decoratedClass && isClassExpression(src, prev, statementStart);
        pushPendingBody(
          state.pendingBodies,
          state.brackets.length,
          classExpression ? "class-value-block" : "class-block",
        );
      } else {
        state.pendingDeclarationDepth = state.brackets.length;
      }
    }
    if (text === "class" && decoratedClass) state.pendingDecoratorDepth = null;
    if (
      text === "function" &&
      !(prev?.type === "punct" && [".", "?."].includes(jsTokenText(src, prev)))
    ) {
      state.pendingFunctionParametersDepth = state.brackets.length;
      state.pendingFunctionParametersAmbient = isIdentText(src, prev, "declare");
      state.pendingFunctionParametersMode = {
        awaitIsKeyword:
          isIdentText(src, prev, "async") && !containsLineTerminator(src, prev!.end, token.start),
        yieldIsKeyword: false,
      };
      if (isFunctionExpression(src, prev, beforePrev, state, statementStart)) {
        pushPendingBody(state.pendingBodies, state.brackets.length, "value-block");
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
      state.moduleDeclarationDepth === state.brackets.length &&
      (isIdentText(src, prev, "import") || isIdentText(src, prev, "from"))
    ) {
      state.moduleDeclarationSawSource = true;
    }
    if (state.pendingTypeAliasObjectDepth === state.brackets.length) {
      state.pendingTypeAliasObjectDepth = null;
    }
    state.labelCandidate = false;
    state.statementColon = false;
    markTypeAliasBodyToken(state);
    markVariableTypeToken(state);
    return;
  }

  const followsStatementColon = state.statementColon;
  state.statementColon = false;

  if (state.bareVariableDeclarationDepth === state.brackets.length) {
    if (state.variableDeclaratorInType) {
      if (text === "<") state.variableTypeAngleDepth += 1;
      else if (text === ">")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 1);
      else if (text === ">=")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 1);
      else if (text === ">>")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 2);
      else if (text === ">>=")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 2);
      else if (text === ">>>")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 3);
      else if (text === ">>>=")
        state.variableTypeAngleDepth = Math.max(0, state.variableTypeAngleDepth - 3);
    }
    const typeInitializer =
      state.variableDeclaratorInType &&
      state.variableTypeAngleDepth === 0 &&
      ["=", ">=", ">>=", ">>>="].includes(text);
    if ((text === "=" && !state.variableDeclaratorInType) || typeInitializer) {
      state.variableDeclaratorHasInitializer = true;
      state.variableDeclaratorInType = false;
      state.variableTypeSawToken = false;
      state.variableTypeAngleDepth = 0;
    } else if (
      text === "," &&
      (!state.variableDeclaratorInType || state.variableTypeAngleDepth === 0)
    ) {
      state.bareVariableDeclarationCanEnd = false;
      state.variableDeclaratorHasInitializer = false;
      state.variableDeclaratorInType = false;
      state.variableTypeSawToken = false;
      state.variableTypeAngleDepth = 0;
    } else if (text === ":" && !state.variableDeclaratorInType) {
      state.variableDeclaratorInType = true;
      state.variableTypeSawToken = false;
      state.variableTypeAngleDepth = 0;
    } else if (text === ";") {
      clearBareVariableDeclaration(state);
    }
  }

  if (
    text === "@" &&
    (canStartStatement(src, prev, state) ||
      startsStatementAfterLineTerminator(src, prev, state, lineTerminatorBefore) ||
      state.pendingDecoratorDepth === state.brackets.length)
  ) {
    state.pendingDecoratorDepth = state.brackets.length;
  }

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
    state.pendingBodies.delete(state.brackets.length);
    popPendingFunctionBodyBindings(state.pendingFunctionBodyBindings, state.brackets.length);
    popPendingFunctionBodyMode(state.pendingFunctionBodyModes, state.brackets.length);
    if (state.pendingFunctionParametersDepth === state.brackets.length) {
      clearPendingFunctionParameters(state);
    }
    clearAmbientFunctionDeclaration(state);
    clearExpressionFunctionModesAtDepth(state, state.brackets.length);
    if (state.pendingDecoratorDepth === state.brackets.length) {
      state.pendingDecoratorDepth = null;
    }
    clearTypeAliasBody(state);
  }
  if (
    text === "*" &&
    state.pendingFunctionParametersDepth === state.brackets.length &&
    state.pendingFunctionParametersMode
  ) {
    state.pendingFunctionParametersMode.yieldIsKeyword = true;
  }
  if (
    text === "=" &&
    state.moduleDeclarationDepth === state.brackets.length &&
    (state.moduleDeclarationKind === "import" ||
      (state.moduleDeclarationKind === "export" && isIdentText(src, beforePrev, "import")))
  ) {
    state.moduleImportEquals = true;
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
      !state.moduleDeclarationClosedClause &&
      isIdentText(src, prev, "import")
    ) {
      clearModuleDeclaration(state); // dynamic import(...)
    }
    const methodMode =
      pendingMethodMode ?? contextualMethodMode(src, prev, beforePrev, beforeBeforePrev, state);
    const catchParameters = isIdentText(src, prev, "catch") && !isMemberAccess(src, beforePrev);
    const functionParameters =
      state.pendingFunctionParametersDepth === state.brackets.length || methodMode !== null;
    const statementHead = isStatementHead(src, prev, beforePrev, beforeBeforePrev);
    state.brackets.push(
      catchParameters
        ? "catch-params"
        : functionParameters
          ? "function-params"
          : statementHead
            ? "head-paren"
            : "paren",
    );
    state.parenAsyncPrefixes.set(
      state.brackets.length,
      asyncGenericArrowParameters ||
        (isIdentText(src, prev, "async") && !containsLineTerminator(src, prev!.end, token.start)),
    );
    if (functionParameters) {
      const parameterDepth = state.brackets.length;
      state.functionParameterBindings.set(parameterDepth, new Set());
      const mode = methodMode ?? state.pendingFunctionParametersMode ?? ordinaryFunctionMode();
      state.functionParameterModes.set(parameterDepth, mode);
      if (state.pendingFunctionParametersAmbient) {
        state.functionParameterAmbientDepths.add(parameterDepth);
      }
      clearPendingFunctionParameters(state);
    }
    if (catchParameters) {
      state.catchParameterBindings.set(state.brackets.length, new Set());
    }
    if (isForStatementHead(src, prev, beforePrev, beforeBeforePrev)) {
      state.forHeadDepths.add(state.brackets.length);
    }
  } else if (text === "[") {
    const computedMethodMode = contextualComputedMethodMode(
      src,
      prev,
      beforePrev,
      beforeBeforePrev,
      state,
      lineTerminatorBefore,
    );
    const bindingPatternKind = bindingPatternKindForOpen(src, text, prev, state);
    state.brackets.push("bracket");
    if (computedMethodMode) {
      state.computedMethodModes.set(state.brackets.length, computedMethodMode);
    }
    if (bindingPatternKind) {
      state.bindingPatternKinds.set(state.brackets.length, bindingPatternKind);
    }
  } else if (text === "{") {
    const bindingPatternKind = bindingPatternKindForOpen(src, text, prev, state);
    if (
      state.moduleDeclarationKind === "export" &&
      state.moduleDeclarationDepth === state.brackets.length &&
      (isIdentText(src, prev, "export") ||
        (isIdentText(src, prev, "type") && isIdentText(src, beforePrev, "export")))
    ) {
      state.moduleExportClauseDepth = state.brackets.length;
    }
    const pendingBody = peekPendingBody(state.pendingBodies, state.brackets.length);
    const bodyKind =
      pendingBody &&
      !(prev?.type === "punct" && TYPE_LITERAL_PRECEDING_PUNCTUATORS.has(jsTokenText(src, prev)))
        ? pendingBody
        : null;
    const declarationBody =
      bodyKind === null && state.pendingDeclarationDepth === state.brackets.length;
    const typeAliasObject = state.pendingTypeAliasObjectDepth === state.brackets.length;
    const typedBody =
      state.pendingTypedBodyDepth === state.brackets.length &&
      !(prev?.type === "punct" && TYPE_LITERAL_PRECEDING_PUNCTUATORS.has(jsTokenText(src, prev)));
    const top = state.brackets[state.brackets.length - 1];
    const staticBlock =
      isIdentText(src, prev, "static") && (top === "class-block" || top === "class-value-block");
    const openedKind =
      bodyKind ??
      (staticBlock ||
      declarationBody ||
      typeAliasObject ||
      typedBody ||
      followsStatementColon ||
      followsModuleDeclaration ||
      opensBlock(src, prev)
        ? "block"
        : "object");
    state.brackets.push(openedKind);
    const bodyDepth = state.brackets.length;
    if (openedKind === "block" || openedKind === "value-block") {
      const bindings = popPendingFunctionBodyBindings(
        state.pendingFunctionBodyBindings,
        state.brackets.length - 1,
      );
      if (bindings?.size) state.contextualBindingsByDepth.set(state.brackets.length, bindings);
      const functionMode = popPendingFunctionBodyMode(
        state.pendingFunctionBodyModes,
        state.brackets.length - 1,
      );
      const arrowMode =
        state.pendingArrowBody?.depth === state.brackets.length - 1
          ? state.pendingArrowBody.mode
          : null;
      if (functionMode ?? arrowMode) {
        state.functionBodyModes.set(bodyDepth, functionMode ?? arrowMode!);
        state.activeFunctionModeDepths.push(bodyDepth);
      }
      if (arrowMode) state.pendingArrowBody = null;
      if (state.pendingCatchBodyBindings?.depth === state.brackets.length - 1) {
        const catchBindings = state.pendingCatchBodyBindings.bindings;
        if (catchBindings.size) state.contextualBindingsByDepth.set(bodyDepth, catchBindings);
        state.pendingCatchBodyBindings = null;
      }
      clearAmbientFunctionDeclaration(state);
    }
    if (bindingPatternKind) {
      state.bindingPatternKinds.set(bodyDepth, bindingPatternKind);
    }
    if (declarationBody) {
      state.pendingDeclarationDepth = null;
    }
    if (bodyKind) popPendingBody(state.pendingBodies, state.brackets.length - 1);
    if (typeAliasObject) state.pendingTypeAliasObjectDepth = null;
    if (typedBody) state.pendingTypedBodyDepth = null;
    if (
      state.pendingTypedBodyDepth === state.brackets.length - 1 &&
      prev?.type === "punct" &&
      jsTokenText(src, prev) === "=>"
    ) {
      // This is an arrow implementation block, not a declaration body. Consume
      // the return-annotation marker here; clearing on every `=>` would break a
      // declaration whose return type is itself a function (`(): () => void {}`).
      state.pendingTypedBodyDepth = null;
    }
  } else if (text === ")" || text === "]" || text === "}") {
    const closedDepth = state.brackets.length;
    const computedMethodMode =
      text === "]" ? state.computedMethodModes.get(closedDepth) : undefined;
    const closingFunctionParameters =
      text === ")" && state.brackets[state.brackets.length - 1] === "function-params";
    const functionParameterBindings = closingFunctionParameters
      ? state.functionParameterBindings.get(closedDepth)
      : undefined;
    const ambientFunctionParameters =
      closingFunctionParameters && state.functionParameterAmbientDepths.has(closedDepth);
    const closingCatchParameters =
      text === ")" && state.brackets[state.brackets.length - 1] === "catch-params";
    const functionParameterMode = closingFunctionParameters
      ? state.functionParameterModes.get(closedDepth)
      : undefined;
    const closedParenAsync =
      text === ")" ? (state.parenAsyncPrefixes.get(closedDepth) ?? false) : false;
    state.closed = state.brackets.pop() ?? null;
    state.forHeadDepths.delete(closedDepth);
    state.contextualBindingsByDepth.delete(closedDepth);
    state.bindingPatternKinds.delete(closedDepth);
    state.computedMethodModes.delete(closedDepth);
    if (state.activeFunctionModeDepths.at(-1) === closedDepth) {
      state.activeFunctionModeDepths.pop();
    }
    state.functionBodyModes.delete(closedDepth);
    state.parenAsyncPrefixes.delete(closedDepth);
    clearExpressionFunctionModesLeavingDepth(state, closedDepth);
    if (closingFunctionParameters) {
      state.functionParameterBindings.delete(closedDepth);
      state.functionParameterAmbientDepths.delete(closedDepth);
      state.functionParameterModes.delete(closedDepth);
      if (functionParameterBindings?.size && !ambientFunctionParameters) {
        pushPendingFunctionBodyBindings(
          state.pendingFunctionBodyBindings,
          state.brackets.length,
          functionParameterBindings,
        );
      }
      if (functionParameterMode && !ambientFunctionParameters) {
        pushPendingFunctionBodyMode(
          state.pendingFunctionBodyModes,
          state.brackets.length,
          functionParameterMode,
        );
      }
      if (ambientFunctionParameters) {
        state.pendingAmbientFunctionDeclarationDepth = state.brackets.length;
      }
    }
    if (closingCatchParameters) {
      const bindings = state.catchParameterBindings.get(closedDepth) ?? new Set<string>();
      state.catchParameterBindings.delete(closedDepth);
      state.pendingCatchBodyBindings = { depth: state.brackets.length, bindings };
    }
    if (text === ")") {
      state.lastClosedParen = { depth: state.brackets.length, async: closedParenAsync };
    }
    if (computedMethodMode) {
      state.pendingMethodHead = {
        depth: state.brackets.length,
        mode: computedMethodMode,
        genericDepth: 0,
      };
    }
    if (
      state.bareVariableDeclarationDepth !== null &&
      state.bareVariableDeclarationDepth > state.brackets.length
    ) {
      clearBareVariableDeclaration(state);
    } else if (
      state.bareVariableDeclarationDepth === state.brackets.length &&
      !state.variableDeclaratorHasInitializer &&
      (text === "]" || text === "}")
    ) {
      state.bareVariableDeclarationCanEnd = true;
    }
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
    !state.moduleDeclarationClosedClause &&
    isIdentText(src, prev, "import")
  ) {
    clearModuleDeclaration(state); // import.meta
  } else if (text === ";") {
    clearModuleDeclaration(state);
  } else if (text === ",") {
    clearExpressionFunctionModesAtDepth(state, state.brackets.length);
  } else if (text === "?") {
    state.conditionalDepths.push({
      depth: state.brackets.length,
      expressionFunctionModeCount: state.expressionFunctionModes.length,
    });
  } else if (text === ":") {
    if (state.pendingFunctionParametersDepth === state.brackets.length) {
      clearPendingFunctionParameters(state);
    }
    const conditional = state.conditionalDepths[state.conditionalDepths.length - 1];
    if (conditional?.depth === state.brackets.length) {
      state.conditionalDepths.pop();
      if (state.expressionFunctionModes.length > conditional.expressionFunctionModeCount) {
        state.expressionFunctionModes.length = conditional.expressionFunctionModeCount;
      }
    } else if (state.labelCandidate || state.pendingCaseDepth === state.brackets.length) {
      state.statementColon = true;
      state.pendingCaseDepth = null;
    } else if (
      prev?.type === "punct" &&
      jsTokenText(src, prev) === ")" &&
      (state.closed === "paren" || state.closed === "function-params")
    ) {
      state.pendingTypedBodyDepth = state.brackets.length;
    }
  } else if (
    text === "=>" &&
    !peekPendingFunctionBodyMode(state.pendingFunctionBodyModes, state.brackets.length)
  ) {
    const asyncArrow =
      (isIdentText(src, beforePrev, "async") &&
        prev !== undefined &&
        !containsLineTerminator(src, beforePrev!.end, prev.start)) ||
      (prev?.type === "punct" &&
        jsTokenText(src, prev) === ")" &&
        state.lastClosedParen?.depth === state.brackets.length &&
        state.lastClosedParen.async);
    state.pendingArrowBody = {
      depth: state.brackets.length,
      mode: { awaitIsKeyword: Boolean(asyncArrow), yieldIsKeyword: false },
    };
  }
  state.labelCandidate = false;
  if (text !== "=") markTypeAliasBodyToken(state);
  if (text !== "=" && text !== "," && text !== ":" && text !== ";") {
    markVariableTypeToken(state);
  }
}

function createBracketState(): BracketState {
  return {
    brackets: [],
    closed: null,
    pendingDeclarationDepth: null,
    pendingDecoratorDepth: null,
    pendingBodies: new Map(),
    pendingFunctionParametersDepth: null,
    pendingFunctionParametersAmbient: false,
    pendingFunctionParametersMode: null,
    functionParameterBindings: new Map(),
    functionParameterAmbientDepths: new Set(),
    functionParameterModes: new Map(),
    pendingFunctionBodyBindings: new Map(),
    pendingFunctionBodyModes: new Map(),
    functionBodyModes: new Map(),
    activeFunctionModeDepths: [],
    parenAsyncPrefixes: new Map(),
    lastClosedParen: null,
    pendingArrowBody: null,
    expressionFunctionModes: [],
    computedMethodModes: new Map(),
    pendingMethodHead: null,
    pendingAsyncArrowTypeParameters: null,
    catchParameterBindings: new Map(),
    pendingCatchBodyBindings: null,
    bindingPatternKinds: new Map(),
    pendingContextualBindingCandidate: null,
    pendingAmbientFunctionDeclarationDepth: null,
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
    moduleImportEquals: false,
    moduleExportClauseDepth: null,
    bareVariableDeclarationDepth: null,
    bareVariableDeclarationCanEnd: false,
    variableDeclaratorHasInitializer: false,
    variableDeclaratorInType: false,
    variableTypeSawToken: false,
    variableTypeAngleDepth: 0,
    forHeadDepths: new Set(),
    contextualBindingsByDepth: new Map(),
    previousContextualIdentifierIsValue: false,
  };
}

function bareVariableDeclarationEndsBeforeNextToken(
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  return (
    lineTerminatorBefore &&
    state.bareVariableDeclarationDepth === state.brackets.length &&
    state.bareVariableDeclarationCanEnd &&
    !state.variableDeclaratorHasInitializer &&
    (!state.variableDeclaratorInType || state.variableTypeSawToken)
  );
}

function clearPendingFunctionParameters(state: BracketState): void {
  state.pendingFunctionParametersDepth = null;
  state.pendingFunctionParametersAmbient = false;
  state.pendingFunctionParametersMode = null;
}

function ordinaryFunctionMode(): ContextualKeywordMode {
  return { awaitIsKeyword: false, yieldIsKeyword: false };
}

function contextualMethodMode(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  beforeBeforePrev: JsToken | undefined,
  state: BracketState,
): ContextualKeywordMode | null {
  const top = state.brackets[state.brackets.length - 1];
  if (top !== "object" && top !== "class-block" && top !== "class-value-block") return null;
  if (!prev || (prev.type !== "ident" && prev.type !== "string" && prev.type !== "number")) {
    return null;
  }
  const prefix = beforePrev ? jsTokenText(src, beforePrev) : "";
  const boundary = beforeBeforePrev ? jsTokenText(src, beforeBeforePrev) : "";
  const directBoundary = beforePrev?.type === "punct" && ["{", "}", ",", ";", "#"].includes(prefix);
  const modifier =
    beforePrev?.type === "ident" &&
    [
      "abstract",
      "async",
      "get",
      "override",
      "private",
      "protected",
      "public",
      "set",
      "static",
    ].includes(prefix);
  const generator = prefix === "*";
  if (!directBoundary && !modifier && !generator) return null;
  const directAsync =
    prefix === "async" &&
    beforePrev !== undefined &&
    !containsLineTerminator(src, beforePrev.end, prev.start);
  const generatorAsync =
    generator &&
    beforeBeforePrev?.type === "ident" &&
    boundary === "async" &&
    !containsLineTerminator(src, beforeBeforePrev.end, beforePrev!.start);
  const asyncMethod = directAsync || generatorAsync;
  return { awaitIsKeyword: asyncMethod, yieldIsKeyword: generator };
}

function contextualComputedMethodMode(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  beforeBeforePrev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): ContextualKeywordMode | null {
  const top = state.brackets[state.brackets.length - 1];
  if (top !== "object" && top !== "class-block" && top !== "class-value-block") return null;
  const prefix = prev ? jsTokenText(src, prev) : "";
  const memberBoundary = (candidate: JsToken | undefined): boolean =>
    candidate?.type === "punct" && ["{", "}", ",", ";"].includes(jsTokenText(src, candidate));
  const memberModifier = (candidate: JsToken | undefined): boolean =>
    candidate?.type === "ident" &&
    [
      "abstract",
      "async",
      "declare",
      "override",
      "private",
      "protected",
      "public",
      "readonly",
      "static",
    ].includes(jsTokenText(src, candidate));
  if (memberBoundary(prev)) {
    return ordinaryFunctionMode();
  }
  if (prefix === "*") {
    const validGeneratorPrefix =
      memberBoundary(beforePrev) ||
      (memberModifier(beforePrev) &&
        (memberBoundary(beforeBeforePrev) || memberModifier(beforeBeforePrev)));
    if (!validGeneratorPrefix) return null;
    const asyncGenerator =
      isIdentText(src, beforePrev, "async") &&
      !containsLineTerminator(src, beforePrev!.end, prev!.start);
    return { awaitIsKeyword: asyncGenerator, yieldIsKeyword: true };
  }
  if (
    prev?.type === "ident" &&
    [
      "abstract",
      "async",
      "get",
      "override",
      "private",
      "protected",
      "public",
      "set",
      "static",
    ].includes(prefix)
  ) {
    if (!memberBoundary(beforePrev) && !memberModifier(beforePrev)) return null;
    if (prefix === "async" && lineTerminatorBefore) {
      // In a class, ASI turns `async\n[key](){}` into an `async` field followed
      // by an ordinary computed method. The method still needs its own mode so
      // it does not inherit await/yield roles from its containing function.
      return top === "class-block" || top === "class-value-block" ? ordinaryFunctionMode() : null;
    }
    return { awaitIsKeyword: prefix === "async", yieldIsKeyword: false };
  }
  return null;
}

function methodModeForCurrentToken(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  beforeBeforePrev: JsToken | undefined,
  state: BracketState,
): ContextualKeywordMode | null {
  const text = jsTokenText(src, token);
  const pending = state.pendingMethodHead;
  if (pending) {
    if (state.brackets.length < pending.depth) {
      state.pendingMethodHead = null;
      return null;
    }
    if (pending.genericDepth > 0) {
      pending.genericDepth += genericAngleDelta(text);
      if (pending.genericDepth < 0) state.pendingMethodHead = null;
      return null;
    }
    if (pending.depth === state.brackets.length && text === "(") {
      state.pendingMethodHead = null;
      return pending.mode;
    }
    if (pending.depth === state.brackets.length && text === "<") {
      pending.genericDepth = 1;
      return null;
    }
    state.pendingMethodHead = null;
  }
  if (text !== "<") return null;
  const mode = contextualMethodMode(src, prev, beforePrev, beforeBeforePrev, state);
  if (mode) {
    state.pendingMethodHead = {
      depth: state.brackets.length,
      mode,
      genericDepth: 1,
    };
  }
  return null;
}

function asyncGenericArrowParametersForCurrentToken(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  const text = jsTokenText(src, token);
  const pending = state.pendingAsyncArrowTypeParameters;
  if (pending) {
    if (state.brackets.length < pending.depth) {
      state.pendingAsyncArrowTypeParameters = null;
      return false;
    }
    if (pending.genericDepth > 0) {
      pending.genericDepth += genericAngleDelta(text);
      if (pending.genericDepth < 0) state.pendingAsyncArrowTypeParameters = null;
      return false;
    }
    if (pending.depth === state.brackets.length && text === "(") {
      state.pendingAsyncArrowTypeParameters = null;
      return true;
    }
    state.pendingAsyncArrowTypeParameters = null;
  }
  if (
    text === "<" &&
    isIdentText(src, prev, "async") &&
    !isMemberAccess(src, beforePrev) &&
    !lineTerminatorBefore
  ) {
    state.pendingAsyncArrowTypeParameters = {
      depth: state.brackets.length,
      genericDepth: 1,
    };
  }
  return false;
}

function genericAngleDelta(text: string): number {
  if (text === "<") return 1;
  if (text.startsWith(">")) return -Math.min(3, text.match(/^>+/)?.[0].length ?? 0);
  return 0;
}

function contextualBindingFollows(prev: JsToken | undefined, src: string): boolean {
  return (
    prev?.type === "punct" && ["(", "{", "[", ":", ",", "..."].includes(jsTokenText(src, prev))
  );
}

function bindingPatternKindForOpen(
  src: string,
  opener: string,
  prev: JsToken | undefined,
  state: BracketState,
): "object" | "array" | "computed" | null {
  const depth = state.brackets.length;
  const previous = prev ? jsTokenText(src, prev) : "";
  const declarationRoot =
    state.bareVariableDeclarationDepth === depth &&
    !state.variableDeclaratorHasInitializer &&
    ((prev?.type === "ident" && ["const", "let", "var"].includes(previous)) ||
      (prev?.type === "punct" && previous === ","));
  const catchRoot =
    state.brackets[state.brackets.length - 1] === "catch-params" && previous === "(";
  const parentKind = state.bindingPatternKinds.get(depth);
  if (!declarationRoot && !catchRoot && !parentKind) return null;
  if (opener === "[" && parentKind === "object" && ["{", ","].includes(previous)) {
    return "computed";
  }
  const nestedBinding =
    parentKind !== undefined &&
    parentKind !== "computed" &&
    prev?.type === "punct" &&
    ["[", ":", ",", "..."].includes(previous);
  if (!declarationRoot && !catchRoot && !nestedBinding) return null;
  return opener === "{" ? "object" : "array";
}

function contextualCatchBindingPosition(
  state: BracketState,
  prev: JsToken | undefined,
  src: string,
): boolean {
  const catchDepth = state.brackets.lastIndexOf("catch-params") + 1;
  if (catchDepth === 0) return false;
  if (state.brackets.length === catchDepth) {
    return prev?.type === "punct" && jsTokenText(src, prev) === "(";
  }
  const patternKind = state.bindingPatternKinds.get(state.brackets.length);
  return patternKind === "object" || patternKind === "array";
}

function contextualVariableBindingDepth(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
): number | null {
  const depth = state.bareVariableDeclarationDepth;
  if (
    depth === null ||
    depth >= state.brackets.length ||
    state.variableDeclaratorHasInitializer ||
    !CONTEXTUAL_REGEX_KEYWORDS.has(jsTokenText(src, token)) ||
    !contextualBindingFollows(prev, src) ||
    !["object", "array"].includes(state.bindingPatternKinds.get(state.brackets.length) ?? "")
  ) {
    return null;
  }
  return depth;
}

function addContextualBinding(state: BracketState, depth: number, name: string): void {
  const bindings = state.contextualBindingsByDepth.get(depth);
  if (bindings) bindings.add(name);
  else state.contextualBindingsByDepth.set(depth, new Set([name]));
}

function captureContextualBinding(
  state: BracketState,
  target: PendingContextualBindingCandidate["target"],
  depth: number,
  name: string,
  prev: JsToken | undefined,
  src: string,
): void {
  const patternKind = state.bindingPatternKinds.get(state.brackets.length);
  const previous = prev ? jsTokenText(src, prev) : "";
  if (patternKind === "object" && (previous === "{" || previous === ",")) {
    state.pendingContextualBindingCandidate = { target, depth, name };
    return;
  }
  addCapturedContextualBinding(state, target, depth, name);
}

function resolvePendingContextualBindingCandidate(state: BracketState, tokenText: string): void {
  const candidate = state.pendingContextualBindingCandidate;
  if (!candidate) return;
  state.pendingContextualBindingCandidate = null;
  if (tokenText !== ":") {
    addCapturedContextualBinding(state, candidate.target, candidate.depth, candidate.name);
  }
}

function addCapturedContextualBinding(
  state: BracketState,
  target: PendingContextualBindingCandidate["target"],
  depth: number,
  name: string,
): void {
  if (target === "variable") {
    addContextualBinding(state, depth, name);
  } else {
    state.catchParameterBindings.get(depth)?.add(name);
  }
}

function contextualFunctionParameterBindingDepth(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
): number | null {
  const text = jsTokenText(src, token);
  if (!CONTEXTUAL_REGEX_KEYWORDS.has(text)) return null;
  const depth = state.brackets.lastIndexOf("function-params") + 1;
  if (depth === 0 || depth !== state.brackets.length) return null;
  if (prev?.type !== "punct") return null;
  return ["(", ",", "..."].includes(jsTokenText(src, prev)) ? depth : null;
}

function pushPendingFunctionBodyBindings(
  bindingsByDepth: Map<number, Set<string>[]>,
  depth: number,
  bindings: Set<string>,
): void {
  const pending = bindingsByDepth.get(depth);
  if (pending) pending.push(bindings);
  else bindingsByDepth.set(depth, [bindings]);
}

function popPendingFunctionBodyBindings(
  bindingsByDepth: Map<number, Set<string>[]>,
  depth: number,
): Set<string> | undefined {
  const pending = bindingsByDepth.get(depth);
  const bindings = pending?.pop();
  if (pending?.length === 0) bindingsByDepth.delete(depth);
  return bindings;
}

function pushPendingFunctionBodyMode(
  modesByDepth: Map<number, ContextualKeywordMode[]>,
  depth: number,
  mode: ContextualKeywordMode,
): void {
  const modes = modesByDepth.get(depth);
  if (modes) modes.push(mode);
  else modesByDepth.set(depth, [mode]);
}

function peekPendingFunctionBodyMode(
  modesByDepth: Map<number, ContextualKeywordMode[]>,
  depth: number,
): ContextualKeywordMode | undefined {
  return modesByDepth.get(depth)?.at(-1);
}

function popPendingFunctionBodyMode(
  modesByDepth: Map<number, ContextualKeywordMode[]>,
  depth: number,
): ContextualKeywordMode | undefined {
  const modes = modesByDepth.get(depth);
  const mode = modes?.pop();
  if (modes?.length === 0) modesByDepth.delete(depth);
  return mode;
}

function activatePendingExpressionFunctionMode(state: BracketState, tokenText: string): void {
  const pending = state.pendingArrowBody;
  if (!pending || pending.depth !== state.brackets.length || tokenText === "{") return;
  state.expressionFunctionModes.push(pending);
  state.pendingArrowBody = null;
}

const EXPRESSION_ARROW_CONTINUATION_IDENTIFIERS = new Set(["as", "in", "instanceof", "satisfies"]);

function expressionFunctionModeEndsBeforeToken(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  if (
    !lineTerminatorBefore ||
    !state.expressionFunctionModes.some((mode) => mode.depth === state.brackets.length) ||
    !startsStatementAfterLineTerminator(src, prev, state, true)
  ) {
    return false;
  }
  if (token.type === "ident") {
    return !EXPRESSION_ARROW_CONTINUATION_IDENTIFIERS.has(jsTokenText(src, token));
  }
  if (token.type === "string" || token.type === "number") return true;
  return token.type === "punct" && ["{", "@"].includes(jsTokenText(src, token));
}

function clearExpressionFunctionModesAtDepth(state: BracketState, depth: number): void {
  if (state.expressionFunctionModes.length) {
    state.expressionFunctionModes = state.expressionFunctionModes.filter(
      (mode) => mode.depth !== depth,
    );
  }
  if (state.pendingArrowBody?.depth === depth) state.pendingArrowBody = null;
}

function clearExpressionFunctionModesLeavingDepth(state: BracketState, closedDepth: number): void {
  if (state.expressionFunctionModes.length) {
    state.expressionFunctionModes = state.expressionFunctionModes.filter(
      (mode) => mode.depth < closedDepth,
    );
  }
  if (state.pendingArrowBody && state.pendingArrowBody.depth >= closedDepth) {
    state.pendingArrowBody = null;
  }
}

function ambientFunctionDeclarationEndsBeforeNextToken(
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  return (
    lineTerminatorBefore && state.pendingAmbientFunctionDeclarationDepth === state.brackets.length
  );
}

function ambientFunctionDeclarationEndsBeforeToken(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  if (!ambientFunctionDeclarationEndsBeforeNextToken(state, lineTerminatorBefore)) return false;
  return !continuesTypeAliasAcrossLine(src, token, prev);
}

function clearAmbientFunctionDeclaration(state: BracketState): void {
  state.pendingAmbientFunctionDeclarationDepth = null;
}

function continuesBareVariableDeclaration(
  src: string,
  token: JsToken,
  prev: JsToken | undefined,
  state: BracketState,
): boolean {
  if (state.variableDeclaratorInType && continuesTypeAliasAcrossLine(src, token, prev)) return true;
  return token.type === "punct" && [",", "=", ":"].includes(jsTokenText(src, token));
}

function clearBareVariableDeclaration(state: BracketState): void {
  state.bareVariableDeclarationDepth = null;
  state.bareVariableDeclarationCanEnd = false;
  state.variableDeclaratorHasInitializer = false;
  state.variableDeclaratorInType = false;
  state.variableTypeSawToken = false;
  state.variableTypeAngleDepth = 0;
}

function markVariableTypeToken(state: BracketState): void {
  if (state.variableDeclaratorInType) state.variableTypeSawToken = true;
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

// These punctuators require another type operand on the following line. If the
// alias state is cleared after `A |\nB`, the slash after the completed alias is
// misread as division and both lexer consumers walk into a regex body.
const TYPE_ALIAS_TRAILING_CONTINUATION_PUNCTUATORS = new Set([
  "|",
  "&",
  "?",
  ":",
  ",",
  ".",
  "<",
  "=>",
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
  if (
    prev?.type === "punct" &&
    TYPE_ALIAS_TRAILING_CONTINUATION_PUNCTUATORS.has(jsTokenText(src, prev))
  ) {
    return true;
  }
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
  // A "value-block" differs from a "block" only at its *closing* brace (the
  // expression continues, so `/` divides). Inside it, a function expression's
  // body is the same statement list as a declaration's — and minified bundles
  // are IIFE wrappers, so labels and nested declarations sit directly in one.
  if (
    top !== undefined &&
    top !== "block" &&
    top !== "value-block" &&
    top !== "class-block" &&
    top !== "class-value-block"
  ) {
    return false;
  }
  if (!prev) return true;
  const text = jsTokenText(src, prev);
  if (prev.type === "ident") return text === "else" || text === "do";
  if (prev.type !== "punct") return false;
  if (text === "{") {
    return (
      top === "block" ||
      top === "value-block" ||
      top === "class-block" ||
      top === "class-value-block"
    );
  }
  if (text === ";") return true;
  if (text === ":") return state.statementColon;
  if (text === ")") return state.closed === "head-paren";
  if (text === "}") return state.closed === "block" || state.closed === "class-block";
  return false;
}

function startsStatementAfterLineTerminator(
  src: string,
  prev: JsToken | undefined,
  state: BracketState,
  lineTerminatorBefore: boolean,
): boolean {
  if (!lineTerminatorBefore || !prev) return false;
  const top = state.brackets[state.brackets.length - 1];
  if (
    top !== undefined &&
    top !== "block" &&
    top !== "value-block" &&
    top !== "class-block" &&
    top !== "class-value-block"
  ) {
    return false;
  }
  if (
    prev.type === "string" ||
    prev.type === "template" ||
    prev.type === "regex" ||
    prev.type === "number"
  ) {
    return true;
  }
  if (prev.type === "ident") {
    const text = jsTokenText(src, prev);
    return (
      !EXPRESSION_CONTINUATION_KEYWORDS.has(text) &&
      !["class", "const", "export", "function", "import", "let", "var"].includes(text)
    );
  }
  if (prev.type !== "punct") return false;
  return [")", "]", "}", "++", "--"].includes(jsTokenText(src, prev));
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
  prevEndsBareVariableDeclaration: boolean,
  prevEndsAmbientFunctionDeclaration: boolean,
  prevContextualIdentifierIsValue: boolean,
): boolean {
  if (!prev) return true;
  if (lineTerminatorBefore && prevEndsModuleDeclaration) return true;
  if (prevEndsTypeAliasDeclaration) return true;
  if (prevEndsBareVariableDeclaration) return true;
  if (prevEndsAmbientFunctionDeclaration) return true;
  if (prev.type === "punct") {
    const t = jsTokenText(src, prev);
    // `if(a)/re/.test(a)` and `if(a){b()}/re/.test(a)` both continue with a
    // statement, so the `/` opens a regex; `f(a)/2` and `({}).x/2` are values.
    if (t === ")") return closed === "head-paren";
    if (t === "}") return closed === "block" || closed === "class-block";
    // Both punctuators may be prefix or postfix, but valid code cannot start a
    // regex operand after the postfix form (`value++/2`, `value--/2`). Treating
    // the slash as division is the conservative reading: it keeps following
    // statements visible instead of swallowing them into a fake regex token.
    if (t === "++" || t === "--") return false;
    return t !== "]";
  }
  if (prev.type === "ident") {
    if (prevContextualIdentifierIsValue) return false;
    // Keyword-shaped property names are values (`result.default/2`), not the
    // expression-leading keyword forms (`export default /re/`).
    if (beforePrev?.type === "punct" && [".", "?.", "#"].includes(jsTokenText(src, beforePrev))) {
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
    state.moduleImportEquals &&
    state.moduleDeclarationDepth === state.brackets.length &&
    (token.type === "ident" || (token.type === "punct" && jsTokenText(src, token) === ")"))
  ) {
    return true;
  }
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
  state.moduleImportEquals = false;
  state.moduleExportClauseDepth = null;
}

// `(` of `if (…)`, `for (…)`, `for await (…)`, `while (…)`, `with (…)` — the
// forms whose closing `)` is followed by a statement rather than by more of an
// expression.
function isStatementHead(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  beforeBeforePrev: JsToken | undefined,
): boolean {
  if (prev?.type !== "ident") return false;
  if (STATEMENT_HEAD_KEYWORDS.has(jsTokenText(src, prev))) {
    return !isMemberAccess(src, beforePrev);
  }
  return (
    jsTokenText(src, prev) === "await" &&
    beforePrev?.type === "ident" &&
    jsTokenText(src, beforePrev) === "for" &&
    !isMemberAccess(src, beforeBeforePrev)
  );
}

function isForStatementHead(
  src: string,
  prev: JsToken | undefined,
  beforePrev: JsToken | undefined,
  beforeBeforePrev: JsToken | undefined,
): boolean {
  if (isIdentText(src, prev, "for")) return !isMemberAccess(src, beforePrev);
  return (
    isIdentText(src, prev, "await") &&
    isIdentText(src, beforePrev, "for") &&
    !isMemberAccess(src, beforeBeforePrev)
  );
}

function isForOfOperator(src: string, prev: JsToken | undefined, state: BracketState): boolean {
  if (!state.forHeadDepths.has(state.brackets.length) || !prev) return false;
  if (prev.type === "ident" && ["const", "let", "var"].includes(jsTokenText(src, prev))) {
    return false;
  }
  if (
    prev.type === "string" ||
    prev.type === "template" ||
    prev.type === "regex" ||
    prev.type === "number" ||
    prev.type === "ident"
  ) {
    return true;
  }
  if (prev.type !== "punct") return false;
  return [")", "]", "}", "++", "--"].includes(jsTokenText(src, prev));
}

function hasContextualBinding(state: BracketState, name: string): boolean {
  for (const [depth, bindings] of state.contextualBindingsByDepth) {
    if (depth <= state.brackets.length && bindings.has(name)) return true;
  }
  return false;
}

function contextualIdentifierIsValue(
  src: string,
  text: string,
  prev: JsToken | undefined,
  state: BracketState,
): boolean {
  if (text === "of") return !isForOfOperator(src, prev, state);
  if (text !== "await" && text !== "yield") return false;
  const mode = currentContextualKeywordMode(state);
  if (mode) return text === "await" ? !mode.awaitIsKeyword : !mode.yieldIsKeyword;
  return hasContextualBinding(state, text);
}

function currentContextualKeywordMode(state: BracketState): ContextualKeywordMode | null {
  const functionDepth = state.activeFunctionModeDepths.at(-1) ?? -1;
  const functionMode =
    functionDepth >= 0 ? (state.functionBodyModes.get(functionDepth) ?? null) : null;
  const expression = state.expressionFunctionModes.at(-1);
  return expression && expression.depth >= functionDepth ? expression.mode : functionMode;
}

function isMemberAccess(src: string, token: JsToken | undefined): boolean {
  return (
    token?.type === "punct" && (jsTokenText(src, token) === "." || jsTokenText(src, token) === "?.")
  );
}

function pushPendingBody(
  bodiesByDepth: Map<number, PendingBodyKind[]>,
  depth: number,
  kind: PendingBodyKind,
): void {
  const bodies = bodiesByDepth.get(depth);
  if (bodies) bodies.push(kind);
  else bodiesByDepth.set(depth, [kind]);
}

function peekPendingBody(
  bodiesByDepth: Map<number, PendingBodyKind[]>,
  depth: number,
): PendingBodyKind | undefined {
  return bodiesByDepth.get(depth)?.at(-1);
}

function popPendingBody(bodiesByDepth: Map<number, PendingBodyKind[]>, depth: number): void {
  const bodies = bodiesByDepth.get(depth);
  bodies?.pop();
  if (bodies?.length === 0) bodiesByDepth.delete(depth);
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
