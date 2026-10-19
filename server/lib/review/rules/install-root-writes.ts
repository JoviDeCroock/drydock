import { jsTokenText, tokenizeJs, type JsToken } from "../../platform/js-lexer";

// Whether every file write in an install-time JavaScript file provably lands
// in the package's own directory (or a temp or home directory). Naming
// `node_modules` and writing a file is every native-binary installer — esbuild
// `npm install`s its platform binary into a private dir under its own `lib/`
// and renames it into place — so `propagation.package-mutation` keeps its old
// co-occurrence verdict unless this proves otherwise.
//
// The proof is a small abstract evaluator over tokens, not a parser. Path
// values are concrete strings with symbolic roots for the package directory,
// temp and home; `__dirname`, `import.meta`, `require.resolve` of the package's
// own name or a relative specifier, `os.tmpdir()`, `mkdtemp` and the
// `process.cwd()` of an install script (absent `chdir`) are the anchors, and
// `path.join` / `resolve` / `dirname` / `basename`, `+`, templates, string
// `replace`, array `join`, object and array literals, local function returns
// and call-site arguments carry them. A `..` that climbs out of the package
// or a `node_modules` segment fails the proof.
//
// Everything else fails it too: an identifier with no local definition, an
// import, `require.resolve` of another package, `module.paths`, environment
// variables, a directory listing, a callback the file does not call itself, an
// object or array the file mutates or hands to a call, an evaluation that
// does not converge or exceeds its budget, a sink taken as a value or embedded
// in a string, and an assignment the token scan cannot see (inside a template
// interpolation, `eval`, `with`). A shell command is a write when it runs
// `cp` / `mv` / `ln` / `install` / `rsync` / `tee` / `dd` or redirects output;
// its destinations must be plain relative paths. A command whose text is not
// known is not treated as a write, the one deliberate gap: other rules see the
// process execution itself.

const MAX_SOURCE_CHARS = 2_000_000;
const MAX_TOKENS = 250_000;
const MAX_WORK = 3_000_000;
const MAX_VALUES = 256;
const MAX_IMPORTS = 8;
const MAX_DEPTH = 200;
const MAX_TEMPLATE_CHARS = 20_000;
const MAX_TEMPLATE_INTERPOLATIONS = 64;

export interface InstallWriteOrigin {
  /** Package-relative path of the analysed file. */
  filePath: string;
  packageName?: string | null;
  packageMain?: string | null;
}

export interface InstallWriteVerdict {
  /** A write's destination is not proven to stay in the package's own, a temp or the home directory. */
  unproven: boolean;
  /** 1-based line of the first unproven write, when one is known. */
  line?: number;
  /** Some write's destination is concretely above the package directory or inside a `node_modules`. */
  intoInstallRoot: boolean;
  /** Relative module specifiers an unproven destination was imported from. */
  importedFrom: string[];
  /**
   * 1-based line of the first path the file builds above its own package or
   * inside a `node_modules` (a parent climb, another package's resolved path),
   * whether or not a write is seen to use it.
   */
  climbLine?: number;
}

const OWN = "\u0000own";
const TMP = "\u0000tmp";
const HOME = "\u0000home";
// Above the package directory: the directory dependencies are unpacked into.
const ESCAPED = "\u0000escaped";
// A path the evaluator could not place.
const UNRESOLVED = "\u0000unresolved";
const SYMBOLIC_ROOTS = [OWN, TMP, HOME, ESCAPED, UNRESOLVED];

