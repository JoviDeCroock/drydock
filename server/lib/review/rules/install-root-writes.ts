import { jsTokenText, tokenizeJs, type JsToken } from "../../platform/js-lexer";

// Whether a JavaScript file writes *into* the dependency install root, as
// opposed to merely naming it. `propagation.package-mutation` used to fire on a
// `node_modules` literal and a write call anywhere in the same install-time
// file, which cannot tell esbuild's postinstall (it `npm install`s its platform
// binary into a private temp dir, reads `<tmp>/node_modules/...`, and renames
// the binary into its own `bin/`) from a worm that rewrites the packages
// unpacked beside it. The attack shape is the write destination, so this
// follows the install-root path into write destinations.
//
// It is a token-level, intra-file, scope-insensitive taint walk, not a parser,
// and its uncertainties resolve toward "writes" so the finding stays loud:
//   - names are tainted file-wide by any assignment (destructuring, for-of/in
//     bindings, member targets) whose right side carries the install-root path;
//   - a function whose return value carries taint taints its name;
//   - a parameter is tainted when a local call site passes taint at its
//     position, and every parameter of a callback is tainted when the call it
//     is handed to carries taint anywhere else (`readdirSync(nm).forEach(f =>`,
//     `glob('node_modules/*', cb)`, an IIFE's arguments);
//   - an unbalanced sink call, a sink call embedded in a string (code handed to
//     `node -e`/eval), an oversized file, or a non-converging walk all count as
//     a write into the install root.
// Identifiers never assigned in the file (imports, globals) and parameters of
// functions only callable from another module are untainted: a path built in
// another module is outside this file's evidence, as it was for the file-level
// co-occurrence this replaces.

const MAX_SOURCE_CHARS = 2_000_000;
const MAX_TOKENS = 250_000;
const MAX_FIXPOINT_PASSES = 32;
const MAX_SCAN_WORK = 4_000_000;
const ANALYSIS_BUDGET_EXCEEDED = Symbol("install-root analysis budget exceeded");

// Destination argument position per write sink. Covers fs, fs/promises, and
// fs-extra spellings; a rename or copy *into* node_modules mutates it just as a
// write does.
const SINK_DESTINATION_ARG = new Map<string, number>([
  ...[
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "outputFile",
    "outputFileSync",
    "writeJson",
    "writeJsonSync",
    "outputJson",
    "outputJsonSync",
    "createWriteStream",
  ].map((name) => [name, 0] as const),
  ...[
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "copy",
    "copySync",
    "move",
    "moveSync",
    "rename",
    "renameSync",
    "link",
    "linkSync",
    "symlink",
    "symlinkSync",
  ].map((name) => [name, 1] as const),
]);

// Ordinary variable names too (`const copy = ...`, `link.href`); only their
// calls count, never their mere use as a value.
const GENERIC_SINK_NAMES = new Set(["cp", "copy", "move", "rename", "link", "symlink"]);

const EMBEDDED_SINK_CALL = new RegExp(
  `\\b(?:${[...SINK_DESTINATION_ARG.keys()].join("|")})\\s*\\(`,
);

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "||=", "??=", "&&="]);
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "function"]);
const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);
const IDENTIFIER_WORDS = /[A-Za-z_$][\w$]*/g;

interface Range {
  start: number;
  end: number;
}

interface FunctionDef {
  name: string | null;
  nameToken: number;
  /** Token span of the whole function, so a callback's own body is not its context. */
  span: Range;
  params: string[][];
  body: Range;
  concise: boolean;
  parent: number;
  taintedParams: Set<string>;
  /** Calls this function is handed to as a value; taint there taints every parameter. */
  contexts: Range[];
}

export function writesIntoInstallRoot(source: string, installRootPatterns: RegExp[]): boolean {
  try {
    return analyzeInstallRootWrites(source, installRootPatterns);
  } catch (error) {
    if (error === ANALYSIS_BUDGET_EXCEEDED) return true;
    throw error;
  }
}

function analyzeInstallRootWrites(source: string, installRootPatterns: RegExp[]): boolean {
  if (source.length > MAX_SOURCE_CHARS) return true;
  const src = source;
  const tokens = tokenizeJs(src).filter((token) => token.type !== "ws" && token.type !== "comment");
  if (tokens.length > MAX_TOKENS) return true;

  const texts = tokens.map((token) => jsTokenText(src, token));
  const text = (index: number) => texts[index] ?? "";
  const isPunct = (index: number, value: string) =>
    tokens[index]?.type === "punct" && text(index) === value;
  const isIdent = (index: number) => tokens[index]?.type === "ident" && !KEYWORDS.has(text(index));

  const matching = matchBrackets(tokens, text);
  const carriesRoot = tokens.map(
    (token, index) =>
      (token.type === "string" || token.type === "template" || token.type === "ident") &&
      installRootPatterns.some((pattern) => pattern.test(text(index))),
  );
  // A string or template that itself contains a write call is code handed to
  // something else to run; its destination cannot be followed from here.
  for (let index = 0; index < tokens.length; index += 1) {
    const type = tokens[index].type;
    if ((type === "string" || type === "template") && EMBEDDED_SINK_CALL.test(text(index))) {
      return true;
    }
  }
  const templateWords = tokens.map((token, index) =>
    token.type === "template" && text(index).includes("${")
      ? (text(index).match(IDENTIFIER_WORDS) ?? [])
      : [],
  );

  // Nested and chained ranges are rescanned (per assignment, per fixpoint
  // pass), so hostile shapes could make the walk quadratic; past the budget the
  // file counts as writing into the install root.
  let work = 0;
  const spend = () => {
    work += 1;
    if (work > MAX_SCAN_WORK) throw ANALYSIS_BUDGET_EXCEEDED;
  };
  const expressionEnd = (start: number): number => {
    for (let index = start; index < tokens.length; index += 1) {
      spend();
      const value = text(index);
      if (tokens[index].type === "punct") {
        if (value in OPENERS) {
          if (matching[index] < 0) return tokens.length;
          index = matching[index];
          continue;
        }
        if (CLOSERS.has(value) || value === ";" || value === ",") return index;
      }
      if (index > start && startsNewStatement(index)) return index;
    }
    return tokens.length;
  };
  // Automatic semicolon insertion, approximated: a line break between a value
  // and an identifier or literal ends the expression, so semicolon-free code
  // does not run one assignment's right side into the next statement.
  const startsNewStatement = (index: number): boolean => {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (!src.slice(previous.end, current.start).includes("\n")) return false;
    const previousText = text(index - 1);
    const previousEndsValue =
      previous.type === "ident" ||
      previous.type === "string" ||
      previous.type === "template" ||
      previous.type === "number" ||
      previous.type === "regex" ||
      previousText === ")" ||
      previousText === "]" ||
      previousText === "}";
    const currentStartsStatement =
      (current.type === "ident" && !["in", "of", "instanceof"].includes(text(index))) ||
      current.type === "string" ||
      current.type === "number" ||
      current.type === "template";
    return previousEndsValue && currentStartsStatement;
  };

  const functions = collectFunctions(tokens, text, isPunct, isIdent, matching, expressionEnd);
  const innermost = innermostFunctions(tokens.length, functions);

  const globalTaint = new Set<string>();
  const nameTainted = (name: string, position: number): boolean => {
    if (globalTaint.has(name)) return true;
    for (let fn = innermost[position]; fn >= 0; fn = functions[fn].parent) {
      spend();
      const def = functions[fn];
      if (def.params.some((names) => names.includes(name))) return def.taintedParams.has(name);
    }
    return false;
  };
  const rangeTainted = ({ start, end }: Range): boolean => {
    for (let index = start; index < end && index < tokens.length; index += 1) {
      spend();
      if (carriesRoot[index]) return true;
      if (tokens[index].type === "ident" && nameTainted(text(index), index)) return true;
      for (const word of templateWords[index]) if (nameTainted(word, index)) return true;
    }
    return false;
  };

  const assignments = collectAssignments(tokens, text, isPunct, isIdent, matching, expressionEnd);
  const returns: Array<{ fn: number; value: Range }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === "ident" && text(index) === "return" && innermost[index] >= 0) {
      returns.push({
        fn: innermost[index],
        value: { start: index + 1, end: expressionEnd(index + 1) },
      });
    }
  }
  functions.forEach((def, fn) => {
    if (def.concise) returns.push({ fn, value: def.body });
  });
  const enclosingOpen = enclosingOpeners(tokens, text, matching);
  // The call a function value is handed to, minus the function itself:
  // `callee.chain(otherArgs, <fn>, moreArgs)`, or an IIFE's argument list.
  const callContext = (start: number, end: number): Range[] => {
    const open = enclosingOpen[start];
    if (open < 0 || text(open) !== "(" || matching[open] < 0) return [];
    const close = matching[open];
    const before = tokens[open - 1];
    const isCall =
      before &&
      ((before.type === "ident" && !CONTROL_KEYWORDS.has(text(open - 1))) ||
        text(open - 1) === ")" ||
        text(open - 1) === "]");
    if (isCall) {
      return [
        { start: calleeStart(open, tokens, text, isPunct, matching), end: start },
        { start: end, end: close },
      ];
    }
    if (isPunct(close + 1, "(") && matching[close + 1] > close) {
      return [{ start: close + 2, end: matching[close + 1] }];
    }
    return [];
  };
  for (const def of functions) def.contexts.push(...callContext(def.span.start, def.span.end));
  const callSites = collectCallSites(
    tokens,
    text,
    isPunct,
    matching,
    functions,
    callContext,
    spend,
  );

  let changed = true;
  for (let pass = 0; changed; pass += 1) {
    if (pass >= MAX_FIXPOINT_PASSES) return true;
    changed = false;
    for (const assignment of assignments) {
      if (assignment.targets.every((name) => globalTaint.has(name))) continue;
      if (!rangeTainted(assignment.value)) continue;
      for (const name of assignment.targets) globalTaint.add(name);
      changed = true;
    }
    for (const { fn, value } of returns) {
      const name = functions[fn].name;
      if (!name || globalTaint.has(name) || !rangeTainted(value)) continue;
      globalTaint.add(name);
      changed = true;
    }
    for (const def of functions) {
      const names = def.params.flat();
      if (names.every((name) => def.taintedParams.has(name))) continue;
      if (!def.contexts.some(rangeTainted)) continue;
      for (const name of names) def.taintedParams.add(name);
      changed = true;
    }
    for (const { fn, args } of callSites) {
      const def = functions[fn];
      args.forEach((arg, position) => {
        const names = arg.spread ? def.params.slice(position).flat() : (def.params[position] ?? []);
        if (names.every((name) => def.taintedParams.has(name)) || !rangeTainted(arg)) return;
        for (const name of names) def.taintedParams.add(name);
        changed = true;
      });
    }
  }

  // Import specifiers and destructuring keep the sink's own name, so its later
  // calls are still recognised; renaming it (`as w`, `{ writeFile: w }`) or
  // using it any other way is an alias. An object-literal key (`{ writeFile:
  // async () => ... }`) defines a wrapper that is itself called by that name.
  const sinkUsedAsValue = (index: number): boolean => {
    const next = text(index + 1);
    const open = enclosingOpen[index];
    if (open >= 0 && text(open) === "{" && matching[open] > index) {
      const after = text(matching[open] + 1);
      const binding = after === "=" || after === "from" || text(open - 1) === "import";
      if (binding) return next === "as" || next === ":";
      if (next === ":") return false;
    }
    return true;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "ident") continue;
    const destinationIndex = SINK_DESTINATION_ARG.get(text(index));
    if (destinationIndex === undefined) continue;
    if (text(index - 1) === "function") continue;
    const open = isPunct(index + 1, "(")
      ? index + 1
      : isPunct(index + 1, "?.") && isPunct(index + 2, "(")
        ? index + 2
        : -1;
    if (open < 0) {
      // A sink taken as a value (`w = fs.writeFileSync`, `.call`, `promisify`,
      // `import { writeFile as w }`) writes through a name this walk does not
      // follow, so the destination is unknown.
      if (!GENERIC_SINK_NAMES.has(text(index)) && sinkUsedAsValue(index)) return true;
      continue;
    }
    const close = matching[open];
    if (close < 0) return true;
    const args = splitArguments(open, close, text, isPunct, matching);
    const spreadAt = args.findIndex((arg) => arg.spread);
    const destination =
      spreadAt >= 0 && spreadAt <= destinationIndex
        ? { start: open + 1, end: close }
        : args[destinationIndex];
    if (destination && rangeTainted(destination)) return true;
  }
  return false;
}