// Destination argument per write sink (fs, fs/promises, fs-extra spellings).
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
    "writeJSON",
    "writeJSONSync",
    "outputJson",
    "outputJsonSync",
    "outputJSON",
    "outputJSONSync",
    "createWriteStream",
    "open",
    "openSync",
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
    "ensureLink",
    "ensureLinkSync",
    "ensureSymlink",
    "ensureSymlinkSync",
  ].map((name) => [name, 1] as const),
]);
// Ordinary words too (`copy(text)`, `router.move(a, b)`, the `open` package);
// they count only on an fs-looking receiver or an fs binding.
const GENERIC_SINK_NAMES = new Set(["cp", "copy", "move", "rename", "link", "symlink", "open"]);
const FS_RECEIVER = /^(?:fs\w*|fse|fsp|fsx|fsExtra|fsPromises|promises|gracefulFs)$/i;
const OPEN_SINKS = new Set(["open", "openSync"]);
const EMBEDDED_SINK_CALL = new RegExp(
  `\\b(?:${[...SINK_DESTINATION_ARG.keys()].filter((name) => !GENERIC_SINK_NAMES.has(name)).join("|")})\\s*\\(`,
);
const EXEC_SHELL = new Set(["exec", "execSync", "execaCommand", "execaCommandSync"]);
const EXEC_ARGV = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "execa", "execaSync"]);
const SHELL_WRITE_PROGRAMS = new Set(["cp", "mv", "ln", "install", "rsync", "tee", "dd"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash"]);
const SHELL_WRITE_TEXT =
  /(?:^|[;&|(`\n]\s*|\bsudo\s+)(?:cp|mv|ln|install|rsync|tee|dd)\s|(?:^|[^\d&>=-])>>?\s*(?!&|\/dev\/null)[^\s&>]/;

const BUILTIN_MODULES = new Map<string, string>([
  ["path", "path"],
  ["path/posix", "path"],
  ["os", "os"],
  ["fs", "fs"],
  ["fs/promises", "fs"],
  ["fs-extra", "fs"],
  ["graceful-fs", "fs"],
  ["url", "url"],
  ["module", "nodemodule"],
  ["process", "process"],
]);
const PATH_BUILDER_NAMES = new Set(["join", "resolve", "dirname", "normalize"]);
const PATH_BUILDERS = new Set(["path.join", "path.resolve", "path.dirname", "path.normalize"]);
const INTEROP_HELPERS = new Set([
  "__toESM",
  "__importDefault",
  "__importStar",
  "_interopRequireDefault",
  "_interopRequireWildcard",
]);
const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "flatMap",
]);
const NON_MUTATING_METHODS = new Set([
  ...ITERATION_METHODS,
  "join",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "concat",
  "at",
  "keys",
  "values",
  "entries",
  "toString",
  "hasOwnProperty",
]);

const ASSIGNMENT_OPERATORS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "||=",
  "??=",
  "&&=",
]);
const BINARY_PRECEDENCE = new Map<string, number>([
  ["??", 1],
  ["||", 1],
  ["&&", 2],
  ["|", 3],
  ["^", 4],
  ["&", 5],
  ["==", 6],
  ["!=", 6],
  ["===", 6],
  ["!==", 6],
  ["<", 7],
  [">", 7],
  ["<=", 7],
  [">=", 7],
  ["in", 7],
  ["instanceof", 7],
  ["<<", 8],
  [">>", 8],
  [">>>", 8],
  ["+", 9],
  ["-", 9],
  ["*", 10],
  ["/", 10],
  ["%", 10],
  ["**", 11],
]);
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

interface Range {
  start: number;
  end: number;
}

type Node =
  | { k: "str"; v: string }
  | { k: "tpl"; parts: Array<string | Node> }
  | { k: "id"; name: string; pos: number }
  | { k: "member"; obj: Node; prop: string | Node }
  | { k: "call"; callee: Node; args: Node[] }
  | { k: "concat"; l: Node; r: Node }
  | { k: "union"; options: Node[] }
  | { k: "arr"; items: Node[] }
  | { k: "obj"; props: Map<string, Node>; open: boolean }
  | { k: "fn"; fn: number }
  | { k: "spread"; arg: Node }
  | { k: "meta" }
  | { k: "mod"; name: string }
  | { k: "elem"; of: Node }
  | { k: "param"; fn: number; index: number }
  | { k: "top"; imports?: string[] };

type Item =
  | string
  | { t: "obj"; props: Map<string, Node>; open: boolean }
  | { t: "arr"; items: Node[] }
  | { t: "fn"; fn: number }
  | { t: "mod"; name: string }
  | { t: "builtin"; name: string };

interface Value {
  top: boolean;
  items: Item[];
  imports: string[];
  /** Built on a path already in the install root, even if the rest is unknown. */
  rootward?: boolean;
}

const TOP_NODE: Node = { k: "top" };
const NOTHING: Node = { k: "union", options: [] };

interface FunctionInfo {
  name: string | null;
  nameToken: number;
  /** First token, including `async`. */
  start: number;
  end: number;
  params: Range[];
  body: Range;
  concise: boolean;
  method: boolean;
  exported: boolean;
}

interface Def {
  /** Token index after which the binding holds `node`. */
  pos: number;
  /** First token of the defining statement, for dominance. */
  statement: number;
  node: Node;
  dominates: boolean;
  /** Enclosing `{` of the defining statement, or -1 for the function or module top. */
  block: number;
  fn: number;
}

interface Binding {
  id: number;
  name: string;
  scope: Range;
  owner: number;
  defs: Def[];
}

interface Stream {
  tokens: JsToken[];
  texts: string[];
  matching: Int32Array;
  /** Main-stream token index identifiers parsed here resolve at. */
  at: (index: number) => number;
}

class AnalysisAbandoned extends Error {}

export function analyzeInstallWrites(
  source: string,
  origin: InstallWriteOrigin,
): InstallWriteVerdict {
  try {
    return new InstallWriteAnalysis(source, origin).run();
  } catch (error) {
    // A stack overflow on a hostile nesting depth is the same verdict.
    if (error instanceof AnalysisAbandoned || error instanceof RangeError) {
      return { unproven: true, intoInstallRoot: false, importedFrom: [] };
    }
    throw error;
  }
}

class InstallWriteAnalysis {
  private readonly main: Stream;
  private readonly tokens: JsToken[];
  private readonly matching: Int32Array;
  private readonly enclosing: Int32Array;
  private readonly innermost: Int32Array;
  private readonly functions: FunctionInfo[] = [];
  private readonly functionAt = new Map<number, number>();
  private readonly methodAt = new Map<number, number>();
  private readonly bindings = new Map<string, Binding[]>();
  private readonly occurrences = new Map<string, number[]>();
  /** Every name used inside a template interpolation. */
  private readonly templateNames = new Set<string>();
  /** Names an interpolation hands to a call or calls a possibly mutating method on. */
  private readonly templateMutations = new Set<string>();
  /** Names an interpolation hands to a call. */
  private readonly templateArguments = new Set<string>();
  private readonly loops: Range[] = [];
  private readonly loopHeads: Array<{ open: number }> = [];
  private readonly returns = new Map<number, Node[]>();
  private readonly parsed = new Map<string, Node>();
  private readonly memo = new Map<Node | string, Value>();
  private readonly inProgress = new Set<Node | string>();
  private readonly mutatedCache = new Map<string, boolean>();
  private readonly paramSourceCache = new Map<number, ParamSources | null>();
  private readonly fileDir: string;
  private readonly fileName: string;
  private cwdKnown = true;
  private failClosed = false;
  private work = 0;
  private depth = 0;
  private bindingCount = 0;

  constructor(
    private readonly src: string,
    private readonly origin: InstallWriteOrigin,
  ) {
    if (src.length > MAX_SOURCE_CHARS) throw new AnalysisAbandoned();
    const tokens = tokenizeJs(src).filter(
      (token) => token.type !== "ws" && token.type !== "comment",
    );
    if (tokens.length > MAX_TOKENS) throw new AnalysisAbandoned();
    this.tokens = tokens;
    const texts = tokens.map((token) => jsTokenText(src, token));
    this.matching = matchBrackets(tokens, texts);
    this.main = { tokens, texts, matching: this.matching, at: (index) => index };
    this.enclosing = enclosingOpeners(tokens, texts, this.matching);
    const relative = normalizeRelative(origin.filePath);
    this.fileName = `${OWN}/${relative}`;
    this.fileDir = relative.includes("/")
      ? `${OWN}/${relative.slice(0, relative.lastIndexOf("/"))}`
      : OWN;
    this.collectFunctions();
    this.innermost = innermostFunctions(tokens.length, this.functions);
    this.scanTemplates();
    this.scanStatements();
  }

  run(): InstallWriteVerdict {
    let line: number | undefined;
    let climbLine: number | undefined;
    let intoInstallRoot = false;
    const imports = new Set<string>();
    const fail = (index: number, value?: Value) => {
      line ??= this.lineOf(index);
      for (const specifier of value?.imports ?? []) imports.add(specifier);
      if (
        value?.rootward ||
        (value &&
          !value.top &&
          value.items.some((item) => typeof item === "string" && this.installRootPath(item)))
      ) {
        intoInstallRoot = true;
      }
    };
    for (let index = 0; index < this.tokens.length; index += 1) {
      if (this.tokens[index].type === "string" || this.tokens[index].type === "template") {
        // Write code handed to another interpreter cannot be followed.
        if (EMBEDDED_SINK_CALL.test(this.text(index))) fail(index);
        if (this.computedSinkMember(index)) fail(index);
        continue;
      }
      if (this.computedFsCall(index)) fail(index);
      if (this.tokens[index].type !== "ident") continue;
      const name = this.text(index);
      if (SINK_DESTINATION_ARG.has(name)) this.checkFsSink(index, name, fail);
      else if (EXEC_SHELL.has(name) || EXEC_ARGV.has(name)) this.checkExec(index, name, fail);
      if (climbLine === undefined && PATH_BUILDER_NAMES.has(name) && this.climbs(index)) {
        climbLine = this.lineOf(index);
      }
    }
    const unproven = line !== undefined || this.failClosed;
    return {
      unproven,
      ...(line !== undefined ? { line } : {}),
      intoInstallRoot,
      importedFrom: [...imports].slice(0, MAX_IMPORTS),
      ...(climbLine !== undefined ? { climbLine } : {}),
    };
  }

  // A path-module call or `require.resolve` whose result leaves the package.
  // An unknown base climbed with an explicit `..`, and an unknown specifier
  // resolved, count too: neither can be shown to stay home.
  private climbs(index: number): boolean {
    if (this.methodAt.has(index) || this.text(index - 1) === "function") return false;
    const open = this.callOpen(index);
    if (open < 0 || this.matching[open] < 0) return false;
    const start = calleeStart(index + 1, this.tokens, this.main.texts, this.matching);
    const callee = this.parse(this.main, start, index + 1);
    const calleeValue = this.evaluate(callee);
    if (calleeValue.top || !calleeValue.items.length) return false;
    const builtins = calleeValue.items.map((item) =>
      typeof item !== "string" && item.t === "builtin" ? item.name : null,
    );
    const resolve = builtins.every((name) => name === "require.resolve");
    if (!resolve && !builtins.every((name) => name !== null && PATH_BUILDERS.has(name))) {
      return false;
    }
    const args = this.callArguments(open);
    const value = this.evaluate({ k: "call", callee, args });
    if (value.rootward) return true;
    if (!value.top) {
      return value.items.some((item) => typeof item === "string" && this.installRootPath(item));
    }
    if (resolve) return true;
    return args.some((arg) => {
      if (arg.k === "spread") return false;
      const part = this.evaluate(arg);
      return (
        !part.top &&
        part.items.some((item) => typeof item === "string" && item.split(/[/\\]/).includes(".."))
      );
    });
  }

  // ---- token helpers ----------------------------------------------------

  private text(index: number): string {
    return this.main.texts[index] ?? "";
  }

  private isPunct(index: number, value: string): boolean {
    return this.tokens[index]?.type === "punct" && this.text(index) === value;
  }

  private isIdent(index: number): boolean {
    return this.tokens[index]?.type === "ident" && !KEYWORDS.has(this.text(index));
  }

  private memberAccessed(index: number): boolean {
    return this.isPunct(index - 1, ".") || this.isPunct(index - 1, "?.");
  }

  private lineOf(index: number): number {
    const offset = this.tokens[index]?.start ?? 0;
    let line = 1;
    for (let at = 0; at < offset; at += 1) if (this.src.charCodeAt(at) === 10) line += 1;
    return line;
  }

  private spend(units = 1): void {
    this.work += units;
    if (this.work > MAX_WORK) throw new AnalysisAbandoned();
  }

  private newlineBefore(index: number): boolean {
    const previous = this.tokens[index - 1];
    const current = this.tokens[index];
    return Boolean(
      previous && current && this.src.slice(previous.end, current.start).includes("\n"),
    );
  }

  // Automatic semicolon insertion, approximated: a line break between a value
  // and an identifier or literal ends the expression.
  private startsNewStatement(index: number): boolean {
    if (!this.newlineBefore(index)) return false;
    const previous = this.tokens[index - 1];
    const current = this.tokens[index];
    const previousText = this.text(index - 1);
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
      (current.type === "ident" && !["in", "of", "instanceof"].includes(this.text(index))) ||
      current.type === "string" ||
      current.type === "number" ||
      current.type === "template";
    return previousEndsValue && currentStartsStatement;
  }

  private expressionEnd(start: number): number {
    for (let index = start; index < this.tokens.length; index += 1) {
      this.spend();
      const value = this.text(index);
      if (this.tokens[index].type === "punct") {
        if (value in OPENERS) {
          if (this.matching[index] < 0) return this.tokens.length;
          index = this.matching[index];
          continue;
        }
        if (CLOSERS.has(value) || value === ";" || value === ",") return index;
      }
      if (index > start && this.startsNewStatement(index)) return index;
    }
    return this.tokens.length;
  }

  // ---- structure ---------------------------------------------------------

  private collectFunctions(): void {
    const paramList = (open: number, close: number): Range[] =>
      splitRanges(this.main, open + 1, close).map(({ start, end }) => ({ start, end }));
    const boundName = (before: number): { name: string | null; token: number } => {
      let index = before;
      if (this.text(index) === "async") index -= 1;
      if ((this.isPunct(index, "=") || this.isPunct(index, ":")) && this.isIdent(index - 1)) {
        return { name: this.text(index - 1), token: index - 1 };
      }
      return { name: null, token: -1 };
    };
    const add = (info: Omit<FunctionInfo, "start" | "exported">, head: number) => {
      const start = this.text(head - 1) === "async" ? head - 1 : head;
      const exported =
        this.text(start - 1) === "export" ||
        (this.text(start - 1) === "default" && this.text(start - 2) === "export") ||
        (info.nameToken >= 0 &&
          ["export"].includes(this.text(info.nameToken - 2)) &&
          ["const", "let", "var"].includes(this.text(info.nameToken - 1)));
      const fn = this.functions.length;
      this.functions.push({ ...info, start, exported });
      this.functionAt.set(head, fn);
      this.functionAt.set(start, fn);
      return fn;
    };

    for (let index = 0; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      if (token.type === "ident" && this.text(index) === "function") {
        let cursor = index + 1;
        if (this.isPunct(cursor, "*")) cursor += 1;
        let name = boundName(index - 1);
        if (this.isIdent(cursor)) {
          name = { name: this.text(cursor), token: cursor };
          cursor += 1;
        }
        if (!this.isPunct(cursor, "(") || this.matching[cursor] < 0) continue;
        const bodyOpen = this.matching[cursor] + 1;
        if (!this.isPunct(bodyOpen, "{") || this.matching[bodyOpen] < 0) continue;
        add(
          {
            name: name.name,
            nameToken: name.token,
            end: this.matching[bodyOpen] + 1,
            params: paramList(cursor, this.matching[cursor]),
            body: { start: bodyOpen + 1, end: this.matching[bodyOpen] },
            concise: false,
            method: false,
          },
          index,
        );
      } else if (token.type === "punct" && this.text(index) === "=>") {
        let params: Range[];
        let start: number;
        if (this.isPunct(index - 1, ")") && this.matching[index - 1] >= 0) {
          start = this.matching[index - 1];
          params = paramList(start, index - 1);
        } else if (this.isIdent(index - 1)) {
          start = index - 1;
          params = [{ start, end: index }];
        } else {
          continue;
        }
        const name = boundName((this.text(start - 1) === "async" ? start - 1 : start) - 1);
        if (this.isPunct(index + 1, "{") && this.matching[index + 1] >= 0) {
          const end = this.matching[index + 1];
          add(
            {
              name: name.name,
              nameToken: name.token,
              end: end + 1,
              params,
              body: { start: index + 2, end },
              concise: false,
              method: false,
            },
            start,
          );
        } else {
          const end = this.expressionEnd(index + 1);
          add(
            {
              name: name.name,
              nameToken: name.token,
              end,
              params,
              body: { start: index + 1, end },
              concise: true,
              method: false,
            },
            start,
          );
        }
      } else if (
        this.isIdent(index) &&
        !CONTROL_KEYWORDS.has(this.text(index)) &&
        !this.memberAccessed(index) &&
        this.text(index - 1) !== "function" &&
        this.isPunct(index + 1, "(") &&
        this.matching[index + 1] >= 0 &&
        this.isPunct(this.matching[index + 1] + 1, "{") &&
        this.matching[this.matching[index + 1] + 1] >= 0
      ) {
        // Method shorthand: `name(params) { ... }` in a class or object literal.
        const bodyOpen = this.matching[index + 1] + 1;
        const fn = add(
          {
            name: this.text(index),
            nameToken: index,
            end: this.matching[bodyOpen] + 1,
            params: paramList(index + 1, this.matching[index + 1]),
            body: { start: bodyOpen + 1, end: this.matching[bodyOpen] },
            concise: false,
            method: true,
          },
          index,
        );
        this.methodAt.set(index, fn);
      }
    }
  }

  // Interpolations are parsed on demand, so anything they could change is
  // settled up front: an assignment inside one is invisible to the
  // definition scan, and a name used there may be read or called from there.
  private scanTemplates(): void {
    for (let index = 0; index < this.tokens.length; index += 1) {
      if (this.tokens[index].type !== "template" || !this.text(index).includes("${")) continue;
      if (!templateWithinBudget(this.text(index))) {
        this.failClosed = true;
        continue;
      }
      for (const expression of templateExpressions(this.text(index))) {
        const stream = subStream(expression, index);
        stream.tokens.forEach((token, at) => {
          this.spend();
          const value = stream.texts[at];
          if (
            token.type === "punct" &&
            (ASSIGNMENT_OPERATORS.has(value) || value === "++" || value === "--")
          ) {
            this.failClosed = true;
          }
          if (token.type !== "ident") return;
          this.templateNames.add(value);
          const before = stream.texts[at - 1];
          if (before === "." || before === "?.") return;
          const after = stream.texts[at + 1];
          if ((before === "(" || before === ",") && (after === "," || after === ")")) {
            this.templateArguments.add(value);
            this.templateMutations.add(value);
          }
          if (
            (after === "." || after === "?.") &&
            stream.texts[at + 3] === "(" &&
            !NON_MUTATING_METHODS.has(stream.texts[at + 2])
          ) {
            this.templateMutations.add(value);
          }
        });
      }
    }
  }

  private scanStatements(): void {
    // Function declarations, parameters and returns.
    this.functions.forEach((info, fn) => {
      const head = info.start;
      if (info.name && info.nameToken >= 0 && this.text(info.nameToken - 1) === "function") {
        const scope = this.blockScope(info.start);
        this.declare(info.name, scope, this.innermost[info.start] ?? -1, {
          pos: scope.start,
          statement: info.start,
          node: { k: "fn", fn },
          dominates: true,
          block: -1,
          fn: this.innermost[info.start] ?? -1,
        });
      }
      info.params.forEach((range, position) => {
        const param: Node = { k: "param", fn, index: position };
        for (const binding of this.patternBindings(range.start, range.end, param)) {
          this.declare(binding.name, { start: info.start, end: info.end }, fn, {
            pos: head,
            statement: head,
            node: binding.node,
            dominates: true,
            block: -1,
            fn,
          });
        }
      });
      if (info.concise)
        this.returns.set(fn, [this.parse(this.main, info.body.start, info.body.end)]);
    });

    for (let index = 0; index < this.tokens.length; index += 1) {
      this.spend();
      const token = this.tokens[index];
      const value = this.text(index);
      if (token.type === "ident" && !this.memberAccessed(index)) {
        if (value === "var" || value === "let" || value === "const") {
          if (
            this.isIdent(index + 1) ||
            this.isPunct(index + 1, "{") ||
            this.isPunct(index + 1, "[")
          ) {
            this.declaration(index, value);
          }
        } else if (
          value === "import" &&
          !this.isPunct(index + 1, "(") &&
          !this.isPunct(index + 1, ".")
        ) {
          this.importDeclaration(index);
        } else if (value === "class" && this.isIdent(index + 1)) {
          const scope = this.blockScope(index);
          this.declare(this.text(index + 1), scope, this.innermost[index] ?? -1, {
            pos: scope.start,
            statement: index,
            node: TOP_NODE,
            dominates: true,
            block: -1,
            fn: this.innermost[index] ?? -1,
          });
        } else if (
          value === "catch" &&
          this.isPunct(index + 1, "(") &&
          this.matching[index + 1] > 0
        ) {
          const close = this.matching[index + 1];
          const body = close + 1;
          const scope = {
            start: index,
            end: this.matching[body] > 0 ? this.matching[body] : close,
          };
          for (const binding of this.patternBindings(index + 2, close, TOP_NODE)) {
            this.declare(binding.name, scope, this.innermost[index] ?? -1, {
              pos: index,
              statement: index,
              node: TOP_NODE,
              dominates: true,
              block: -1,
              fn: this.innermost[index] ?? -1,
            });
          }
        } else if (value === "return" && (this.innermost[index] ?? -1) >= 0) {
          const end = this.expressionEnd(index + 1);
          const node = end > index + 1 ? this.parse(this.main, index + 1, end) : NOTHING;
          const fn = this.innermost[index];
          const list = this.returns.get(fn);
          if (list) list.push(node);
          else this.returns.set(fn, [node]);
        } else if ((value === "eval" || value === "with") && this.isPunct(index + 1, "(")) {
          // Either can bind names the definition scan never sees.
          this.failClosed = true;
        } else if (value === "for" || value === "while" || value === "do") {
          this.loop(index, value);
        }
        if (!KEYWORDS.has(value)) {
          const list = this.occurrences.get(value);
          if (list) list.push(index);
          else this.occurrences.set(value, [index]);
        }
      }
      if (token.type === "ident" && value === "chdir" && this.callOpen(index) > 0) {
        this.cwdKnown = false;
      }
    }

    // Assignments after declarations, so each resolves to its binding.
    for (const head of this.loopHeads) {
      const name = this.text(head.open + 1);
      const close = this.matching[head.open];
      const node: Node =
        this.text(head.open + 2) === "of"
          ? { k: "elem", of: this.parse(this.main, head.open + 3, close) }
          : TOP_NODE;
      this.assign(name, head.open + 1, close, node);
    }
    for (let index = 1; index < this.tokens.length; index += 1) {
      this.spend();
      if (this.tokens[index].type !== "punct") continue;
      const operator = this.text(index);
      if (ASSIGNMENT_OPERATORS.has(operator)) this.assignment(index, operator);
      else if ((operator === "++" || operator === "--") && this.isIdent(index - 1)) {
        this.assign(this.text(index - 1), index - 1, index, TOP_NODE);
      } else if ((operator === "++" || operator === "--") && this.isIdent(index + 1)) {
        this.assign(this.text(index + 1), index, index + 1, TOP_NODE);
      }
    }
  }

  private loop(index: number, keyword: string): void {
    let bodyStart: number;
    if (keyword === "do") {
      bodyStart = index + 1;
    } else {
      const open = this.isPunct(index + 1, "(")
        ? index + 1
        : this.isPunct(index + 2, "(")
          ? index + 2
          : -1;
      if (open < 0 || this.matching[open] < 0) return;
      bodyStart = this.matching[open] + 1;
      if (
        keyword === "for" &&
        this.isIdent(open + 1) &&
        ["of", "in"].includes(this.text(open + 2))
      ) {
        this.loopHeads.push({ open });
      }
    }
    let end: number;
    if (this.isPunct(bodyStart, "{") && this.matching[bodyStart] > 0)
      end = this.matching[bodyStart] + 1;
    else end = this.expressionEnd(bodyStart) + 1;
    this.loops.push({ start: index, end });
  }

  // Innermost `{` block (or function body / module) enclosing a token.
  private blockScope(index: number): Range {
    for (let open = this.enclosing[index]; open >= 0; open = this.enclosing[open]) {
      if (this.text(open) === "{") return { start: open, end: this.matching[open] };
    }
    return { start: 0, end: this.tokens.length };
  }

  private functionScope(index: number): Range {
    const fn = this.innermost[index] ?? -1;
    if (fn < 0) return { start: 0, end: this.tokens.length };
    return { start: this.functions[fn].start, end: this.functions[fn].end };
  }

  private declare(name: string, scope: Range, owner: number, def: Def): Binding {
    const list = this.bindings.get(name) ?? [];
    let binding = list.find(
      (candidate) => candidate.scope.start === scope.start && candidate.scope.end === scope.end,
    );
    if (!binding) {
      binding = { id: this.bindingCount++, name, scope, owner, defs: [] };
      list.push(binding);
      this.bindings.set(name, list);
    }
    binding.defs.push(def);
    return binding;
  }

  private resolve(name: string, position: number): Binding | null {
    let best: Binding | null = null;
    for (const binding of this.bindings.get(name) ?? []) {
      this.spend();
      if (binding.scope.start > position || binding.scope.end < position) continue;
      if (!best || binding.scope.end - binding.scope.start < best.scope.end - best.scope.start) {
        best = binding;
      }
    }
    return best;
  }

  private dominates(statement: number): boolean {
    const open = this.enclosing[statement];
    if (open >= 0 && this.text(open) !== "{") return false;
    if (open >= 0 && this.isPunct(open - 1, ")") && this.matching[open - 1] >= 0) {
      const head = this.matching[open - 1];
      if (this.text(head - 1) === "switch") return false;
    }
    if (statement === 0) return true;
    const previous = this.text(statement - 1);
    if (previous === ";" || previous === "{" || previous === "}") return true;
    if (previous === ")") {
      const head = this.matching[statement - 1];
      if (head >= 0 && ["if", "for", "while", "with"].includes(this.text(head - 1))) return false;
      return this.newlineBefore(statement);
    }
    if (["else", "do", ":", "=>", "?", "&&", "||", "??", ","].includes(previous)) return false;
    return this.startsNewStatement(statement);
  }

  private declaration(index: number, kind: string): void {
    const scope = kind === "var" ? this.functionScope(index) : this.blockScope(index);
    const owner = this.innermost[index] ?? -1;
    const forHead =
      this.enclosing[index] >= 0 &&
      this.text(this.enclosing[index]) === "(" &&
      this.text(this.enclosing[index] - 1) === "for";
    const dominates = !forHead && this.dominates(index);
    let cursor = index + 1;
    while (cursor < this.tokens.length) {
      this.spend();
      const patternStart = cursor;
      let patternEnd: number;
      if (this.isIdent(cursor)) patternEnd = cursor + 1;
      else if (
        (this.isPunct(cursor, "{") || this.isPunct(cursor, "[")) &&
        this.matching[cursor] > 0
      ) {
        patternEnd = this.matching[cursor] + 1;
      } else return;
      let node: Node = NOTHING;
      let end = patternEnd;
      let loopVariable = false;
      if (this.isPunct(patternEnd, "=")) {
        end = this.expressionEnd(patternEnd + 1);
        node = this.parse(this.main, patternEnd + 1, end);
      } else if (forHead && ["of", "in"].includes(this.text(patternEnd))) {
        const close = this.matching[this.enclosing[index]];
        node =
          this.text(patternEnd) === "of"
            ? { k: "elem", of: this.parse(this.main, patternEnd + 1, close) }
            : TOP_NODE;
        end = close;
        loopVariable = true;
      }
      for (const binding of this.patternBindings(patternStart, patternEnd, node)) {
        this.declare(binding.name, scope, owner, {
          pos: end,
          statement: index,
          node: binding.node,
          dominates: dominates && !loopVariable,
          block: this.blockOf(index),
          fn: owner,
        });
      }
      if (!this.isPunct(end, ",") || forHead) return;
      cursor = end + 1;
    }
  }

  private blockOf(index: number): number {
    for (let open = this.enclosing[index]; open >= 0; open = this.enclosing[open]) {
      if (this.text(open) === "{") {
        const fn = this.innermost[index] ?? -1;
        if (fn >= 0 && this.functions[fn].body.start === open + 1) return -1;
        return open;
      }
    }
    return -1;
  }

  private importDeclaration(index: number): void {
    let from = -1;
    for (let cursor = index + 1; cursor < Math.min(this.tokens.length, index + 400); cursor += 1) {
      if (this.tokens[cursor].type === "string") {
        from = cursor;
        break;
      }
      if (this.isPunct(cursor, ";")) return;
    }
    if (from < 0) return;
    const specifier = this.tokens[from].value ?? "";
    const module = moduleValue(specifier);
    const define = (name: string, node: Node, at: number) =>
      this.declare(name, { start: 0, end: this.tokens.length }, -1, {
        pos: 0,
        statement: at,
        node,
        dominates: true,
        block: -1,
        fn: -1,
      });
    for (let cursor = index + 1; cursor < from; cursor += 1) {
      if (this.isPunct(cursor, "*") && this.text(cursor + 1) === "as" && this.isIdent(cursor + 2)) {
        define(this.text(cursor + 2), module, cursor);
        cursor += 2;
      } else if (this.isPunct(cursor, "{") && this.matching[cursor] > 0) {
        const close = this.matching[cursor];
        for (const range of splitRanges(this.main, cursor + 1, close)) {
          const imported = this.text(range.start);
          const local =
            range.end - range.start === 3 && this.text(range.start + 1) === "as"
              ? this.text(range.start + 2)
              : imported;
          if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
          define(local, { k: "member", obj: module, prop: imported }, range.start);
        }
        cursor = close;
      } else if (this.isIdent(cursor) && this.text(cursor) !== "type") {
        define(this.text(cursor), module, cursor);
      }
    }
  }

  private assignment(index: number, operator: string): void {
    const target = index - 1;
    if (this.memberTargetOnExpression(target)) this.failClosed = true;
    const end = this.expressionEnd(index + 1);
    const value = (name: string): Node => {
      const node = this.parse(this.main, index + 1, end);
      if (operator === "=") return node;
      const current: Node = { k: "id", name, pos: index };
      if (operator === "+=") return { k: "concat", l: current, r: node };
      if (operator === "||=" || operator === "??=" || operator === "&&=") {
        return { k: "union", options: [current, node] };
      }
      return TOP_NODE;
    };
    if (this.isIdent(target) && !this.memberAccessed(target)) {
      this.assign(this.text(target), target, end, value(this.text(target)));
      return;
    }
    if ((this.isPunct(target, "}") || this.isPunct(target, "]")) && this.matching[target] >= 0) {
      const open = this.matching[target];
      // A destructuring assignment is a statement or a parenthesized one; a
      // `}` / `]` ending a member target or an object literal is not.
      const before = this.text(open - 1);
      if (
        this.isPunct(target, "]") &&
        (this.isIdent(open - 1) || before === ")" || before === "]")
      ) {
        return;
      }
      if (!this.dominates(open) && before !== "(") return;
      const node = this.parse(this.main, index + 1, end);
      for (const binding of this.patternBindings(open, target + 1, node)) {
        this.assign(binding.name, open, end, binding.node);
      }
    }
  }

  // `get().x = v` / `(a || b).x = v` change an object no name tracks.
  private memberTargetOnExpression(target: number): boolean {
    let index = target;
    let member = false;
    for (;;) {
      if (this.tokens[index]?.type === "ident" && this.memberAccessed(index)) {
        index -= 2;
        member = true;
      } else if (this.isPunct(index, "]") && this.matching[index] > 0) {
        const open = this.matching[index];
        const before = this.text(open - 1);
        if (!(this.isIdent(open - 1) || before === ")" || before === "]")) return false;
        index = open - 1;
        member = true;
      } else break;
    }
    return member && this.isPunct(index, ")");
  }

  private assign(name: string, statement: number, pos: number, node: Node): void {
    let binding = this.resolve(name, statement);
    if (!binding) {
      binding = this.declare(name, { start: 0, end: this.tokens.length }, -1, {
        pos: 0,
        statement: 0,
        node: NOTHING,
        dominates: false,
        block: -1,
        fn: -1,
      });
    }
    binding.defs.push({
      pos,
      statement,
      node,
      dominates: this.dominates(statement),
      block: this.blockOf(statement),
      fn: this.innermost[statement] ?? -1,
    });
  }

  // Names bound by a pattern over [start, end), each with the node it reads.
  private patternBindings(
    start: number,
    end: number,
    value: Node,
  ): Array<{ name: string; node: Node }> {
    this.spend();
    if (end - start === 1 && this.isIdent(start)) return [{ name: this.text(start), node: value }];
    if (this.isIdent(start) && this.isPunct(start + 1, "=")) {
      const fallback = this.parse(this.main, start + 2, end);
      return [{ name: this.text(start), node: { k: "union", options: [value, fallback] } }];
    }
    if (this.isPunct(start, "...")) return this.patternBindings(start + 1, end, TOP_NODE);
    const close = this.matching[start];
    if ((this.isPunct(start, "{") || this.isPunct(start, "[")) && close > start && close < end) {
      const defaultNode =
        close + 1 < end && this.isPunct(close + 1, "=")
          ? this.parse(this.main, close + 2, end)
          : null;
      const base = defaultNode ? ({ k: "union", options: [value, defaultNode] } as Node) : value;
      const out: Array<{ name: string; node: Node }> = [];
      const entries = splitRanges(this.main, start + 1, close);
      entries.forEach((entry, position) => {
        if (this.isPunct(start, "[")) {
          out.push(
            ...this.patternBindings(entry.start, entry.end, {
              k: "member",
              obj: base,
              prop: { k: "str", v: String(position) },
            }),
          );
          return;
        }
        if (this.isPunct(entry.start, "...")) {
          out.push(...this.patternBindings(entry.start + 1, entry.end, TOP_NODE));
          return;
        }
        const keyToken = entry.start;
        const key =
          this.tokens[keyToken]?.type === "string"
            ? (this.tokens[keyToken].value ?? "")
            : this.text(keyToken);
        if (this.isPunct(keyToken + 1, ":")) {
          const member: Node = this.isPunct(keyToken, "[")
            ? TOP_NODE
            : { k: "member", obj: base, prop: key };
          const valueStart = this.isPunct(keyToken, "[")
            ? this.matching[keyToken] + 2
            : keyToken + 2;
          out.push(...this.patternBindings(valueStart, entry.end, member));
        } else {
          out.push(
            ...this.patternBindings(entry.start, entry.end, { k: "member", obj: base, prop: key }),
          );
        }
      });
      return out;
    }
    return [];
  }

  // ---- parsing -----------------------------------------------------------

  private parse(stream: Stream, start: number, end: number): Node {
    const key = stream === this.main ? `${start}:${end}` : null;
    if (key) {
      const cached = this.parsed.get(key);
      if (cached) return cached;
    }
    if (this.depth > MAX_DEPTH) throw new AnalysisAbandoned();
    this.depth += 1;
    let node: Node;
    try {
      const parser = new ExpressionParser(this, stream, start, end);
      node = parser.expression(true);
      if (parser.index !== end) node = TOP_NODE;
    } finally {
      this.depth -= 1;
    }
    if (key) this.parsed.set(key, node);
    return node;
  }

  functionStartingAt(stream: Stream, index: number): number | undefined {
    if (stream !== this.main) return undefined;
    const fn = this.functionAt.get(index);
    return fn !== undefined && !this.functions[fn].method ? fn : undefined;
  }

  methodNamed(stream: Stream, index: number): number | undefined {
    return stream === this.main ? this.methodAt.get(index) : undefined;
  }

  functionEnd(fn: number): number {
    return this.functions[fn].end;
  }

  parseRange(stream: Stream, start: number, end: number): Node {
    return this.parse(stream, start, end);
  }

  parseTemplate(index: number, stream: Stream): Node {
    const raw = stream.texts[index];
    const parts: Array<string | Node> = [];
    if (!templateWithinBudget(raw)) return TOP_NODE;
    const pieces = templatePieces(raw);
    if (!pieces) return TOP_NODE;
    for (const piece of pieces) {
      if (typeof piece === "string") parts.push(piece);
      else {
        const sub = subStream(piece.expression, stream.at(index));
        parts.push(this.parse(sub, 0, sub.tokens.length));
      }
    }
    return { k: "tpl", parts };
  }

  charge(): void {
    this.spend();
  }

  // ---- evaluation --------------------------------------------------------

  private evaluate(node: Node): Value {
    this.spend();
    const cached = this.memo.get(node);
    if (cached) return cached;
    if (this.inProgress.has(node)) return top();
    if (this.depth > MAX_DEPTH) throw new AnalysisAbandoned();
    this.inProgress.add(node);
    this.depth += 1;
    let value: Value;
    try {
      value = this.evaluateUncached(node);
    } finally {
      this.inProgress.delete(node);
      this.depth -= 1;
    }
    this.memo.set(node, value);
    return value;
  }

  private evaluateUncached(node: Node): Value {
    switch (node.k) {
      case "str":
        return items([node.v]);
      case "top":
        return top(node.imports);
      case "meta":
        return items([{ t: "mod", name: "importmeta" }]);
      case "mod":
        return items([{ t: "mod", name: node.name }]);
      case "fn":
        return items([{ t: "fn", fn: node.fn }]);
      case "arr":
        return items([{ t: "arr", items: node.items }]);
      case "obj":
        return items([{ t: "obj", props: node.props, open: node.open }]);
      case "spread":
        return top();
      case "union":
        return merge(node.options.map((option) => this.evaluate(option)));
      case "concat":
        return this.rootward([this.evaluate(node.l), this.evaluate(node.r)], (parts) =>
          parts.join(""),
        );
      case "tpl":
        return this.rootward(
          node.parts.map((part) =>
            typeof part === "string" ? items([part]) : this.evaluate(part),
          ),
          (parts) => parts.join(""),
        );
      case "id":
        return this.evaluateIdentifier(node.name, node.pos);
      case "member":
        return this.evaluateMember(this.evaluate(node.obj), node.prop);
      case "call":
        return this.evaluateCall(node);
      case "elem":
        return this.elementsOf(this.evaluate(node.of));
      case "param":
        return this.evaluateParam(node.fn, node.index);
    }
  }

  private evaluateIdentifier(name: string, position: number): Value {
    const binding = this.resolve(name, position);
    if (!binding) return this.freeIdentifier(name);
    const defs = this.reaching(binding, position);
    const key = `${binding.id}:${defs.map((def) => binding.defs.indexOf(def)).join(",")}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    if (this.inProgress.has(key)) return top();
    this.inProgress.add(key);
    let value: Value;
    try {
      value = merge(defs.map((def) => this.evaluate(def.node)));
      const container = value.items.some(
        (item) => typeof item !== "string" && (item.t === "obj" || item.t === "arr"),
      );
      const module = value.items.some((item) => typeof item !== "string" && item.t === "mod");
      if (!value.top && ((container && this.mutated(name)) || (module && this.patched(name)))) {
        value = top(value.imports);
      }
    } finally {
      this.inProgress.delete(key);
    }
    this.memo.set(key, value);
    return value;
  }

  private freeIdentifier(name: string): Value {
    switch (name) {
      case "__dirname":
        return items([this.fileDir]);
      case "__filename":
        return items([this.fileName]);
      case "require":
        return items([{ t: "mod", name: "require" }]);
      case "module":
        return items([{ t: "mod", name: "module" }]);
      case "process":
        return items([{ t: "mod", name: "process" }]);
      case "String":
        return items([{ t: "builtin", name: "String" }]);
      case "undefined":
        return items([]);
      default:
        return top();
    }
  }

  // The definitions that can reach a use: the last one that dominates it in
  // the same function (an unconditional statement whose block contains the
  // use), every later one before the use, later ones in a loop around the
  // use, and every one in another function. Without a dominating definition,
  // or for a use in a closure, every definition reaches.
  private reaching(binding: Binding, use: number): Def[] {
    const useFn = this.innermost[use] ?? -1;
    if (binding.owner !== useFn) return binding.defs;
    let dominating: Def | null = null;
    for (const def of binding.defs) {
      this.spend();
      if (def.fn !== useFn || def.pos > use || !def.dominates) continue;
      if (def.block >= 0 && !(def.block < use && this.matching[def.block] > use)) continue;
      if (!dominating || def.pos > dominating.pos) dominating = def;
    }
    if (!dominating) return binding.defs;
    const after = dominating.pos;
    return binding.defs.filter(
      (def) =>
        def === dominating ||
        def.fn !== useFn ||
        (def.pos > after && def.pos <= use) ||
        (def.pos > use &&
          this.loops.some(
            (loop) =>
              loop.start <= use &&
              use < loop.end &&
              loop.start <= def.statement &&
              def.statement < loop.end,
          )),
    );
  }

  // An object or array literal is only its literal while nothing can change
  // it: no member assignment, mutating method, alias, or hand-off to a call.
  private mutated(name: string): boolean {
    const cached = this.mutatedCache.get(name);
    if (cached !== undefined) return cached;
    let mutated = this.templateMutations.has(name);
    for (const index of this.occurrences.get(name) ?? []) {
      if (mutated) break;
      this.spend();
      if (this.memberAccessed(index)) continue;
      mutated = this.mutatingUse(index);
    }
    this.mutatedCache.set(name, mutated);
    return mutated;
  }

  // A module object stays the builtin while the file assigns none of its
  // members (`path.join = ...`), aliases it, or hands it to a call.
  private patched(name: string): boolean {
    const key = `module:${name}`;
    const cached = this.mutatedCache.get(key);
    if (cached !== undefined) return cached;
    let patched = this.templateArguments.has(name);
    for (const index of this.occurrences.get(name) ?? []) {
      if (patched) break;
      this.spend();
      if (this.memberAccessed(index)) continue;
      const previous = this.text(index - 1);
      if (["var", "let", "const", "import", "as"].includes(previous)) continue;
      let cursor = index + 1;
      let depth = 0;
      while (
        ((this.isPunct(cursor, ".") || this.isPunct(cursor, "?.")) &&
          this.tokens[cursor + 1]?.type === "ident") ||
        (this.isPunct(cursor, "[") && this.matching[cursor] > cursor)
      ) {
        cursor = this.isPunct(cursor, "[") ? this.matching[cursor] + 1 : cursor + 2;
        depth += 1;
      }
      const next = this.text(cursor);
      const assigns = ASSIGNMENT_OPERATORS.has(next) || next === "++" || next === "--";
      if (depth > 0) patched = assigns;
      else if (!assigns) patched = previous === "=" || previous === "(" || previous === ",";
    }
    this.mutatedCache.set(key, patched);
    return patched;
  }

  private mutatingUse(index: number): boolean {
    const previous = this.text(index - 1);
    if (["var", "let", "const", "function", "class"].includes(previous)) return false;
    if (previous === "delete") return true;
    let cursor = index + 1;
    let depth = 0;
    let lastMember = "";
    for (;;) {
      if (
        (this.isPunct(cursor, ".") || this.isPunct(cursor, "?.")) &&
        this.tokens[cursor + 1]?.type === "ident"
      ) {
        lastMember = this.text(cursor + 1);
        cursor += 2;
        depth += 1;
      } else if (this.isPunct(cursor, "[") && this.matching[cursor] > cursor) {
        lastMember = "";
        cursor = this.matching[cursor] + 1;
        depth += 1;
      } else break;
    }
    const next = this.text(cursor);
    if (depth > 0) {
      if (ASSIGNMENT_OPERATORS.has(next) || next === "++" || next === "--") return true;
      if (next === "(") return !(depth === 1 && NON_MUTATING_METHODS.has(lastMember));
      return false;
    }
    if (ASSIGNMENT_OPERATORS.has(next) || next === "++" || next === "--") return false;
    if (
      ["in", "instanceof", "typeof", "of", "!", "===", "!==", "==", "!=", "..."].includes(previous)
    ) {
      return false;
    }
    if (["===", "!==", "==", "!=", "in", "instanceof"].includes(next)) return false;
    if (previous === "=" && (this.isPunct(index - 2, "}") || this.isPunct(index - 2, "]")))
      return false;
    return true;
  }

  private evaluateMember(object: Value, prop: string | Node): Value {
    if (object.top) return object;
    const keys = typeof prop === "string" ? items([prop]) : this.evaluate(prop);
    const out: Value[] = [];
    for (const item of object.items) {
      this.spend();
      if (typeof item === "string") {
        out.push(top());
      } else if (item.t === "obj") {
        if (keys.top || keys.items.some((key) => typeof key !== "string")) {
          if (item.open) return top();
          out.push(...[...item.props.values()].map((value) => this.evaluate(value)));
        } else {
          for (const key of keys.items as string[]) {
            const value = item.props.get(key);
            out.push(value ? this.evaluate(value) : top());
          }
        }
      } else if (item.t === "arr") {
        if (!keys.top && keys.items.every((key) => typeof key === "string" && /^\d+$/.test(key))) {
          for (const key of keys.items as string[]) {
            const value = item.items[Number(key)];
            if (!value || value.k === "spread") return top();
            out.push(this.evaluate(value));
          }
        } else if (keys.items.length === 1 && keys.items[0] === "length") {
          out.push(top());
        } else {
          out.push(this.elementsOf(items([item])));
        }
      } else if (item.t === "mod") {
        if (keys.top || keys.items.some((key) => typeof key !== "string")) return top();
        for (const key of keys.items as string[]) out.push(moduleMember(item.name, key, this));
      } else {
        out.push(top());
      }
    }
    return primitives(merge(out));
  }

  ownDir(): string {
    return this.fileDir;
  }

  ownFile(): string {
    return this.fileName;
  }

  private elementsOf(value: Value): Value {
    if (value.top) return value;
    const out: Value[] = [];
    for (const item of value.items) {
      if (typeof item === "string" || item.t !== "arr") return top(value.imports);
      for (const element of item.items) {
        if (element.k === "spread") return top(value.imports);
        out.push(this.evaluate(element));
      }
    }
    return primitives(merge(out));
  }

  private evaluateCall(node: Extract<Node, { k: "call" }>): Value {
    const { callee, args } = node;
    if (callee.k === "id" && INTEROP_HELPERS.has(callee.name) && args[0])
      return this.evaluate(args[0]);
    if (args.some((arg) => arg.k === "spread")) return top();
    if (callee.k === "member" && typeof callee.prop === "string") {
      const receiver = this.evaluate(callee.obj);
      if (receiver.top) return receiver;
      const out: Value[] = [];
      for (const item of receiver.items) {
        this.spend();
        if (typeof item === "string") {
          out.push(this.stringMethod(item, callee.prop, args));
        } else if (item.t === "arr" && callee.prop === "join") {
          const separator = args[0] ? this.evaluate(args[0]) : items([","]);
          const elements = item.items.map((element) =>
            element.k === "spread" ? top() : this.evaluate(element),
          );
          out.push(combineStrings([separator, ...elements], ([sep, ...parts]) => parts.join(sep)));
        } else if (item.t === "mod") {
          out.push(this.callValue(moduleMember(item.name, callee.prop, this), args));
        } else if (item.t === "obj") {
          const member = item.props.get(callee.prop);
          out.push(member ? this.callValue(this.evaluate(member), args) : top());
        } else {
          out.push(top());
        }
      }
      return merge(out);
    }
    return this.callValue(this.evaluate(callee), args);
  }

  private callValue(callee: Value, args: Node[]): Value {
    if (callee.top) return callee;
    const out: Value[] = [];
    for (const item of callee.items) {
      this.spend();
      if (typeof item === "string") out.push(top());
      else if (item.t === "fn") out.push(this.returnsOf(item.fn));
      else if (item.t === "builtin") out.push(this.builtinCall(item.name, args));
      else if (item.t === "mod" && item.name === "require")
        out.push(this.builtinCall("require", args));
      else out.push(top());
    }
    return merge(out);
  }

  private returnsOf(fn: number): Value {
    const returns = this.returns.get(fn);
    if (!returns) return items([]);
    return merge(returns.map((node) => this.evaluate(node)));
  }

  private stringMethod(value: string, method: string, args: Node[]): Value {
    const argValues = args.map((arg) => this.evaluate(arg));
    switch (method) {
      case "replace":
      case "replaceAll": {
        if (argValues.length !== 2) return top();
        return combineStrings(argValues, ([pattern, replacement]) =>
          method === "replace"
            ? value.replace(pattern, () => replacement)
            : value.replaceAll(pattern, () => replacement),
        );
      }
      case "toLowerCase":
      case "toUpperCase":
      case "trim":
      case "trimStart":
      case "trimEnd":
      case "toString":
        return items([value[method]()]);
      case "concat":
        return combineStrings(argValues, (parts) => value + parts.join(""));
      default:
        return top();
    }
  }

  private builtinCall(name: string, args: Node[]): Value {
    const argValues = args.map((arg) => this.evaluate(arg));
    switch (name) {
      case "path.join":
        return this.rootward(argValues, (parts) => joinPath(parts));
      case "path.resolve": {
        if (!this.cwdKnown) {
          // Only an absolute part keeps a resolve independent of the cwd.
          return combineStrings(argValues, (parts) =>
            parts.some((part) => rootOf(part) !== "") ? resolvePath(parts, UNRESOLVED) : UNRESOLVED,
          );
        }
        return this.rootward(argValues, (parts) => resolvePath(parts, OWN));
      }
      case "path.dirname":
        return combineStrings(argValues.slice(0, 1), ([part]) => dirnamePath(part));
      case "path.basename": {
        const result = combineStrings(argValues.slice(0, 2), ([part, ext]) =>
          basenamePath(part, ext),
        );
        return result;
      }
      case "path.normalize":
        return combineStrings(argValues.slice(0, 1), ([part]) => normalizePath(part));
      case "os.tmpdir":
        return items([TMP]);
      case "os.homedir":
        return items([HOME]);
      case "fs.mkdtemp":
        return combineStrings(argValues.slice(0, 1), ([prefix]) => {
          const normalized = normalizePath(prefix);
          const root = rootOf(normalized);
          return root === TMP || root === HOME || root === "/" ? `${normalized}XXXXXX` : UNRESOLVED;
        });
      case "process.cwd":
        return this.cwdKnown ? items([OWN]) : top();
      case "require": {
        const specifiers = argValues[0];
        if (!specifiers || specifiers.top) return top();
        return merge(
          specifiers.items.map((specifier) =>
            typeof specifier === "string" ? this.evaluate(moduleValue(specifier)) : top(),
          ),
        );
      }
      case "require.resolve":
        return combineStrings(argValues.slice(0, 1), ([specifier]) =>
          resolveSpecifier(specifier, this.fileDir, this.origin),
        );
      case "url.fileURLToPath": {
        const url = argValues[0];
        if (
          url &&
          !url.top &&
          url.items.every(
            (item) => typeof item !== "string" && item.t === "mod" && item.name === "fileurl",
          )
        ) {
          return items([this.fileName]);
        }
        return top();
      }
      case "createRequire":
        return items([{ t: "mod", name: "require" }]);
      case "String":
        return argValues[0] ?? items([]);
      default:
        return top();
    }
  }

  private evaluateParam(fn: number, index: number): Value {
    const sources = this.paramSources(fn);
    if (!sources) return top();
    const values: Value[] = [];
    for (const source of sources) {
      if (source.kind === "args") {
        const arg = source.args[index];
        if (source.args.slice(0, index + 1).some((candidate) => candidate.k === "spread"))
          return top();
        if (arg) values.push(this.evaluate(arg));
      } else {
        if (index !== 0) return top();
        values.push(this.elementsOf(this.evaluate(source.of)));
      }
    }
    return merge(values);
  }

  // Where a function's arguments come from: its direct calls in this file, an
  // IIFE's arguments, or the array an iteration method walks. Null (unknown)
  // for methods, exports, and functions handed to anything else.
  private paramSources(fn: number): ParamSources | null {
    if (this.paramSourceCache.has(fn)) return this.paramSourceCache.get(fn) ?? null;
    const sources = this.computeParamSources(fn);
    this.paramSourceCache.set(fn, sources);
    return sources;
  }

  private computeParamSources(fn: number): ParamSources | null {
    const info = this.functions[fn];
    if (info.method || info.exported) return null;
    const sources: ParamSources = [];
    const open = this.enclosing[info.start];
    if (open >= 0 && this.text(open) === "(") {
      const close = this.matching[open];
      if (this.isPunct(close + 1, "(") && this.matching[close + 1] > 0 && info.end === close) {
        sources.push({ kind: "args", args: this.callArguments(close + 1) });
      } else if (open + 1 === info.start && this.isPunct(open - 2, ".")) {
        const method = this.text(open - 1);
        if (!ITERATION_METHODS.has(method)) return null;
        const receiverStart = calleeStart(open - 2, this.tokens, this.main.texts, this.matching);
        sources.push({ kind: "elements", of: this.parse(this.main, receiverStart, open - 2) });
        return sources;
      } else if (!info.name) {
        return null;
      }
    } else if (!info.name) {
      return null;
    }
    if (!info.name) return sources;
    if (this.templateNames.has(info.name)) return null;
    for (const index of this.occurrences.get(info.name) ?? []) {
      this.spend();
      if (index === info.nameToken || this.memberAccessed(index)) continue;
      if (this.text(index - 1) === "function" || this.text(index - 1) === "typeof") continue;
      if (this.isPunct(index + 1, "(") && this.matching[index + 1] > 0) {
        sources.push({ kind: "args", args: this.callArguments(index + 1) });
      } else if (this.isPunct(index + 1, ":") && !this.isPunct(index - 1, "?")) {
        continue;
      } else {
        return null;
      }
    }
    return sources.length ? sources : null;
  }

  private callArguments(open: number): Node[] {
    return splitRanges(this.main, open + 1, this.matching[open]).map((range) =>
      this.isPunct(range.start, "...")
        ? { k: "spread", arg: this.parse(this.main, range.start + 1, range.end) }
        : this.parse(this.main, range.start, range.end),
    );
  }

  // ---- sinks ---------------------------------------------------------------

  private callOpen(index: number): number {
    if (this.isPunct(index + 1, "(")) return index + 1;
    if (this.isPunct(index + 1, "?.") && this.isPunct(index + 2, "(")) return index + 2;
    // TypeScript's CommonJS output calls an import as `(0, fs_1.writeFileSync)(...)`.
    if (this.isPunct(index + 1, ")") && this.isPunct(index + 2, "(")) {
      const group = this.matching[index + 1];
      if (group >= 0 && this.text(group + 1) === "0" && this.isPunct(group + 2, ",")) {
        return index + 2;
      }
    }
    return -1;
  }

  private checkFsSink(
    index: number,
    name: string,
    fail: (index: number, value?: Value) => void,
  ): void {
    if (this.text(index - 1) === "function") return;
    const generic = GENERIC_SINK_NAMES.has(name);
    const open = this.callOpen(index);
    if (open < 0) {
      if ((!generic || this.fsReceiver(index)) && this.sinkUsedAsValue(index)) fail(index);
      return;
    }
    if (this.methodAt.has(index)) return;
    if (generic && !this.fsReceiver(index)) return;
    const close = this.matching[open];
    if (close < 0) {
      fail(index);
      return;
    }
    const args = splitRanges(this.main, open + 1, close);
    if (OPEN_SINKS.has(name)) {
      const flags = args[1];
      if (!flags) return;
      const value = this.evaluate(this.parse(this.main, flags.start, flags.end));
      if (
        !value.top &&
        value.items.every((flag) => typeof flag === "string" && !/[wa+]/.test(flag))
      ) {
        return;
      }
    }
    const position = SINK_DESTINATION_ARG.get(name) ?? 0;
    const spreadAt = args.findIndex((arg) => this.isPunct(arg.start, "..."));
    if (spreadAt >= 0 && spreadAt <= position) {
      fail(index);
      return;
    }
    const destination = args[position];
    if (!destination) return;
    const value = this.evaluate(this.parse(this.main, destination.start, destination.end));
    if (!this.provenDestination(value, OWN)) fail(index, value);
  }

  // `fs[method](...)` with a computed method could be any sink.
  private computedFsCall(index: number): boolean {
    if (!this.isPunct(index, "[") || !FS_RECEIVER.test(this.text(index - 1))) return false;
    const close = this.matching[index];
    if (close < 0 || !this.isPunct(close + 1, "(")) return false;
    return !(close === index + 2 && this.tokens[index + 1].type === "string");
  }

  // `fs['writeFileSync'](...)` names the sink in a string.
  private computedSinkMember(index: number): boolean {
    const name = this.tokens[index].value;
    if (!name || !SINK_DESTINATION_ARG.has(name)) return false;
    if (!this.isPunct(index - 1, "[") || !this.isPunct(index + 1, "]")) return false;
    const receiver = index - 2;
    const memberAccess =
      this.isIdent(receiver) || this.isPunct(receiver, ")") || this.isPunct(receiver, "]");
    if (!memberAccess) return false;
    return !GENERIC_SINK_NAMES.has(name) || FS_RECEIVER.test(this.text(receiver));
  }

  private fsReceiver(index: number): boolean {
    if (this.memberAccessed(index)) {
      const receiver = index - 2;
      if (this.tokens[receiver]?.type !== "ident") return false;
      if (FS_RECEIVER.test(this.text(receiver))) return true;
      const value = this.evaluate({ k: "id", name: this.text(receiver), pos: receiver });
      return (
        !value.top &&
        value.items.some(
          (item) => typeof item !== "string" && item.t === "mod" && item.name === "fs",
        )
      );
    }
    const value = this.evaluate({ k: "id", name: this.text(index), pos: index });
    return (
      !value.top &&
      value.items.some(
        (item) => typeof item !== "string" && item.t === "builtin" && item.name === "fs.sink",
      )
    );
  }

  // Import specifiers and destructuring keep the sink's own name, so its later
  // calls are still recognised; renaming it (`as w`, `{ writeFile: w }`) or
  // using it any other way is an alias whose writes are not followed.
  private sinkUsedAsValue(index: number): boolean {
    const next = this.text(index + 1);
    const open = this.enclosing[index];
    if (open >= 0 && this.text(open) === "{" && this.matching[open] > index) {
      const after = this.text(this.matching[open] + 1);
      const binding = after === "=" || after === "from" || this.text(open - 1) === "import";
      if (binding) return next === "as" || next === ":";
      if (next === ":") return false;
    }
    return true;
  }

  private checkExec(
    index: number,
    name: string,
    fail: (index: number, value?: Value) => void,
  ): void {
    const open = this.callOpen(index);
    if (open < 0 || this.matching[open] < 0) return;
    const args = splitRanges(this.main, open + 1, this.matching[open]);
    if (!args.length) return;
    const literalText = (range: Range) => {
      let text = "";
      for (let at = range.start; at < range.end; at += 1) {
        if (this.tokens[at].type === "string") text += `${this.tokens[at].value ?? ""} `;
        else if (this.tokens[at].type === "template") text += `${this.text(at).slice(1, -1)} `;
      }
      return text;
    };
    const options = args.find(
      (arg) => this.isPunct(arg.start, "{") && this.matching[arg.start] === arg.end - 1,
    );
    const cwd = options ? this.optionCwd(options) : OWN;
    let commands: Value;
    if (EXEC_SHELL.has(name)) {
      if (!SHELL_WRITE_TEXT.test(literalText(args[0]))) return;
      commands = this.evaluate(this.parse(this.main, args[0].start, args[0].end));
    } else {
      const program = this.evaluate(this.parse(this.main, args[0].start, args[0].end));
      const argv = args[1] && this.isPunct(args[1].start, "[") ? args[1] : null;
      const programs = program.top
        ? []
        : program.items.filter((item): item is string => typeof item === "string");
      const base = (value: string) => value.split(/[\\/]/).at(-1) ?? "";
      if (programs.some((value) => SHELLS.has(base(value))) && argv) {
        if (!SHELL_WRITE_TEXT.test(literalText(argv))) return;
        const list = this.evaluate(this.parse(this.main, argv.start, argv.end));
        commands = this.elementsOf(list);
      } else if (programs.some((value) => SHELL_WRITE_PROGRAMS.has(base(value)))) {
        if (!argv) {
          fail(index);
          return;
        }
        const list = this.evaluate(this.parse(this.main, argv.start, argv.end));
        const elements = list.top ? null : list.items;
        const last =
          elements?.length === 1 && typeof elements[0] !== "string" && elements[0].t === "arr"
            ? elements[0].items.at(-1)
            : undefined;
        const destination = last && last.k !== "spread" ? this.evaluate(last) : top();
        if (cwd === null || !this.provenDestination(destination, cwd)) fail(index, destination);
        return;
      } else if (program.top && SHELL_WRITE_TEXT.test(literalText(args[0]))) {
        fail(index);
        return;
      } else {
        return;
      }
    }
    if (commands.top || cwd === null) {
      fail(index, commands);
      return;
    }
    for (const command of commands.items) {
      if (typeof command !== "string") continue;
      const destinations = shellWriteDestinations(command);
      if (
        destinations === null ||
        destinations.some((destination) => !this.provenDestination(items([destination]), cwd))
      ) {
        const anchored = (destinations ?? []).map((destination) =>
          rootOf(destination) === "" ? `${cwd}/${destination}` : destination,
        );
        fail(index, items(anchored));
        return;
      }
    }
  }

  private optionCwd(options: Range): string | null {
    const node = this.parse(this.main, options.start, options.end);
    if (node.k !== "obj") return null;
    const cwd = node.props.get("cwd");
    if (!cwd) return node.open ? null : OWN;
    const value = this.evaluate(cwd);
    if (value.top || value.items.length !== 1 || typeof value.items[0] !== "string") return null;
    const normalized = normalizePath(value.items[0]);
    return this.provenDestination(items([normalized]), OWN) ? normalized : null;
  }

  // Combine path parts; when a later part is unknown but the known leading
  // parts already land in the install root, the unknown result is still a
  // definite install-root destination.
  private rootward(values: Value[], combine: (parts: string[]) => string): Value {
    const result = combineStrings(values, combine);
    if (!result.top || result.rootward) return result;
    const known = values.findIndex(
      (value) => value.top || value.items.some((item) => typeof item !== "string"),
    );
    if (known <= 0) return result;
    const prefix = combineStrings(values.slice(0, known), combine);
    const inRoot =
      !prefix.top &&
      prefix.items.length > 0 &&
      prefix.items.every((item) => typeof item === "string" && this.installRootPath(item));
    return inRoot ? { ...result, rootward: true } : result;
  }

  private installRootPath(item: string): boolean {
    let path = normalizePath(item);
    if (rootOf(path) === "" && this.cwdKnown) path = normalizePath(`${OWN}/${path}`);
    return (
      rootOf(path) === ESCAPED ||
      path.split("/").some((segment) => segment.toLowerCase() === "node_modules")
    );
  }

  private provenDestination(value: Value, cwd: string): boolean {
    if (value.top || !value.items.length) return !value.top;
    return value.items.every((item) => {
      if (typeof item !== "string") return false;
      let path = normalizePath(item);
      if (rootOf(path) === "") {
        if (!this.cwdKnown && cwd === OWN) return false;
        path = normalizePath(`${cwd}/${path}`);
      }
      const root = rootOf(path);
      if (root === "" || root === ESCAPED || root === UNRESOLVED || root === null) return false;
      return !path.split("/").some((segment) => segment.toLowerCase() === "node_modules");
    });
  }
}

type ParamSources = Array<{ kind: "args"; args: Node[] } | { kind: "elements"; of: Node }>;

class ExpressionParser {
  index: number;

  constructor(
    private readonly analysis: InstallWriteAnalysis,
    private readonly stream: Stream,
    start: number,
    private readonly end: number,
  ) {
    this.index = start;
  }

  private text(offset = 0): string {
    const at = this.index + offset;
    return at < this.end ? (this.stream.texts[at] ?? "") : "";
  }

  private type(offset = 0): string | undefined {
    const at = this.index + offset;
    return at < this.end ? this.stream.tokens[at]?.type : undefined;
  }

  private punct(value: string, offset = 0): boolean {
    return this.type(offset) === "punct" && this.text(offset) === value;
  }

  private abandon(): Node {
    this.index = this.end;
    return TOP_NODE;
  }

  expression(allowComma: boolean): Node {
    let node = this.assignment();
    while (allowComma && this.punct(",")) {
      this.index += 1;
      node = this.assignment();
    }
    return node;
  }

  private assignment(): Node {
    this.analysis.charge();
    const fn = this.functionHere();
    if (fn) return fn;
    const left = this.conditional();
    if (this.type() === "punct" && ASSIGNMENT_OPERATORS.has(this.text())) {
      const operator = this.text();
      this.index += 1;
      const right = this.assignment();
      if (operator === "=") return right;
      if (operator === "+=") return { k: "concat", l: left, r: right };
      if (operator === "||=" || operator === "??=" || operator === "&&=") {
        return { k: "union", options: [left, right] };
      }
      return TOP_NODE;
    }
    return left;
  }

  private functionShape(offset: number): boolean {
    if (this.text(offset) === "function") return true;
    if (this.type(offset) === "ident" && this.punct("=>", offset + 1)) return true;
    const close = this.stream.matching[this.index + offset];
    return this.punct("(", offset) && close > 0 && this.stream.texts[close + 1] === "=>";
  }

  private functionHere(): Node | null {
    const shape = this.functionShape(0) || (this.text() === "async" && this.functionShape(1));
    if (!shape) return null;
    const fn = this.analysis.functionStartingAt(this.stream, this.index);
    if (fn === undefined) return this.abandon();
    const end = this.analysis.functionEnd(fn);
    if (end > this.end) return this.abandon();
    this.index = end;
    return { k: "fn", fn };
  }

  private conditional(): Node {
    const test = this.binary(0);
    if (!this.punct("?")) return test;
    this.index += 1;
    const consequent = this.assignment();
    if (!this.punct(":")) return this.abandon();
    this.index += 1;
    const alternate = this.assignment();
    return { k: "union", options: [consequent, alternate] };
  }

  private binary(minimum: number): Node {
    let left = this.unary();
    for (;;) {
      const operator = this.text();
      const type = this.type();
      if (type !== "punct" && operator !== "in" && operator !== "instanceof") break;
      const precedence = BINARY_PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minimum) break;
      this.index += 1;
      const right = this.binary(precedence + 1);
      if (operator === "+") left = { k: "concat", l: left, r: right };
      else if (operator === "||" || operator === "??" || operator === "&&") {
        left = { k: "union", options: [left, right] };
      } else left = TOP_NODE;
    }
    return left;
  }

  private unary(): Node {
    const value = this.text();
    if (this.type() === "punct" && ["!", "~", "-", "+", "++", "--"].includes(value)) {
      this.index += 1;
      this.unary();
      return TOP_NODE;
    }
    if (this.type() === "ident" && ["typeof", "void", "delete"].includes(value)) {
      this.index += 1;
      this.unary();
      return TOP_NODE;
    }
    if (this.type() === "ident" && value === "await") {
      this.index += 1;
      return this.unary();
    }
    if (this.type() === "ident" && value === "new") {
      this.index += 1;
      this.postfix();
      return TOP_NODE;
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      this.analysis.charge();
      if ((this.punct(".") || this.punct("?.")) && this.type(1) === "ident") {
        node = { k: "member", obj: node, prop: this.text(1) };
        this.index += 2;
      } else if (this.punct("?.") && (this.punct("(", 1) || this.punct("[", 1))) {
        this.index += 1;
      } else if (this.punct("[")) {
        const close = this.stream.matching[this.index];
        if (close < 0 || close >= this.end) return this.abandon();
        const prop = this.analysis.parseRange(this.stream, this.index + 1, close);
        node = { k: "member", obj: node, prop };
        this.index = close + 1;
      } else if (this.punct("(")) {
        const close = this.stream.matching[this.index];
        if (close < 0 || close >= this.end) return this.abandon();
        const args = splitRanges(this.stream, this.index + 1, close).map((range) =>
          this.stream.tokens[range.start]?.type === "punct" &&
          this.stream.texts[range.start] === "..."
            ? ({
                k: "spread",
                arg: this.analysis.parseRange(this.stream, range.start + 1, range.end),
              } as Node)
            : this.analysis.parseRange(this.stream, range.start, range.end),
        );
        node = { k: "call", callee: node, args };
        this.index = close + 1;
      } else if (this.type() === "template") {
        this.index += 1;
        node = TOP_NODE;
      } else if (this.punct("++") || this.punct("--")) {
        this.index += 1;
        node = TOP_NODE;
      } else {
        return node;
      }
    }
  }

  private primary(): Node {
    if (this.index >= this.end) return TOP_NODE;
    const fn = this.functionHere();
    if (fn) return fn;
    const type = this.type();
    const value = this.text();
    const at = this.index;
    if (type === "string") {
      this.index += 1;
      return { k: "str", v: this.stream.tokens[at].value ?? value.slice(1, -1) };
    }
    if (type === "template") {
      this.index += 1;
      return this.analysis.parseTemplate(at, this.stream);
    }
    if (type === "number" || type === "regex") {
      this.index += 1;
      return TOP_NODE;
    }
    if (type === "ident") {
      if (value === "class") return this.abandon();
      if (value === "import" && this.punct(".", 1) && this.text(2) === "meta") {
        this.index += 3;
        return { k: "meta" };
      }
      if (value === "import" && this.punct("(", 1)) {
        const close = this.stream.matching[at + 1];
        if (close < 0 || close >= this.end) return this.abandon();
        const specifier = this.stream.tokens[at + 2];
        this.index = close + 1;
        const relative =
          specifier?.type === "string" ? relativeImports([specifier.value ?? ""]) : [];
        return { k: "top", imports: relative };
      }
      this.index += 1;
      if (["this", "super"].includes(value)) return TOP_NODE;
      if (["true", "false", "null", "undefined"].includes(value)) return NOTHING;
      return { k: "id", name: value, pos: this.stream.at(at) };
    }
    if (type === "punct" && value === "(") {
      const close = this.stream.matching[at];
      if (close < 0 || close >= this.end) return this.abandon();
      this.index = close + 1;
      return this.analysis.parseRange(this.stream, at + 1, close);
    }
    if (type === "punct" && value === "[") {
      const close = this.stream.matching[at];
      if (close < 0 || close >= this.end) return this.abandon();
      this.index = close + 1;
      return {
        k: "arr",
        items: splitRanges(this.stream, at + 1, close).map((range) =>
          this.stream.texts[range.start] === "..."
            ? ({ k: "spread", arg: TOP_NODE } as Node)
            : this.analysis.parseRange(this.stream, range.start, range.end),
        ),
      };
    }
    if (type === "punct" && value === "{") {
      const close = this.stream.matching[at];
      if (close < 0 || close >= this.end) return this.abandon();
      this.index = close + 1;
      return this.objectLiteral(at, close);
    }
    return this.abandon();
  }

  private objectLiteral(open: number, close: number): Node {
    const props = new Map<string, Node>();
    let isOpen = false;
    for (const range of splitRanges(this.stream, open + 1, close)) {
      const first = this.stream.tokens[range.start];
      const key =
        first?.type === "string" ? (first.value ?? "") : (this.stream.texts[range.start] ?? "");
      const second = this.stream.texts[range.start + 1];
      if (range.end - range.start === 1 && first?.type === "ident") {
        props.set(key, { k: "id", name: key, pos: this.stream.at(range.start) });
      } else if (
        (first?.type === "ident" || first?.type === "string" || first?.type === "number") &&
        second === ":"
      ) {
        props.set(key, this.analysis.parseRange(this.stream, range.start + 2, range.end));
      } else {
        const method = this.analysis.methodNamed(this.stream, range.start);
        if (method !== undefined && first?.type === "ident")
          props.set(key, { k: "fn", fn: method });
        else isOpen = true;
      }
    }
    return { k: "obj", props, open: isOpen };
  }
}

// ---- values ----------------------------------------------------------------

// Only containers bound directly to a name are checked for mutation, so one
// read out of another container (`config.paths`) is not trusted.
function primitives(value: Value): Value {
  if (value.top) return value;
  return value.items.some(
    (item) => typeof item !== "string" && (item.t === "obj" || item.t === "arr"),
  )
    ? top(value.imports, value.rootward)
    : value;
}

function top(imports: string[] = [], rootward = false): Value {
  return { top: true, items: [], imports, ...(rootward ? { rootward } : {}) };
}

function items(list: Item[]): Value {
  return { top: false, items: list, imports: [] };
}

function merge(values: Value[]): Value {
  const imports = [...new Set(values.flatMap((value) => value.imports))].slice(0, MAX_IMPORTS);
  const rootward = values.some((value) => value.rootward);
  if (values.some((value) => value.top)) return top(imports, rootward);
  const seen = new Set<Item>();
  const strings = new Set<string>();
  const out: Item[] = [];
  for (const value of values) {
    for (const item of value.items) {
      if (typeof item === "string") {
        if (strings.has(item)) continue;
        strings.add(item);
      } else if (seen.has(item)) continue;
      else seen.add(item);
      out.push(item);
      if (out.length > MAX_VALUES) return top(imports, rootward);
    }
  }
  return { top: false, items: out, imports, ...(rootward ? { rootward } : {}) };
}

// Every combination of string parts, or TOP if any part is not a string.
function combineStrings(values: Value[], combine: (parts: string[]) => string): Value {
  const imports = [...new Set(values.flatMap((value) => value.imports))].slice(0, MAX_IMPORTS);
  const rootward = values.some((value) => value.rootward);
  let combos: string[][] = [[]];
  for (const value of values) {
    if (value.top || value.items.some((item) => typeof item !== "string")) {
      return top(imports, rootward);
    }
    const next: string[][] = [];
    for (const combo of combos) {
      for (const item of value.items as string[]) {
        next.push([...combo, item]);
        if (next.length > MAX_VALUES) return top(imports, rootward);
      }
    }
    combos = next;
  }
  const result = [...new Set(combos.map(combine))];
  return { top: false, items: result, imports, ...(rootward ? { rootward } : {}) };
}

function moduleValue(specifier: string): Node {
  const name = BUILTIN_MODULES.get(specifier.replace(/^node:/, ""));
  return name ? { k: "mod", name } : { k: "top", imports: relativeImports([specifier]) };
}

function relativeImports(specifiers: string[]): string[] {
  return specifiers.filter(
    (specifier) => specifier.startsWith("./") || specifier.startsWith("../"),
  );
}

function moduleMember(module: string, key: string, analysis: InstallWriteAnalysis): Value {
  if (key === "default") return items([{ t: "mod", name: module }]);
  if (module === "importmeta") {
    if (key === "dirname") return items([analysis.ownDir()]);
    if (key === "filename") return items([analysis.ownFile()]);
    if (key === "url") return items([{ t: "mod", name: "fileurl" }]);
    return top();
  }
  switch (module) {
    case "path":
      if (["join", "resolve", "dirname", "basename", "normalize"].includes(key)) {
        return items([{ t: "builtin", name: `path.${key}` }]);
      }
      if (key === "sep") return items(["/"]);
      if (key === "posix") return items([{ t: "mod", name: "path" }]);
      return top();
    case "os":
      if (key === "tmpdir" || key === "homedir")
        return items([{ t: "builtin", name: `os.${key}` }]);
      return top();
    case "fs":
      if (key === "mkdtemp" || key === "mkdtempSync")
        return items([{ t: "builtin", name: "fs.mkdtemp" }]);
      if (key === "promises") return items([{ t: "mod", name: "fs" }]);
      if (SINK_DESTINATION_ARG.has(key)) return items([{ t: "builtin", name: "fs.sink" }]);
      return top();
    case "url":
      if (key === "fileURLToPath") return items([{ t: "builtin", name: "url.fileURLToPath" }]);
      return top();
    case "nodemodule":
      if (key === "createRequire") return items([{ t: "builtin", name: "createRequire" }]);
      return top();
    case "require":
      if (key === "resolve") return items([{ t: "builtin", name: "require.resolve" }]);
      return top();
    case "process":
      if (key === "cwd") return items([{ t: "builtin", name: "process.cwd" }]);
      return top();
    default:
      return top();
  }
}

// ---- paths -----------------------------------------------------------------

function rootOf(path: string): string | null {
  for (const root of SYMBOLIC_ROOTS) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  if (path.includes("\u0000")) return null;
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) return "/";
  return "";
}

// POSIX normalization over both separators, so a Windows install cannot slip
// a `..\\` past it. Climbing above the package directory lands in ESCAPED,
// above the temp or home directory in UNRESOLVED.
function normalizePath(path: string): string {
  const root = rootOf(path);
  if (root === null) return UNRESOLVED;
  if (root === ESCAPED || root === UNRESOLVED) return root;
  const rest = root === "/" ? path.replace(/^(?:[A-Za-z]:)?[\\/]+/, "") : path.slice(root.length);
  const segments: string[] = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") segments.pop();
      else if (root === "") segments.push("..");
      else if (root === OWN) return ESCAPED;
      else if (root !== "/") return UNRESOLVED;
    } else {
      segments.push(segment);
    }
  }
  if (root === "") return segments.length ? segments.join("/") : ".";
  if (root === "/") return `/${segments.join("/")}`;
  return segments.length ? `${root}/${segments.join("/")}` : root;
}

function joinPath(parts: string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  if (parts.slice(1).some((part) => part.includes("\u0000"))) return UNRESOLVED;
  return joined ? normalizePath(joined) : ".";
}

function resolvePath(parts: string[], cwd: string): string {
  let start = -1;
  parts.forEach((part, index) => {
    if (rootOf(part) !== "") start = index;
  });
  const base = start >= 0 ? parts.slice(start) : [cwd, ...parts];
  return normalizePath(base.filter((part) => part !== "").join("/"));
}

function dirnamePath(path: string): string {
  const normalized = normalizePath(path);
  const root = rootOf(normalized);
  if (root === ESCAPED || root === UNRESOLVED || root === null) return normalized;
  if (normalized === root) return root === "/" ? "/" : root === OWN ? ESCAPED : UNRESOLVED;
  const cut = normalized.lastIndexOf("/");
  if (cut < 0) return ".";
  if (root === "/" && cut === 0) return "/";
  return normalized.slice(0, cut);
}

function basenamePath(path: string, extension?: string): string {
  const normalized = normalizePath(path);
  const root = rootOf(normalized);
  if (root === null || normalized === root) return UNRESOLVED;
  let base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (extension && base.endsWith(extension) && base !== extension) {
    base = base.slice(0, -extension.length);
  }
  return base;
}