function matchBrackets(tokens: JsToken[], text: (index: number) => string): Int32Array {
  const matching = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "punct") continue;
    const value = text(index);
    if (value in OPENERS) {
      stack.push(index);
    } else if (CLOSERS.has(value)) {
      // Recover from a stray closer by unwinding to its opener; unmatched
      // openers keep -1, which every caller treats as "cannot follow".
      let at = stack.length - 1;
      while (at >= 0 && OPENERS[text(stack[at])] !== value) at -= 1;
      if (at < 0) continue;
      const open = stack[at];
      stack.length = at;
      matching[open] = index;
      matching[index] = open;
    }
  }
  return matching;
}

function splitArguments(
  open: number,
  close: number,
  text: (index: number) => string,
  isPunct: (index: number, value: string) => boolean,
  matching: Int32Array,
): Array<Range & { spread: boolean }> {
  const args: Array<Range & { spread: boolean }> = [];
  let start = open + 1;
  for (let index = open + 1; index <= close; index += 1) {
    if (index < close && text(index) in OPENERS && matching[index] > index) {
      index = matching[index];
      continue;
    }
    if (index === close || isPunct(index, ",")) {
      if (index > start) args.push({ start, end: index, spread: isPunct(start, "...") });
      start = index + 1;
    }
  }
  return args;
}