function resolveSpecifier(specifier: string, fromDir: string, origin: InstallWriteOrigin): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return normalizePath(`${fromDir}/${specifier}`);
  }
  if (rootOf(specifier) === "/") return normalizePath(specifier);
  const name = origin.packageName;
  if (name && specifier === name) {
    return normalizePath(`${OWN}/${normalizeRelative(origin.packageMain || "index.js")}`);
  }
  if (name && specifier.startsWith(`${name}/`)) {
    return normalizePath(`${OWN}/${specifier.slice(name.length + 1)}`);
  }
  return ESCAPED;
}

function normalizeRelative(path: string): string {
  const normalized = normalizePath(path.replace(/^\/+/, ""));
  return normalized === "." || rootOf(normalized) !== "" || normalized.startsWith("..")
    ? "index.js"
    : normalized;
}

// Destinations a shell command line writes: the last operand of cp / mv / ln /
// install / rsync, every tee operand, dd's `of=`, and redirection targets.
// Null when one cannot be read as a plain path.
function shellWriteDestinations(command: string): string[] | null {
  const destinations: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const redirect = /^\d*>>?(.*)$/.exec(word);
      if (redirect && !word.startsWith("2>&") && !/^\d*>&/.test(word)) {
        const target = redirect[1] || words[index + 1];
        if (!target) return null;
        if (target !== "/dev/null") destinations.push(target);
        if (!redirect[1]) index += 1;
      }
    }
    const plain = words.filter((word) => !/^\d*>/.test(word));
    while (plain[0] === "sudo" || /^[A-Za-z_]\w*=/.test(plain[0] ?? "")) plain.shift();
    const program = (plain[0] ?? "").split("/").at(-1) ?? "";
    const operands = plain.slice(1).filter((word) => !word.startsWith("-"));
    if (["cp", "mv", "ln", "install", "rsync"].includes(program)) {
      const last = operands.at(-1);
      if (!last) return null;
      destinations.push(last);
    } else if (program === "tee") {
      destinations.push(...operands);
    } else if (program === "dd") {
      for (const operand of operands)
        if (operand.startsWith("of=")) destinations.push(operand.slice(3));
    }
  }
  return destinations.some((destination) => /[$`~*'"{}]/.test(destination)) ? null : destinations;
}

// ---- tokens ----------------------------------------------------------------

function subStream(source: string, position: number): Stream {
  const tokens = tokenizeJs(source).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const texts = tokens.map((token) => jsTokenText(source, token));
  return { tokens, texts, matching: matchBrackets(tokens, texts), at: () => position };
}

function templateWithinBudget(raw: string): boolean {
  return (
    raw.length <= MAX_TEMPLATE_CHARS && raw.split("${").length - 1 <= MAX_TEMPLATE_INTERPOLATIONS
  );
}

// The `${...}` expression sources of a template token's raw text.
function templateExpressions(raw: string): string[] {
  return (templatePieces(raw) ?? []).flatMap((piece) =>
    typeof piece === "string" ? [] : [piece.expression],
  );
}

function templatePieces(raw: string): Array<string | { expression: string }> | null {
  const pieces: Array<string | { expression: string }> = [];
  let literal = "";
  const body = raw.slice(1, raw.endsWith("`") ? -1 : undefined);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") {
      const decoded = decodeEscape(body, index);
      if (!decoded) return null;
      literal += decoded.value;
      index = decoded.end - 1;
      continue;
    }
    if (char === "$" && body[index + 1] === "{") {
      const end = interpolationEnd(body, index + 2);
      if (end < 0) return null;
      pieces.push(literal);
      literal = "";
      pieces.push({ expression: body.slice(index + 2, end) });
      index = end;
      continue;
    }
    literal += char;
  }
  pieces.push(literal);
  return pieces;
}

function interpolationEnd(body: string, start: number): number {
  const tokens = tokenizeJs(body.slice(start));
  let depth = 0;
  for (const token of tokens) {
    if (token.type !== "punct") continue;
    const value = body.slice(start + token.start, start + token.end);
    if (value === "{") depth += 1;
    else if (value === "}") {
      if (depth === 0) return start + token.start;
      depth -= 1;
    }
  }
  return -1;
}

function decodeEscape(body: string, index: number): { value: string; end: number } | null {
  const next = body[index + 1];
  if (next === undefined) return null;
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  if (next in simple) return { value: simple[next], end: index + 2 };
  if (next === "x") {
    const hex = body.slice(index + 2, index + 4);
    return /^[\da-f]{2}$/i.test(hex)
      ? { value: String.fromCharCode(parseInt(hex, 16)), end: index + 4 }
      : null;
  }
  if (next === "u") {
    const braced = /^\{([\da-f]{1,6})\}/i.exec(body.slice(index + 2));
    if (braced) {
      const code = parseInt(braced[1], 16);
      return code <= 0x10ffff
        ? { value: String.fromCodePoint(code), end: index + 2 + braced[0].length }
        : null;
    }
    const hex = body.slice(index + 2, index + 6);
    return /^[\da-f]{4}$/i.test(hex)
      ? { value: String.fromCharCode(parseInt(hex, 16)), end: index + 6 }
      : null;
  }
  if (next === "\r" || next === "\n") return { value: "", end: index + 2 };
  return { value: next, end: index + 2 };
}