function rangeIdentifiers(
  range: Range,
  isIdent: (index: number) => boolean,
  text: (index: number) => string,
): string[] {
  const names: string[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    if (isIdent(index)) names.push(text(index));
  }
  return names;
}

function collectFunctions(
  tokens: JsToken[],
  text: (index: number) => string,
  isPunct: (index: number, value: string) => boolean,
  isIdent: (index: number) => boolean,
  matching: Int32Array,
  expressionEnd: (start: number) => number,
): FunctionDef[] {
  const functions: FunctionDef[] = [];
  const paramList = (open: number, close: number): string[][] => {
    const params: string[][] = [];
    let start = open + 1;
    for (let index = open + 1; index <= close; index += 1) {
      if (index < close && text(index) in OPENERS && matching[index] > index) {
        index = matching[index];
        continue;
      }
      if (index === close || isPunct(index, ",")) {
        if (index > start) params.push(rangeIdentifiers({ start, end: index }, isIdent, text));
        start = index + 1;
      }
    }
    return params;
  };
  // `name = function`, `name: () =>`, `const name = async x =>`.
  const boundName = (before: number): { name: string | null; token: number } => {
    let index = before;
    if (text(index) === "async") index -= 1;
    if ((isPunct(index, "=") || isPunct(index, ":")) && isIdent(index - 1)) {
      return { name: text(index - 1), token: index - 1 };
    }
    return { name: null, token: -1 };
  };
  const add = (
    name: { name: string | null; token: number },
    span: Range,
    params: string[][],
    body: Range,
    concise: boolean,
  ) => {
    if (text(span.start - 1) === "async") span.start -= 1;
    functions.push({
      name: name.name,
      nameToken: name.token,
      span,
      params,
      body,
      concise,
      parent: -1,
      taintedParams: new Set(),
      contexts: [],
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "ident" && text(index) === "function") {
      let cursor = index + 1;
      if (isPunct(cursor, "*")) cursor += 1;
      let name = boundName(index - 1);
      if (isIdent(cursor)) {
        name = { name: text(cursor), token: cursor };
        cursor += 1;
      }
      if (!isPunct(cursor, "(") || matching[cursor] < 0) continue;
      const bodyOpen = matching[cursor] + 1;
      if (!isPunct(bodyOpen, "{") || matching[bodyOpen] < 0) continue;
      add(
        name,
        { start: index, end: matching[bodyOpen] + 1 },
        paramList(cursor, matching[cursor]),
        { start: bodyOpen + 1, end: matching[bodyOpen] },
        false,
      );
    } else if (token.type === "punct" && text(index) === "=>") {
      let params: string[][];
      let start: number;
      if (isPunct(index - 1, ")") && matching[index - 1] >= 0) {
        params = paramList(matching[index - 1], index - 1);
        start = matching[index - 1];
      } else if (isIdent(index - 1)) {
        params = [[text(index - 1)]];
        start = index - 1;
      } else {
        continue;
      }
      const name = boundName(start - 1);
      if (isPunct(index + 1, "{") && matching[index + 1] >= 0) {
        const end = matching[index + 1];
        add(name, { start, end: end + 1 }, params, { start: index + 2, end }, false);
      } else {
        const end = expressionEnd(index + 1);
        add(name, { start, end }, params, { start: index + 1, end }, true);
      }
    } else if (
      isIdent(index) &&
      !CONTROL_KEYWORDS.has(text(index)) &&
      !isPunct(index - 1, ".") &&
      text(index - 1) !== "function" &&
      isPunct(index + 1, "(") &&
      matching[index + 1] >= 0 &&
      isPunct(matching[index + 1] + 1, "{") &&
      matching[matching[index + 1] + 1] >= 0
    ) {
      // Method shorthand: `name(params) { ... }` in a class or object literal.
      const bodyOpen = matching[index + 1] + 1;
      add(
        { name: text(index), token: index },
        { start: index, end: matching[bodyOpen] + 1 },
        paramList(index + 1, matching[index + 1]),
        { start: bodyOpen + 1, end: matching[bodyOpen] },
        false,
      );
    }
  }
  return functions;
}

function innermostFunctions(tokenCount: number, functions: FunctionDef[]): Int32Array {
  const innermost = new Int32Array(tokenCount).fill(-1);
  const order = functions
    .map((_, fn) => fn)
    .sort(
      (a, b) =>
        functions[a].body.start - functions[b].body.start ||
        functions[b].body.end - functions[a].body.end,
    );
  const stack: number[] = [];
  let next = 0;
  for (let index = 0; index < tokenCount; index += 1) {
    while (stack.length && functions[stack[stack.length - 1]].body.end <= index) stack.pop();
    while (next < order.length && functions[order[next]].body.start <= index) {
      const fn = order[next];
      next += 1;
      while (
        stack.length &&
        functions[stack[stack.length - 1]].body.end <= functions[fn].body.start
      ) {
        stack.pop();
      }
      functions[fn].parent = stack.length ? stack[stack.length - 1] : -1;
      stack.push(fn);
    }
    innermost[index] = stack.length ? stack[stack.length - 1] : -1;
  }
  return innermost;
}

function collectAssignments(
  tokens: JsToken[],
  text: (index: number) => string,
  isPunct: (index: number, value: string) => boolean,
  isIdent: (index: number) => boolean,
  matching: Int32Array,
  expressionEnd: (start: number) => number,
): Array<{ targets: string[]; value: Range }> {
  const assignments: Array<{ targets: string[]; value: Range }> = [];
  // `a.b.c` / `a[b]` / `{ x, y: z }` / `[p, q]` immediately before `end`.
  const targetNames = (end: number): string[] => {
    const value = text(end);
    if ((value === "}" || value === "]") && matching[end] >= 0) {
      const open = matching[end];
      const names = rangeIdentifiers({ start: open + 1, end }, isIdent, text);
      if (value === "]") names.push(...memberChain(open - 1));
      return names;
    }
    return memberChain(end);
  };
  const memberChain = (end: number): string[] => {
    const names: string[] = [];
    let index = end;
    while (index >= 0) {
      if (isIdent(index)) names.push(text(index));
      else if (text(index) !== "this") break;
      if (isPunct(index - 1, ".") || isPunct(index - 1, "?.")) index -= 2;
      else break;
    }
    return names;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct" && ASSIGNMENT_OPERATORS.has(text(index)) && index > 0) {
      const targets = targetNames(index - 1);
      if (targets.length) {
        assignments.push({ targets, value: { start: index + 1, end: expressionEnd(index + 1) } });
      }
    } else if (token.type === "ident" && text(index) === "for") {
      const open = isPunct(index + 1, "(") ? index + 1 : isPunct(index + 2, "(") ? index + 2 : -1;
      if (open < 0 || matching[open] < 0) continue;
      const close = matching[open];
      for (let cursor = open + 1; cursor < close; cursor += 1) {
        if (text(cursor) in OPENERS && matching[cursor] > cursor) {
          cursor = matching[cursor];
          continue;
        }
        if (tokens[cursor].type === "ident" && (text(cursor) === "of" || text(cursor) === "in")) {
          const targets = rangeIdentifiers({ start: open + 1, end: cursor }, isIdent, text);
          if (targets.length)
            assignments.push({ targets, value: { start: cursor + 1, end: close } });
          break;
        }
      }
    }
  }
  return assignments;
}

function collectCallSites(
  tokens: JsToken[],
  text: (index: number) => string,
  isPunct: (index: number, value: string) => boolean,
  matching: Int32Array,
  functions: FunctionDef[],
  callContext: (start: number, end: number) => Range[],
  spend: () => void,
): Array<{ fn: number; args: Array<Range & { spread: boolean }> }> {
  const byName = new Map<string, number[]>();
  functions.forEach((def, fn) => {
    if (!def.name) return;
    const defs = byName.get(def.name);
    if (defs) defs.push(fn);
    else byName.set(def.name, [fn]);
  });
  const definitionTokens = new Set(functions.map((def) => def.nameToken));
  const calls: Array<{ fn: number; args: Array<Range & { spread: boolean }> }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "ident" || definitionTokens.has(index)) continue;
    const defs = byName.get(text(index));
    if (!defs) continue;
    if (!isPunct(index + 1, "(") || matching[index + 1] < 0) {
      // Handed over as a value (`list.forEach(inject)`): the call it is passed
      // to supplies its arguments.
      const contexts = callContext(index, index + 1);
      for (const fn of defs) {
        spend();
        functions[fn].contexts.push(...contexts);
      }
      continue;
    }
    const args = splitArguments(index + 1, matching[index + 1], text, isPunct, matching);
    for (const fn of defs) {
      spend();
      calls.push({ fn, args });
    }
  }
  return calls;
}