function splitRanges(stream: Stream, start: number, end: number): Range[] {
  const ranges: Range[] = [];
  let from = start;
  for (let index = start; index <= end; index += 1) {
    if (index < end && (stream.texts[index] ?? "") in OPENERS && stream.matching[index] > index) {
      index = stream.matching[index];
      continue;
    }
    if (index === end || (stream.tokens[index]?.type === "punct" && stream.texts[index] === ",")) {
      if (index > from) ranges.push({ start: from, end: index });
      from = index + 1;
    }
  }
  return ranges;
}

function matchBrackets(tokens: JsToken[], texts: string[]): Int32Array {
  const matching = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "punct") continue;
    const value = texts[index];
    if (value in OPENERS) {
      stack.push(index);
    } else if (CLOSERS.has(value)) {
      // Recover from a stray closer by unwinding to its opener; unmatched
      // openers keep -1, which every caller treats as "cannot follow".
      let at = stack.length - 1;
      while (at >= 0 && OPENERS[texts[stack[at]]] !== value) at -= 1;
      if (at < 0) continue;
      const open = stack[at];
      stack.length = at;
      matching[open] = index;
      matching[index] = open;
    }
  }
  return matching;
}

function innermostFunctions(tokenCount: number, functions: FunctionInfo[]): Int32Array {
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
      stack.push(fn);
    }
    innermost[index] = stack.length ? stack[stack.length - 1] : -1;
  }
  return innermost;
}