// Innermost unclosed bracket before each token.
function enclosingOpeners(
  tokens: JsToken[],
  text: (index: number) => string,
  matching: Int32Array,
): Int32Array {
  const enclosing = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    while (stack.length && matching[stack[stack.length - 1]] < index) stack.pop();
    enclosing[index] = stack.length ? stack[stack.length - 1] : -1;
    if (tokens[index].type === "punct" && text(index) in OPENERS && matching[index] > index) {
      stack.push(index);
    }
  }
  return enclosing;
}

// Start of the callee expression whose call opens at `open`: `a.b(x).forEach`
// walks back to `a`, `[nm].forEach` to `[`.
function calleeStart(
  open: number,
  tokens: JsToken[],
  text: (index: number) => string,
  isPunct: (index: number, value: string) => boolean,
  matching: Int32Array,
): number {
  let index = open - 1;
  while (index >= 0) {
    const value = text(index);
    if (tokens[index].type === "punct" && (value === ")" || value === "]")) {
      if (matching[index] < 0) return index + 1;
      index = matching[index];
      const before = tokens[index - 1];
      if (before && (before.type === "ident" || [")", "]"].includes(text(index - 1)))) {
        index -= 1;
        continue;
      }
      return index;
    }
    if (tokens[index].type === "punct") return index + 1;
    if (isPunct(index - 1, ".") || isPunct(index - 1, "?.")) {
      index -= 2;
      continue;
    }
    return index;
  }
  return 0;
}