// Innermost unclosed bracket before each token.
function enclosingOpeners(tokens: JsToken[], texts: string[], matching: Int32Array): Int32Array {
  const enclosing = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    while (stack.length && matching[stack[stack.length - 1]] < index) stack.pop();
    enclosing[index] = stack.length ? stack[stack.length - 1] : -1;
    if (tokens[index].type === "punct" && texts[index] in OPENERS && matching[index] > index) {
      stack.push(index);
    }
  }
  return enclosing;
}

// Start of the expression ending just before `end`: `a.b(x).forEach` walks
// back to `a`, `[nm].forEach` to `[`.
function calleeStart(
  end: number,
  tokens: JsToken[],
  texts: string[],
  matching: Int32Array,
): number {
  let index = end - 1;
  while (index >= 0) {
    const value = texts[index];
    if (tokens[index].type === "punct" && (value === ")" || value === "]")) {
      if (matching[index] < 0) return index + 1;
      index = matching[index];
      const before = tokens[index - 1];
      if (before && (before.type === "ident" || [")", "]"].includes(texts[index - 1]))) {
        index -= 1;
        continue;
      }
      return index;
    }
    if (tokens[index].type === "punct") return index + 1;
    if (texts[index - 1] === "." || texts[index - 1] === "?.") {
      index -= 2;
      continue;
    }
    return index;
  }
  return 0;
}
