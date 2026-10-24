import { jsTokenText, tokenizeJsWithinBudget, type JsToken } from "../../platform/js-lexer";
import { normalizeReachabilityPath } from "./reachability";

// Positive evidence that install-time code mutates something *outside its own
// package*, which during an install is the directory the package manager
// unpacks the consumer's other dependencies into. `propagation.package-mutation`
// already fires when an install-time source names `node_modules` beside a
// write; this adds the writes that climb there without naming it
// (`path.dirname(__dirname)`, `cd ..`, a symlink whose relative target leaves
// the package).
//
// Positions are directory depths relative to the package root (0). A path
// escapes when the *lowest* position it passes through is negative: `../react`
// from the root ends back at depth 0, but in a sibling package, so the final
// position alone cannot answer the question.
//
// Only the destination of a mutating call counts: an fs write, copy, rename or
// link destination, a link target as the link model resolves it, or a shell
// write, redirect or link operand. Reading the consumer's `package.json`
// through `path.resolve(__dirname, '../..')` is ordinary installer behaviour.
//
// This only ever adds findings. It must not be used to prove a write stays
// inside the package: an earlier attempt to suppress on that basis was
// reverted because every review round found another write or link channel
// (pinned in test/review-propagation-install-root.test.ts).

export interface InstallRootWrite {
  line: number;
}

// Marks text the analysis cannot see (an interpolation, `$VAR`, a computed
// operand). A path segment containing it stops the walk.
const OPAQUE = "\u0000";
// Brackets a location embedded in shell text (`cp x ${target}`), so a word
// that starts with one resolves from that location rather than the cwd.
const ANCHOR = "\u0001";
// Longer text is kept as a prefix plus OPAQUE: paths and commands are short,
// and doubling bindings (`a1 = a0 + a0`) would otherwise grow exponentially.
const MAX_TEXT = 4_096;
// Total work for one source: a floor plus a share per token, so ordinary
// padding cannot exhaust it before the code that matters. Every loop over
// tokens or text charges it, and exhausting it ends the analysis with what was
// found so far.
const MIN_WORK = 200_000;
const WORK_PER_TOKEN = 48;
const CHARS_PER_WORK = 32;
const MAX_EXPRESSION_TOKENS = 400;
const MAX_SHELL_TOKENS = 2_000;
const MAX_NESTING = 64;
const MAX_OBJECT_HOPS = 4;
const PENDING = Symbol("pending");

class WorkExhausted extends Error {}

class Meter {
  constructor(private left: number) {}

  spend(units = 1): void {
    this.left -= units;
    if (this.left < 0) throw new WorkExhausted();
  }

  spendText(text: string): void {
    this.spend(1 + Math.floor(text.length / CHARS_PER_WORK));
  }
}

// The directory depth of a file's own directory (`__dirname`).
export function packageDepth(path: string): number {
  return normalizeReachabilityPath(path).split("/").filter(Boolean).length - 1;
}

interface Location {
  kind: "loc";
  pos: number | null;
  min: number;
  // A URL value: "file" resolves relative references against its parent,
  // "dir" (trailing slash) against itself.
  url?: "file" | "dir";
}
interface Text {
  kind: "text";
  text: string;
}
type PathValue = Location | Text | null;

const SEPARATOR = /[\\/]+/;
const UNPLACED: Location = { kind: "loc", pos: null, min: Number.POSITIVE_INFINITY };

function isAbsoluteText(text: string): boolean {
  return (
    /^[\\/~]/.test(text) ||
    /^[A-Za-z]:/.test(text) ||
    /^[a-z][\w+.-]*:\/\//i.test(text) ||
    /^file:/i.test(text)
  );
}

function at(pos: number): Location {
  return { kind: "loc", pos, min: pos };
}

function parentOf(location: Location): Location | null {
  if (location.pos === null) return null;
  const pos = location.pos - 1;
  return { kind: "loc", pos, min: Math.min(location.min, pos) };
}

// Literal text from the package, with the analysis' own marker characters
// replaced: a string that spelled an anchored word could otherwise place
// itself wherever it liked.
function literal(text: string): string {
  return text.replaceAll(OPAQUE, "_").replaceAll(ANCHOR, "_");
}

function capText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}${OPAQUE}` : text;
}

// Callers stop appending once `isCapped`, so a long chain of parts costs at
// most one capped string.
function appendCapped(acc: string, part: string): string {
  return capText(acc + part);
}

function isCapped(text: string): boolean {
  return text.length > MAX_TEXT;
}

// Walks literal segments from a location. A non-literal segment stops the walk
// but keeps the lowest position already reached.
function walk(from: Location, text: string): Location {
  let { pos, min } = from;
  for (const segment of text.split(SEPARATOR)) {
    if (pos === null) break;
    if (segment === "" || segment === ".") continue;
    if (segment.includes(OPAQUE) || segment.includes(ANCHOR)) {
      pos = null;
      break;
    }
    if (segment === "..") {
      pos -= 1;
      min = Math.min(min, pos);
    } else {
      pos += 1;
    }
  }
  return { kind: "loc", pos, min };
}

// Appends text with no separator in between: `__dirname + '-x'` renames the
// last segment, which is a step up and back down into a sibling.
function concatenate(from: Location, text: string): Location {
  if (from.pos === null) return from;
  if (SEPARATOR.test(text[0] ?? "")) return walk(from, text);
  const renamed: Location = { kind: "loc", pos: from.pos, min: Math.min(from.min, from.pos - 1) };
  const rest = text.split(SEPARATOR).slice(1).join("/");
  return text.includes(OPAQUE) && !SEPARATOR.test(text)
    ? { ...renamed, pos: null }
    : walk(renamed, rest);
}

function anchorWord(location: Location): string {
  if (!Number.isFinite(location.min)) return OPAQUE;
  return `${ANCHOR}${location.pos ?? "n"},${location.min}${ANCHOR}`;
}

// Places a path value: a location as is, a word carrying an embedded location
// from there, and a relative string against the cwd (null when the cwd is not
// known).
function resolveAt(cwd: Location | null, value: PathValue | string): Location | null {
  if (value === null) return null;
  if (typeof value !== "string" && value.kind === "loc") return value;
  const text = typeof value === "string" ? value : value.text;
  if (text.startsWith(ANCHOR)) {
    const close = text.indexOf(ANCHOR, 1);
    const [pos, min] = text.slice(1, close).split(",");
    if (close < 0 || min === undefined) return null;
    const from: Location = { kind: "loc", pos: pos === "n" ? null : Number(pos), min: Number(min) };
    return walk(from, text.slice(close + 1));
  }
  if (!text || cwd === null || isAbsoluteText(text) || text.startsWith(OPAQUE)) return null;
  return walk(cwd, text);
}

function escapes(location: Location | null): boolean {
  return location !== null && location.min < 0;
}

const PATH_MODULES = /^(?:node:)?(?:path|path\/posix|path\/win32)$|^(?:upath|pathe)$/;
const URL_MODULES = /^(?:node:)?url$/;
const SHELLJS_MODULES = /^shelljs$/;
const CHILD_PROCESS_MODULES = /^(?:node:)?child_process$/;
const FS_MODULES = /^(?:node:)?fs(?:\/promises)?$|^(?:fs-extra|graceful-fs|mz\/fs)$/;
const PATH_FUNCTIONS = new Set(["dirname", "join", "resolve", "normalize"]);
const URL_FUNCTIONS = new Set(["fileURLToPath", "pathToFileURL"]);
const EXEC_SHELL_FUNCTIONS = new Set(["exec", "execSync", "execaCommand", "execaCommandSync"]);
const EXEC_ARGV_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
]);
const SHELLJS_ARGV_FUNCTIONS = new Set(["cp", "mv", "ln"]);
// Mutating filesystem methods (Sync suffix stripped) by which arguments are
// destinations. The receiver is not checked, so generic names (`copy`, `cp`,
// `move`, `rename`, `open`) count only as members, `*Sync` names or names
// imported from an fs module.
const FS_DESTINATION_FIRST = new Set([
  "writeFile",
  "appendFile",
  "truncate",
  "createWriteStream",
  "WriteStream",
  "outputFile",
  "outputJson",
  "outputJSON",
  "writeJson",
  "writeJSON",
  "ensureFile",
  "mkdir",
  "mkdirp",
  "mkdirs",
  "ensureDir",
  "emptyDir",
  "emptydir",
  "rm",
  "rmdir",
  "unlink",
]);
const FS_DESTINATION_SECOND = new Set(["copy", "copyFile", "cp"]);
// A hard link to an outside file is a write channel into it, and moving a
// sibling's file out mutates the sibling, so both arguments count.
const FS_DESTINATION_BOTH = new Set(["link", "ensureLink", "rename", "move"]);
const FS_SYMLINK = new Set(["symlink", "ensureSymlink"]);
const FS_BARE_NAMES = new Set([
  "writeFile",
  "appendFile",
  "copyFile",
  "symlink",
  "createWriteStream",
  "outputFile",
  "mkdirp",
]);
const WRITE_OPEN_CONSTANTS = /^O_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)$/;

function fsOperation(name: string): string | null {
  const base = name.replace(/Sync$/, "");
  if (
    FS_DESTINATION_FIRST.has(base) ||
    FS_DESTINATION_SECOND.has(base) ||
    FS_DESTINATION_BOTH.has(base) ||
    FS_SYMLINK.has(base) ||
    base === "open"
  ) {
    return base;
  }
  return null;
}

const STATEMENT_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "for",
  "if",
  "while",
  "do",
  "return",
  "function",
  "class",
  "try",
  "throw",
  "export",
  "import",
  "switch",
  "async",
  "await",
]);
// Keywords that cannot continue an expression, so an initializer ends before
// them even on the same line: `var a = var b = …` must not rescan the tail.
const HARD_STATEMENT_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "for",
  "if",
  "while",
  "do",
  "return",
  "try",
  "throw",
  "export",
  "switch",
]);
const CONTINUES_EXPRESSION = new Set([
  "+",
  "-",
  "*",
  "/",
  ",",
  "=",
  "(",
  "[",
  "{",
  ".",
  "?.",
  "?",
  ":",
  "||",
  "&&",
  "??",
]);

interface Binding {
  start: number;
  end: number;
}

// A function whose simple parameters take the values its call sites pass.
interface FunctionScope {
  name: string | null;
  params: Array<string | null>;
  bodyStart: number;
  bodyEnd: number;
  parent: number;
  // The `(` of an immediately invoked call, or -1.
  invoked: number;
}

const MAX_PARAMS = 16;

function lineStartsOf(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (src.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    }
  }
  return starts;
}

class JsSource {
  readonly toks: JsToken[];
  readonly texts: string[];
  readonly close: Int32Array;
  readonly open: Int32Array;
  readonly newlineBefore: Uint8Array;
  readonly bindings = new Map<string, Binding>();
  // Start token of each first declaration, so the scan can evaluate bindings
  // in source order.
  readonly bindingAt = new Map<number, string[]>();
  readonly pathModules = new Set(["path", "upath", "pathe"]);
  readonly urlModules = new Set(["url"]);
  readonly shellModules = new Set(["shell", "shelljs"]);
  readonly pathFunctions = new Map<string, string>();
  readonly execAliases = new Map<string, string>();
  readonly fsAliases = new Map<string, string>();
  readonly chdirAliases = new Set<string>();
  readonly functions: FunctionScope[] = [];
  // Innermost function whose body holds each token, or -1.
  readonly functionAt: Int32Array;
  readonly callSites = new Map<string, number[]>();
  readonly meter: Meter;
  private readonly lineStarts: number[];
  private readonly ends: Int32Array;

  constructor(
    readonly src: string,
    tokens: JsToken[],
    readonly depth: number,
  ) {
    this.toks = tokens.filter((token) => token.type !== "ws" && token.type !== "comment");
    const n = this.toks.length;
    this.meter = new Meter(MIN_WORK + WORK_PER_TOKEN * n);
    this.texts = this.toks.map((token) => jsTokenText(src, token));
    this.close = new Int32Array(n).fill(-1);
    this.open = new Int32Array(n).fill(-1);
    this.ends = new Int32Array(n).fill(-1);
    this.newlineBefore = new Uint8Array(n);
    for (let i = 1; i < n; i += 1) {
      const gap = src.slice(this.toks[i - 1].end, this.toks[i].start);
      if (gap.includes("\n") || gap.includes("\r")) this.newlineBefore[i] = 1;
    }
    this.lineStarts = lineStartsOf(src);
    const stack: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const text = this.texts[i];
      if (text === "(" || text === "[" || text === "{") stack.push(i);
      else if (text === ")" || text === "]" || text === "}") {
        const open = stack.pop();
        if (open !== undefined) {
          this.close[open] = i;
          this.open[i] = open;
        }
      }
    }
    this.functionAt = new Int32Array(n).fill(-1);
    this.collectBindings();
    this.collectFunctions();
  }

  line(index: number): number {
    const offset = this.toks[index]?.start ?? 0;
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  text(index: number): string {
    return this.texts[index] ?? "";
  }

  isIdent(index: number): boolean {
    return this.toks[index]?.type === "ident";
  }

  isMemberName(index: number): boolean {
    const before = this.text(index - 1);
    return before === "." || before === "?.";
  }

  stringValue(index: number): string | null {
    const token = this.toks[index];
    if (!token) return null;
    if (token.type === "string") return token.value === undefined ? null : literal(token.value);
    if (token.type === "template" && !this.texts[index].includes("${")) {
      return literal(this.texts[index].slice(1, -1));
    }
    return null;
  }

  // `require('x')` or `await import('x')` spanning [start, end).
  requiredModule(start: number, end: number): string | null {
    if (end - start === 4 && this.text(start) === "require" && this.text(start + 1) === "(") {
      return this.stringValue(start + 2);
    }
    if (
      end - start === 5 &&
      this.text(start) === "await" &&
      this.text(start + 1) === "import" &&
      this.text(start + 2) === "("
    ) {
      return this.stringValue(start + 3);
    }
    return null;
  }

  // End (exclusive) of the expression starting at `start`, memoized.
  expressionEnd(start: number): number {
    if (start >= this.toks.length) return start;
    const known = this.ends[start];
    if (known >= 0) return known;
    const limit = Math.min(this.toks.length, start + MAX_EXPRESSION_TOKENS);
    let i = start;
    while (i < limit) {
      this.meter.spend();
      const text = this.text(i);
      if (i > start) {
        if (HARD_STATEMENT_KEYWORDS.has(text) && this.isIdent(i) && !this.isMemberName(i)) break;
        if (this.newlineBefore[i]) {
          const prev = this.text(i - 1);
          if (!CONTINUES_EXPRESSION.has(prev) && !CONTINUES_EXPRESSION.has(text)) break;
          if (STATEMENT_KEYWORDS.has(text) && !CONTINUES_EXPRESSION.has(prev)) break;
        }
      }
      // A top-level `=` past the start is another assignment (`a = b.c = d`);
      // stopping there keeps initializer ranges disjoint.
      if (text === "," || text === ";" || text === ")" || text === "]" || text === "}") break;
      if (text === "=" && i > start) break;
      if (text === "(" || text === "[" || text === "{") {
        const close = this.close[i];
        if (close < 0) {
          i = limit;
          break;
        }
        i = close + 1;
        continue;
      }
      i += 1;
    }
    const end = Math.min(i, limit);
    this.ends[start] = end;
    return end;
  }

  private collectBindings(): void {
    const { toks } = this;
    for (let i = 0; i < toks.length; i += 1) {
      this.meter.spend();
      const text = this.text(i);
      if (text === "import" && !/^(?:\.|\(|\?\.)$/.test(this.text(i + 1))) this.collectImport(i);
      if ((text === "const" || text === "let" || text === "var") && this.text(i + 1) === "{") {
        const close = this.close[i + 1];
        if (close < 0 || this.text(close + 1) !== "=") continue;
        const init = close + 2;
        const initEnd = this.expressionEnd(init);
        if (initEnd - init === 1 && this.text(init) === "process") {
          this.collectProcessMembers(i + 2, close);
          continue;
        }
        const module = this.moduleOf(init, initEnd);
        if (module) this.collectDestructured(i + 2, close, module);
        continue;
      }
      // `const x = …`, and plain `x = …` for a `let x;` assigned later. A
      // chain `a = b = …` binds every name to the final value.
      if (!this.isIdent(i) || this.text(i + 1) !== "=" || this.isMemberName(i)) continue;
      const names = [this.text(i)];
      let start = i + 2;
      while (this.isIdent(start) && this.text(start + 1) === "=" && names.length < 64) {
        names.push(this.text(start));
        start += 2;
      }
      const end = this.expressionEnd(start);
      for (const name of names) this.bind(name, start, end);
      i = start - 1;
    }
  }

  private bind(name: string, start: number, end: number): void {
    if (!this.bindings.has(name)) {
      this.bindings.set(name, { start, end });
      const at = this.bindingAt.get(start);
      if (at) at.push(name);
      else this.bindingAt.set(start, [name]);
    }
    const module = this.moduleOf(start, end);
    if (module) this.registerModule(name, module);
    // `const run = require('child_process').execSync`, `const w = fs.writeFileSync`
    const member = this.text(end - 1);
    if (end - start < 3 || this.text(end - 2) !== ".") return;
    if (end - start >= 6 && (EXEC_SHELL_FUNCTIONS.has(member) || EXEC_ARGV_FUNCTIONS.has(member))) {
      this.execAliases.set(name, member);
    }
    if (fsOperation(member)) this.fsAliases.set(name, member);
    if (member === "chdir" && end - start === 3 && this.text(start) === "process") {
      this.chdirAliases.add(name);
    }
  }

  private collectFunctions(): void {
    for (let i = 0; i < this.toks.length; i += 1) {
      this.meter.spend();
      const text = this.text(i);
      if (this.isIdent(i) && this.text(i + 1) === "(" && !this.isMemberName(i)) {
        const before = this.text(i - 1);
        if (before !== "function" && before !== "*") {
          const sites = this.callSites.get(text);
          if (sites) sites.push(i + 1);
          else this.callSites.set(text, [i + 1]);
        }
      }
      if (text === "function" && this.isIdent(i)) this.collectFunction(i);
      else if (text === "=>") this.collectArrow(i);
    }
    // Bodies nest like the brackets that delimit them, so one sweep in body
    // order assigns each token its innermost function.
    const order = this.functions.map((_, index) => index);
    order.sort((x, y) => this.functions[x].bodyStart - this.functions[y].bodyStart);
    const stack: number[] = [];
    let next = 0;
    for (let t = 0; t < this.toks.length; t += 1) {
      while (stack.length && this.functions[stack[stack.length - 1]].bodyEnd < t) stack.pop();
      while (next < order.length && this.functions[order[next]].bodyStart <= t) {
        const scope = this.functions[order[next]];
        scope.parent = stack.length ? stack[stack.length - 1] : -1;
        if (scope.bodyEnd >= t) stack.push(order[next]);
        next += 1;
      }
      this.functionAt[t] = stack.length ? stack[stack.length - 1] : -1;
    }
  }

  // `function name(a, b) {…}`, or an anonymous one named by `name = function`.
  private collectFunction(keyword: number): void {
    let open = keyword + 1;
    if (this.text(open) === "*") open += 1;
    let name: string | null = null;
    if (this.isIdent(open) && this.text(open + 1) === "(") {
      name = this.text(open);
      open += 1;
    }
    if (this.text(open) !== "(" || this.close[open] < 0) return;
    const bodyStart = this.close[open] + 1;
    if (this.text(bodyStart) !== "{" || this.close[bodyStart] < 0) return;
    let before = keyword - 1;
    if (this.text(before) === "async") before -= 1;
    this.addFunction(name, open, this.close[open], bodyStart, this.close[bodyStart], before);
  }

  // `(a, b) => …`, `a => …`, named by a preceding `name =`.
  private collectArrow(arrow: number): void {
    let paramsStart: number;
    let paramsEnd: number;
    if (this.text(arrow - 1) === ")" && this.open[arrow - 1] >= 0) {
      paramsStart = this.open[arrow - 1];
      paramsEnd = arrow - 1;
    } else if (this.isIdent(arrow - 1)) {
      paramsStart = arrow - 2;
      paramsEnd = arrow;
    } else return;
    const bodyStart = arrow + 1;
    const bodyEnd =
      this.text(bodyStart) === "{" ? this.close[bodyStart] : this.expressionEnd(bodyStart) - 1;
    if (bodyEnd < bodyStart) return;
    let before = this.text(arrow - 1) === ")" ? paramsStart - 1 : arrow - 2;
    if (this.text(before) === "async") before -= 1;
    this.addFunction(null, paramsStart, paramsEnd, bodyStart, bodyEnd, before);
  }

  private addFunction(
    declared: string | null,
    paramsOpen: number,
    paramsClose: number,
    bodyStart: number,
    bodyEnd: number,
    before: number,
  ): void {
    let name = declared;
    if (
      !name &&
      (this.text(before) === "=" || this.text(before) === ":") &&
      this.isIdent(before - 1)
    ) {
      name = this.text(before - 1);
    }
    // `(function (d) {…})(x)` and `((d) => {…})(x)`.
    const invoked =
      this.text(before) === "(" &&
      this.close[before] === bodyEnd + 1 &&
      this.text(bodyEnd + 2) === "("
        ? bodyEnd + 2
        : -1;
    const params: Array<string | null> = [];
    let expectName = true;
    for (let i = paramsOpen + 1; i < paramsClose && params.length < MAX_PARAMS; i += 1) {
      this.meter.spend();
      const text = this.text(i);
      if ((text === "(" || text === "[" || text === "{") && this.close[i] > 0) {
        if (expectName) params.push(null);
        expectName = false;
        i = this.close[i];
        continue;
      }
      if (text === ",") {
        expectName = true;
        continue;
      }
      if (!expectName) continue;
      params.push(this.isIdent(i) ? text : null);
      expectName = false;
    }
    // A single bare arrow parameter has no parentheses around it.
    if (paramsClose - paramsOpen === 2 && this.isIdent(paramsOpen + 1) && !params.length) {
      params.push(this.text(paramsOpen + 1));
    }
    if (!params.some(Boolean)) return;
    this.functions.push({ name, params, bodyStart, bodyEnd, parent: -1, invoked });
  }

  private collectProcessMembers(start: number, end: number): void {
    for (let i = start; i < end; i += 1) {
      if (this.text(i) !== "chdir") continue;
      this.chdirAliases.add(this.text(i + 1) === ":" ? this.text(i + 2) : "chdir");
    }
  }

  private moduleOf(start: number, end: number): string | null {
    const required = this.requiredModule(start, end);
    if (required) return required;
    if (end - start === 1 && this.pathModules.has(this.text(start))) return "path";
    return null;
  }

  private registerModule(name: string, module: string): void {
    if (PATH_MODULES.test(module)) this.pathModules.add(name);
    if (URL_MODULES.test(module)) this.urlModules.add(name);
    if (SHELLJS_MODULES.test(module)) this.shellModules.add(name);
  }

  private collectDestructured(start: number, end: number, module: string): void {
    for (let i = start; i < end; i += 1) {
      this.meter.spend();
      if (this.toks[i]?.type !== "ident") continue;
      const imported = this.text(i);
      const alias =
        this.text(i + 1) === ":" || this.text(i + 1) === "as" ? this.text(i + 2) : imported;
      if (this.text(i + 1) === ":" || this.text(i + 1) === "as") i += 2;
      this.registerMember(module, imported, alias);
    }
  }

  private registerMember(module: string, imported: string, alias: string): void {
    if (PATH_MODULES.test(module) && PATH_FUNCTIONS.has(imported)) {
      this.pathFunctions.set(alias, imported);
    }
    if (URL_MODULES.test(module) && URL_FUNCTIONS.has(imported)) {
      this.pathFunctions.set(alias, imported);
    }
    if (CHILD_PROCESS_MODULES.test(module) || /^execa$/.test(module)) {
      if (EXEC_SHELL_FUNCTIONS.has(imported) || EXEC_ARGV_FUNCTIONS.has(imported)) {
        this.execAliases.set(alias, imported);
      }
    }
    if (FS_MODULES.test(module) && fsOperation(imported)) this.fsAliases.set(alias, imported);
  }

  private collectImport(i: number): void {
    // import x from 'm' | import * as x from 'm' | import { a as b } from 'm'
    let j = i + 1;
    const names: Array<[string, string]> = [];
    let namespace: string | null = null;
    while (j < this.toks.length && j < i + 64 && this.text(j) !== "from") {
      this.meter.spend();
      const text = this.text(j);
      if (text === ";") return;
      if (text === "*" && this.text(j + 1) === "as") {
        namespace = this.text(j + 2);
        j += 3;
        continue;
      }
      if (text === "{") {
        const close = this.close[j];
        if (close < 0 || close > i + 256) return;
        for (let k = j + 1; k < close; k += 1) {
          if (this.toks[k]?.type !== "ident") continue;
          const imported = this.text(k);
          const alias = this.text(k + 1) === "as" ? this.text(k + 2) : imported;
          if (this.text(k + 1) === "as") k += 2;
          names.push([imported, alias]);
        }
        j = close + 1;
        continue;
      }
      if (this.toks[j]?.type === "ident" && namespace === null && text !== "type") namespace = text;
      j += 1;
    }
    if (this.text(j) !== "from") return;
    const module = this.stringValue(j + 1);
    if (!module) return;
    if (namespace) this.registerModule(namespace, module);
    for (const [imported, alias] of names) this.registerMember(module, imported, alias);
  }
}

class JsAnalysis {
  found: InstallRootWrite | null = null;
  // The working directory relative operands resolve against: the package root
  // when a lifecycle script starts, moved by `process.chdir`; null once it
  // cannot be placed.
  private cwd: Location | null = at(0);
  private nesting = 0;
  private readonly values = new Map<string, PathValue | typeof PENDING>();
  private readonly words = new Map<string, string | typeof PENDING>();
  private readonly lists = new Map<string, string[] | null | typeof PENDING>();
  private readonly params = new Map<string, PathValue | typeof PENDING>();
  private readonly argsAt = new Map<number, Array<[number, number]>>();

  constructor(private readonly s: JsSource) {}

  run(): InstallRootWrite | null {
    const { s } = this;
    try {
      for (let i = 0; i < s.toks.length && !this.found; i += 1) {
        s.meter.spend();
        // Bindings are evaluated in source order and cached, so a long alias
        // chain resolves one link at a time instead of recursing through it.
        for (const binding of s.bindingAt.get(i) ?? []) this.bindingValue(binding);
        if (s.text(i + 1) === "(" && s.isIdent(i)) this.visitCall(i);
      }
    } catch (error) {
      if (!(error instanceof WorkExhausted)) throw error;
    }
    return this.found;
  }

  private record(index: number): void {
    if (!this.found) this.found = { line: this.s.line(index) };
  }

  // Call whose callee name is the token at `name`, `(` at name+1.
  private visitCall(name: number): void {
    const { s } = this;
    const fn = s.text(name);
    const open = name + 1;
    const close = s.close[open];
    if (close < 0) return;
    const member = s.isMemberName(name);

    if (
      (member && fn === "chdir" && this.isProcess(name - 2)) ||
      (!member && s.chdirAliases.has(fn)) ||
      (member && fn === "cd" && this.isShellModule(name - 1))
    ) {
      const [target] = this.args(open, close);
      this.cwd = target ? resolveAt(this.cwd, this.evaluate(target[0], target[1])) : null;
      return;
    }

    // Arguments are split only for calls this analysis reads: splitting every
    // call would rescan a bundle's outer IIFE once per call inside it.
    if (member && SHELLJS_ARGV_FUNCTIONS.has(fn) && this.isShellModule(name - 1)) {
      const words = this.args(open, close).map(([a, b]) => this.shellText(a, b));
      if (shellArgvWrites([fn, ...words], this.cwd, s.meter)) this.record(name);
      return;
    }

    const exec = member ? fn : (s.execAliases.get(fn) ?? fn);
    if (EXEC_SHELL_FUNCTIONS.has(exec) || EXEC_ARGV_FUNCTIONS.has(exec)) {
      const args = this.args(open, close);
      if (!args.length) return;
      if (EXEC_ARGV_FUNCTIONS.has(exec)) return this.visitArgvExec(name, args);
      const cwd = this.optionsCwd(args[1]);
      const command = this.shellText(args[0][0], args[0][1]);
      if (shellWrites(command, cwd, s.meter)) this.record(name);
      return;
    }

    const imported = member ? fn : (s.fsAliases.get(fn) ?? fn);
    const operation = fsOperation(imported);
    if (!operation) return;
    if (!member && !fn.endsWith("Sync") && !FS_BARE_NAMES.has(fn) && !s.fsAliases.has(fn)) return;
    this.visitFsCall(name, operation, this.args(open, close));
  }

  private visitFsCall(name: number, operation: string, args: Array<[number, number]>): void {
    const destination = (index: number): Location | null =>
      args[index] ? resolveAt(this.cwd, this.evaluate(args[index][0], args[index][1])) : null;
    if (operation === "open") {
      if (args[1] && this.writeFlag(args[1]) && escapes(destination(0))) this.record(name);
      return;
    }
    if (FS_DESTINATION_FIRST.has(operation)) {
      if (escapes(destination(0))) this.record(name);
      return;
    }
    if (FS_DESTINATION_SECOND.has(operation)) {
      if (escapes(destination(1))) this.record(name);
      return;
    }
    if (FS_DESTINATION_BOTH.has(operation)) {
      if (escapes(destination(1)) || escapes(destination(0))) this.record(name);
      return;
    }
    // symlink(target, path): a relative target resolves against the link's
    // own directory, not the cwd: `symlinkSync('../react', path.join(__dirname, 'h'))`.
    const link = destination(1);
    if (escapes(link)) return this.record(name);
    const target = args[0] ? this.evaluate(args[0][0], args[0][1]) : null;
    if (target?.kind === "loc") {
      if (escapes(target)) this.record(name);
      return;
    }
    const dir = link ? parentOf(link) : null;
    if (target?.kind === "text" && dir && escapes(resolveAt(dir, target))) this.record(name);
  }

  // An `open` flag that writes: `'w'`, `'a+'`, `'r+'`, or a write constant.
  private writeFlag([start, end]: [number, number]): boolean {
    const { s } = this;
    for (let i = start; i < end; i += 1) {
      if (s.isIdent(i) && WRITE_OPEN_CONSTANTS.test(s.text(i))) return true;
    }
    const flag = this.evaluate(start, end);
    return flag?.kind === "text" && /^[rwaxs+]{1,4}$/.test(flag.text) && /[wa+]/.test(flag.text);
  }

  private visitArgvExec(name: number, args: Array<[number, number]>): void {
    const { s } = this;
    const file = this.shellText(args[0][0], args[0][1]);
    let words: string[] = [];
    let options = args[1];
    if (args[1] && s.text(args[1][0]) !== "{") {
      const list = this.arrayWords(args[1][0], args[1][1], MAX_OBJECT_HOPS);
      if (list) {
        words = list;
        options = args[2];
      }
    }
    const cwd = this.optionsCwd(options);
    const program = file.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    let writes: boolean;
    if (/^(?:sh|bash|zsh|dash|ksh)$/.test(program)) {
      const flag = words.findIndex((word) => /^-\w*c\w*$/.test(word));
      writes =
        flag >= 0 && words[flag + 1] !== undefined && shellWrites(words[flag + 1], cwd, s.meter);
    } else if (/^cmd(?:\.exe)?$/.test(program)) {
      const flag = words.findIndex((word) => /^\/c$/i.test(word));
      writes = flag >= 0 && shellWrites(words.slice(flag + 1).join(" "), cwd, s.meter);
    } else if (/\s/.test(file)) {
      writes = shellWrites([file, ...words].join(" "), cwd, s.meter);
    } else {
      writes = shellArgvWrites([file, ...words], cwd, s.meter);
    }
    if (writes) this.record(name);
  }

  private isProcess(index: number): boolean {
    return this.s.text(index) === "process" && !this.s.isMemberName(index);
  }

  private isPathCall(name: number): boolean {
    const { s } = this;
    const fn = s.text(name);
    if (!s.isMemberName(name)) return s.pathFunctions.has(fn) || URL_FUNCTIONS.has(fn);
    if (URL_FUNCTIONS.has(fn)) return this.isModule(name - 2, s.urlModules, URL_MODULES);
    if (!PATH_FUNCTIONS.has(fn)) return false;
    let receiver = name - 2;
    if (s.text(receiver) === "posix" || s.text(receiver) === "win32") receiver -= 2;
    return this.isModule(receiver, s.pathModules, PATH_MODULES);
  }

  // Whether tokens [start, end) are a path module object (`path`, `path.posix`).
  private isPathModuleExpression(start: number, end: number): boolean {
    let receiver = end - 1;
    if (this.s.text(receiver) === "posix" || this.s.text(receiver) === "win32") receiver -= 2;
    return receiver === start && this.isModule(receiver, this.s.pathModules, PATH_MODULES);
  }

  private isShellModule(dot: number): boolean {
    return this.isModule(dot - 1, this.s.shellModules, SHELLJS_MODULES);
  }

  // Whether the expression ending at `end` is a module object: a bound name or
  // a direct `require('m')`.
  private isModule(end: number, names: Set<string>, modules: RegExp): boolean {
    const { s } = this;
    if (s.isIdent(end) && !s.isMemberName(end)) return names.has(s.text(end));
    if (s.text(end) === ")") {
      const open = s.open[end];
      const module = open > 0 ? s.requiredModule(open - 1, end + 1) : null;
      return module !== null && modules.test(module);
    }
    return false;
  }

  private args(open: number, close: number): Array<[number, number]> {
    const { s } = this;
    const out: Array<[number, number]> = [];
    let start = open + 1;
    let i = start;
    while (i < close) {
      s.meter.spend();
      const text = s.text(i);
      if ((text === "(" || text === "[" || text === "{") && s.close[i] > 0) {
        i = s.close[i] + 1;
        continue;
      }
      if (text === ",") {
        out.push([start, i]);
        start = i + 1;
      }
      i += 1;
    }
    if (start < close) out.push([start, close]);
    return out;
  }

  // The first declaration of the single identifier spanning [index, end).
  private binding(index: number, end: number): Binding | null {
    const { s } = this;
    if (end - index !== 1 || !s.isIdent(index)) return null;
    const binding = s.bindings.get(s.text(index));
    if (!binding || (binding.start <= index && index < binding.end)) return null;
    return binding;
  }

  // Runs `compute` one level deeper, or returns `fallback` past the nesting
  // limit: package bytes can nest deeper than the stack.
  private nested<T>(fallback: T, compute: () => T): T {
    if (this.nesting >= MAX_NESTING) return fallback;
    this.nesting += 1;
    try {
      return compute();
    } finally {
      this.nesting -= 1;
    }
  }

  // The function parameter an identifier at `index` names, as
  // `function * MAX_PARAMS + position`, or -1.
  private parameter(index: number, name: string): number {
    const { s } = this;
    let scope = s.functionAt[index] ?? -1;
    for (let hops = 0; scope >= 0 && hops < MAX_NESTING; hops += 1) {
      s.meter.spend();
      const position = s.functions[scope].params.indexOf(name);
      if (position >= 0) return scope * MAX_PARAMS + position;
      scope = s.functions[scope].parent;
    }
    return -1;
  }

  // A parameter can hold whatever any call site passes; keep the value that
  // reaches lowest, as for `||` alternatives. Functions sharing a name share
  // call sites, so the value is cached per name and position.
  private parameterValue(key: number): PathValue {
    const { s } = this;
    const scope = s.functions[Math.floor(key / MAX_PARAMS)];
    const position = key % MAX_PARAMS;
    const cacheKey = scope.invoked >= 0 ? `@${key}` : `${scope.name ?? ""}#${position}`;
    const cached = this.params.get(cacheKey);
    if (cached === PENDING) return null;
    if (cached !== undefined) return cached;
    this.params.set(cacheKey, PENDING);
    const sites =
      scope.invoked >= 0 ? [scope.invoked] : scope.name ? (s.callSites.get(scope.name) ?? []) : [];
    let best: PathValue = null;
    for (const open of sites) {
      const arg = this.callArgs(open)[position];
      const value = arg ? this.evaluate(arg[0], arg[1]) : null;
      if (!value) continue;
      if (!best || (value.kind === "loc" && (best.kind !== "loc" || value.min < best.min))) {
        best = value;
      }
    }
    this.params.set(cacheKey, best);
    return best;
  }

  private callArgs(open: number): Array<[number, number]> {
    let args = this.argsAt.get(open);
    if (!args) {
      const close = this.s.close[open];
      args = close < 0 ? [] : this.args(open, close);
      this.argsAt.set(open, args);
    }
    return args;
  }

  // The value of the identifier at `index`: a parameter of an enclosing
  // function, else its first declaration.
  private identifierValue(index: number): PathValue {
    const name = this.s.text(index);
    const parameter = this.parameter(index, name);
    if (parameter >= 0) return this.nested(null, () => this.parameterValue(parameter));
    return this.binding(index, index + 1) ? this.bindingValue(name) : null;
  }

  // A binding's value does not depend on where it is read, so each is
  // evaluated once: padding a file with uses of a long chain cannot spend the
  // budget before the payload is reached.
  private bindingValue(name: string): PathValue {
    const cached = this.values.get(name);
    if (cached === PENDING) return null;
    if (cached !== undefined) return cached;
    const binding = this.s.bindings.get(name);
    if (!binding) return null;
    this.values.set(name, PENDING);
    const value = this.evaluate(binding.start, binding.end);
    this.values.set(name, value);
    return value;
  }

  // The `cwd` an exec runs in: the current cwd without an options object or
  // `cwd` key, null when it is present but cannot be placed.
  private optionsCwd(range: [number, number] | undefined, hops = MAX_OBJECT_HOPS): Location | null {
    const { s } = this;
    if (!range) return this.cwd;
    const [start, end] = range;
    const bound = this.binding(start, end);
    if (bound && hops > 0) return this.optionsCwd([bound.start, bound.end], hops - 1);
    if (s.text(start) !== "{" || s.close[start] !== end - 1) {
      // An unbound name is almost always a callback; a computed options value
      // may carry a cwd we cannot place.
      const callback =
        (end - start === 1 && s.isIdent(start)) ||
        s.text(start) === "function" ||
        s.text(start) === "async" ||
        s.text(start + 1) === "=>" ||
        (s.text(start) === "(" && s.text(s.close[start] + 1) === "=>");
      return callback ? this.cwd : null;
    }
    let spread = false;
    for (let i = start + 1; i < end - 1; i += 1) {
      s.meter.spend();
      const text = s.text(i);
      if ((text === "(" || text === "[" || text === "{") && s.close[i] > 0) {
        i = s.close[i];
        continue;
      }
      if (text === "...") spread = true;
      if (text !== "cwd" || (s.text(i - 1) !== "{" && s.text(i - 1) !== ",")) continue;
      if (s.text(i + 1) !== ":") return resolveAt(this.cwd, this.evaluate(i, i + 1));
      const valueStart = i + 2;
      return resolveAt(this.cwd, this.evaluate(valueStart, s.expressionEnd(valueStart)));
    }
    return spread ? null : this.cwd;
  }

  private arrayWords(start: number, end: number, hops: number): string[] | null {
    const { s } = this;
    const bound = this.binding(start, end);
    if (bound) {
      if (hops <= 0) return null;
      const name = s.text(start);
      const cached = this.lists.get(name);
      if (cached === PENDING) return null;
      if (cached !== undefined) return cached;
      this.lists.set(name, PENDING);
      const list = this.arrayWords(bound.start, bound.end, hops - 1);
      this.lists.set(name, list);
      return list;
    }
    if (s.text(start) !== "[" || s.close[start] !== end - 1) return null;
    return this.args(start, end - 1).map(([a, b]) => this.shellText(a, b));
  }

  // Shell text with literals kept, placed locations embedded as anchored
  // words, and everything else OPAQUE.
  private shellText(start: number, end: number): string {
    const { s } = this;
    s.meter.spend();
    if (start >= end) return OPAQUE;
    if (end - start === 1 && s.isIdent(start) && this.parameter(start, s.text(start)) >= 0) {
      return this.shellWord(this.identifierValue(start));
    }
    const bound = this.binding(start, end);
    if (bound) {
      const name = s.text(start);
      const cached = this.words.get(name);
      if (cached === PENDING) return OPAQUE;
      if (cached !== undefined) return cached;
      this.words.set(name, PENDING);
      const text = this.nested(OPAQUE, () => this.shellText(bound.start, bound.end));
      this.words.set(name, text);
      return text;
    }
    const parts = this.splitTopLevel(start, end, "+");
    if (parts.length > 1) {
      let text = "";
      for (const [a, b] of parts) {
        text = appendCapped(
          text,
          this.nested(OPAQUE, () => this.shellText(a, b)),
        );
        if (isCapped(text)) break;
      }
      s.meter.spendText(text);
      return text;
    }
    if (end - start === 1) {
      const literal = s.stringValue(start);
      if (literal !== null) return capText(literal);
      if (s.toks[start]?.type === "template") {
        let text = "";
        for (const part of templateParts(s.text(start))) {
          const word =
            part.literal ??
            this.shellWord(this.interpolation((part.expression ?? "").trim(), start));
          text = appendCapped(text, word);
          if (isCapped(text)) break;
        }
        s.meter.spendText(text);
        return text;
      }
    }
    return this.shellWord(this.evaluate(start, end));
  }

  private shellWord(value: PathValue): string {
    if (value?.kind === "loc") return anchorWord(value);
    if (value?.kind === "text") return value.text;
    return OPAQUE;
  }

  private splitTopLevel(start: number, end: number, operator: string): Array<[number, number]> {
    const { s } = this;
    const out: Array<[number, number]> = [];
    let partStart = start;
    for (let i = start; i < end; i += 1) {
      s.meter.spend();
      const text = s.text(i);
      if ((text === "(" || text === "[" || text === "{") && s.close[i] > 0) {
        i = s.close[i];
        continue;
      }
      if (text === operator) {
        out.push([partStart, i]);
        partStart = i + 1;
      }
    }
    out.push([partStart, end]);
    return out;
  }

  evaluate(start: number, end: number): PathValue {
    this.s.meter.spend();
    if (start >= end) return null;
    return this.nested(null, () => this.evaluateNested(start, end));
  }

  private evaluateNested(start: number, end: number): PathValue {
    const { s } = this;
    while (start < end && (s.text(start) === "await" || s.text(start) === "...")) start += 1;

    let alternatives = this.splitTopLevel(start, end, "||");
    if (alternatives.length === 1) alternatives = this.splitTopLevel(start, end, "??");
    if (alternatives.length > 1) {
      // Any alternative can be the runtime value; keep the one reaching lowest.
      let best: PathValue = null;
      for (const [a, b] of alternatives) {
        const value = this.evaluate(a, b);
        if (!value) continue;
        if (!best || (value.kind === "loc" && (best.kind !== "loc" || value.min < best.min))) {
          best = value;
        }
      }
      return best;
    }

    const parts = this.splitTopLevel(start, end, "+");
    if (parts.length > 1) {
      const head = this.evaluate(parts[0][0], parts[0][1]);
      if (!head) return null;
      // Joined before walking, so `__dirname + path.sep + '..'` reads `..` as
      // its own segment.
      let suffix = "";
      for (const [a, b] of parts.slice(1)) {
        const next = this.evaluate(a, b);
        suffix = appendCapped(suffix, next?.kind === "text" ? next.text : OPAQUE);
        if (isCapped(suffix)) break;
      }
      s.meter.spendText(suffix);
      return head.kind === "text"
        ? { kind: "text", text: appendCapped(head.text, suffix) }
        : concatenate(head, suffix);
    }
    return this.primary(start, end);
  }

  private primary(start: number, end: number): PathValue {
    const { s } = this;
    // Identity accessors on a path or URL value.
    for (;;) {
      s.meter.spend();
      if (
        end - start >= 3 &&
        s.text(end - 2) === "." &&
        /^(?:pathname|href)$/.test(s.text(end - 1))
      ) {
        end -= 2;
      } else if (
        end - start >= 5 &&
        s.text(end - 4) === "." &&
        s.text(end - 3) === "toString" &&
        s.text(end - 2) === "("
      ) {
        end -= 4;
      } else break;
    }
    const first = s.text(start);
    // `path.sep` / `path.posix.sep`, the separator an assembled path is joined with.
    if (
      s.text(end - 1) === "sep" &&
      s.text(end - 2) === "." &&
      this.isPathModuleExpression(start, end - 2)
    ) {
      return { kind: "text", text: "/" };
    }
    if (first === "(" && s.close[start] === end - 1) return this.evaluate(start + 1, end - 1);

    if (end - start === 1) {
      const literal = s.stringValue(start);
      if (literal !== null) return { kind: "text", text: capText(literal) };
      if (s.toks[start]?.type === "template") return this.template(start);
      if (first === "__dirname") return at(s.depth);
      if (first === "__filename") return at(s.depth + 1);
      return s.isIdent(start) ? this.identifierValue(start) : null;
    }
    if (
      end - start === 5 &&
      first === "import" &&
      s.text(start + 2) === "meta" &&
      s.text(start + 3) === "."
    ) {
      const field = s.text(start + 4);
      if (field === "dirname") return at(s.depth);
      if (field === "filename") return at(s.depth + 1);
      if (field === "url") return { ...at(s.depth + 1), url: "file" };
      return null;
    }
    if (
      end - start === 5 &&
      first === "process" &&
      s.text(start + 2) === "cwd" &&
      s.text(start + 3) === "("
    ) {
      return this.cwd;
    }
    if (
      first === "new" &&
      s.text(start + 1) === "URL" &&
      s.text(start + 2) === "(" &&
      s.close[start + 2] === end - 1
    ) {
      return this.url(this.args(start + 2, end - 1));
    }
    if (s.text(end - 1) !== ")") return null;
    const open = s.open[end - 1];
    if (open <= start || !s.isIdent(open - 1)) return null;
    const name = open - 1;
    if (!this.isPathCall(name)) return null;
    const fn = s.text(name);
    const args = this.args(open, end - 1);
    const operation = s.isMemberName(name) ? fn : (s.pathFunctions.get(fn) ?? fn);
    const value = (index: number): PathValue =>
      args[index] ? this.evaluate(args[index][0], args[index][1]) : null;
    switch (operation) {
      case "dirname": {
        const arg = value(0);
        if (!arg) return null;
        if (arg.kind === "text") return { kind: "text", text: capText(`${arg.text}/..`) };
        if (arg.pos === null) return { kind: "loc", pos: null, min: arg.min };
        return parentOf(arg);
      }
      case "normalize":
      case "fileURLToPath": {
        const arg = value(0);
        return arg?.kind === "loc" ? { kind: "loc", pos: arg.pos, min: arg.min } : arg;
      }
      case "pathToFileURL": {
        const arg = value(0);
        return arg?.kind === "loc" ? { ...arg, url: "file" } : null;
      }
      case "join":
      case "resolve":
        return this.joinOrResolve(args, operation === "resolve");
      default:
        return null;
    }
  }

  private joinOrResolve(args: Array<[number, number]>, resolve: boolean): PathValue {
    let acc: PathValue = resolve ? (this.cwd ?? UNPLACED) : null;
    for (const [index, [a, b]] of args.entries()) {
      const next = this.evaluate(a, b);
      if (index === 0 && !resolve) {
        acc = next;
        if (!acc) return null;
        continue;
      }
      if (!acc) return null;
      if (next?.kind === "loc") {
        // An anchored argument is absolute: resolve restarts from it, join
        // appends it as segments we cannot place.
        acc = resolve ? next : acc.kind === "loc" ? { kind: "loc", pos: null, min: acc.min } : null;
        continue;
      }
      if (next?.kind === "text") {
        if (resolve && isAbsoluteText(next.text)) {
          acc = UNPLACED;
          continue;
        }
        this.s.meter.spendText(next.text);
        acc =
          acc.kind === "text"
            ? { kind: "text", text: capText(`${acc.text}/${next.text}`) }
            : walk(acc, next.text);
        continue;
      }
      acc =
        acc.kind === "loc"
          ? { kind: "loc", pos: null, min: acc.min }
          : { kind: "text", text: capText(`${acc.text}/${OPAQUE}`) };
    }
    return acc;
  }

  private url(args: Array<[number, number]>): PathValue {
    if (args.length < 2) return null;
    const relative = this.evaluate(args[0][0], args[0][1]);
    const base = this.evaluate(args[1][0], args[1][1]);
    if (relative?.kind !== "text" || base?.kind !== "loc" || base.pos === null) return null;
    if (isAbsoluteText(relative.text) || /^[a-z][\w+.-]*:/i.test(relative.text)) return null;
    const dir = base.url === "dir" ? base : parentOf(base);
    if (!dir) return null;
    const resolved = walk(dir, relative.text);
    const isDir = /(?:^|[\\/])\.{0,2}$/.test(relative.text);
    return { ...resolved, url: isDir ? "dir" : "file" };
  }

  // Template literal: a leading interpolation that names a location anchors
  // the rest; every other interpolation is opaque.
  private template(index: number): PathValue {
    const raw = this.s.text(index);
    const parts = templateParts(raw);
    this.s.meter.spendText(raw);
    const [head, ...rest] = parts;
    const tail = capText(rest.map((part) => part.literal ?? OPAQUE).join(""));
    if (head?.expression !== undefined) {
      const anchor = this.interpolation(head.expression.trim(), index);
      if (anchor?.kind === "loc") return concatenate(anchor, tail);
    }
    return { kind: "text", text: capText(parts.map((part) => part.literal ?? OPAQUE).join("")) };
  }

  // `index` is the template token, which places the expression's scope.
  private interpolation(expression: string, index: number): PathValue {
    const { s } = this;
    if (expression === "__dirname" || expression === "import.meta.dirname") return at(s.depth);
    if (expression === "__filename" || expression === "import.meta.filename")
      return at(s.depth + 1);
    if (/^process\s*\.\s*cwd\s*\(\s*\)$/.test(expression)) return this.cwd;
    if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return null;
    const parameter = this.parameter(index, expression);
    if (parameter >= 0) return this.nested(null, () => this.parameterValue(parameter));
    return s.bindings.has(expression)
      ? this.nested(null, () => this.bindingValue(expression))
      : null;
  }
}

function templateParts(raw: string): Array<{ literal?: string; expression?: string }> {
  const body = raw.slice(1, raw.endsWith("`") ? -1 : undefined);
  const parts: Array<{ literal?: string; expression?: string }> = [];
  let text = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "\\") {
      text += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
        j += 1;
      }
      if (text || !parts.length) parts.push({ literal: literal(text) });
      parts.push({ expression: body.slice(i + 2, j - 1) });
      text = "";
      i = j;
      continue;
    }
    text += body[i];
    i += 1;
  }
  if (text) parts.push({ literal: literal(text) });
  if (parts[0]?.literal === "" && parts[1]?.expression !== undefined) parts.shift();
  return parts;
}

// The first install-time mutation whose destination lands outside the package
// directory of a file `depth` directories below the package root.
export function jsInstallRootWrite(source: string, depth: number): InstallRootWrite | null {
  if (!source) return null;
  const tokens = tokenizeJsWithinBudget(source);
  if (!tokens) return null;
  try {
    return new JsAnalysis(new JsSource(source, tokens, depth)).run();
  } catch (error) {
    if (error instanceof WorkExhausted) return null;
    throw error;
  }
}

// --- Shell commands ------------------------------------------------------

type ShellToken = { op: string } | { word: string };

function shellTokens(text: string, meter: Meter | null): ShellToken[] {
  const out: ShellToken[] = [];
  const source = text.slice(0, MAX_TEXT);
  meter?.spendText(source);
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ word });
    word = "";
    inWord = false;
  };
  const skipSubstitution = (start: number, open: string, close: string): number => {
    let depth = 1;
    let j = start;
    while (j < source.length && depth > 0) {
      if (source[j] === open) depth += 1;
      else if (source[j] === close) depth -= 1;
      j += 1;
    }
    return j;
  };
  let i = 0;
  while (i < source.length && out.length < MAX_SHELL_TOKENS) {
    const c = source[i];
    // A backslash escapes only shell metacharacters; before anything else it
    // is kept, since cmd.exe commands (`mklink /J h ..\react`) use it as the
    // path separator.
    if (c === "\\" && /[\s'"`$\\;&|<>()#*?]/.test(source[i + 1] ?? "")) {
      if (source[i + 1] !== "\n") {
        word += source[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      word += source.slice(i + 1, end < 0 ? source.length : end);
      inWord = true;
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\" && /["`$\\\n]/.test(source[j + 1] ?? "")) {
          word += source[j + 1];
          j += 2;
          continue;
        }
        if (source[j] === "$" || source[j] === "`") {
          word += OPAQUE;
          j =
            source[j] === "`"
              ? source.indexOf("`", j + 1) + 1 || source.length
              : dollarEnd(source, j);
          continue;
        }
        word += source[j];
        j += 1;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "$") {
      word += OPAQUE;
      inWord = true;
      i = source[i + 1] === "(" ? skipSubstitution(i + 2, "(", ")") : dollarEnd(source, i);
      continue;
    }
    if (c === "`") {
      word += OPAQUE;
      inWord = true;
      const end = source.indexOf("`", i + 1);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      flush();
      out.push({ op: ";" });
      i += 1;
      continue;
    }
    if (c === ">" || (c === "&" && source[i + 1] === ">")) {
      // `2>`, `&>`, `>>`, `>|`; `>&2` duplicates a descriptor and writes nothing.
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flush();
      i += c === "&" ? 2 : 1;
      while (source[i] === ">" || source[i] === "|") i += 1;
      if (source[i] === "&") {
        i += 1;
        while (/[\d-]/.test(source[i] ?? "")) i += 1;
        continue;
      }
      out.push({ op: ">" });
      continue;
    }
    if (c === "<") {
      flush();
      while (source[i] === "<") i += 1;
      out.push({ op: "<" });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
      flush();
      out.push({ op: ";" });
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      flush();
      out.push({ op: ";" });
      i += 1;
      continue;
    }
    if (c === "(" || c === ")") {
      flush();
      out.push({ op: c });
      i += 1;
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  flush();
  return out;
}

function dollarEnd(source: string, start: number): number {
  if (source[start + 1] === "{") {
    const end = source.indexOf("}", start + 2);
    return end < 0 ? source.length : end + 1;
  }
  let j = start + 1;
  if (/[?$!#*@\d-]/.test(source[j] ?? "")) return j + 1;
  while (/[\w]/.test(source[j] ?? "")) j += 1;
  return j;
}

const WRAPPERS = new Set([
  "env",
  "nice",
  "nohup",
  "sudo",
  "time",
  "command",
  "exec",
  "builtin",
  "xargs",
  "doas",
]);
const WRAPPER_VALUE_FLAGS = new Set(["-n", "-u", "-g", "-C", "-I", "-L", "-P"]);

function cwdLocation(cwd: number | Location | null): Location | null {
  return typeof cwd === "number" ? at(cwd) : cwd;
}

// Whether a shell command writes, copies, moves or links outside the package
// when it starts in `startCwd` (a depth, or null when unknown).
export function shellWrites(
  text: string,
  startCwd: number | Location | null,
  meter: Meter | null = null,
): boolean {
  let cwd = cwdLocation(startCwd);
  let writing = false;
  const stack: Array<Location | null> = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let pending: ">" | "<" | null = null;
  const flush = () => {
    for (const target of redirects) {
      if (escapes(resolveAt(cwd, target))) writing = true;
    }
    if (words.length) {
      const command = simpleCommand(words, cwd);
      cwd = command.cwd;
      if (command.writing) writing = true;
    }
    words = [];
    redirects = [];
    pending = null;
  };
  for (const token of shellTokens(text, meter)) {
    if ("word" in token) {
      if (pending === ">") redirects.push(token.word);
      else if (pending === null) words.push(token.word);
      pending = null;
      continue;
    }
    if (token.op === ">" || token.op === "<") {
      pending = token.op;
      continue;
    }
    flush();
    if (writing) return true;
    if (token.op === "(") stack.push(cwd);
    else if (token.op === ")" && stack.length) cwd = stack.pop() ?? null;
  }
  flush();
  return writing;
}

export function shellArgvWrites(
  words: string[],
  startCwd: number | Location | null,
  meter: Meter | null = null,
): boolean {
  meter?.spendText(words.join(" "));
  return simpleCommand(words, cwdLocation(startCwd)).writing;
}

interface CommandEffect {
  cwd: Location | null;
  writing: boolean;
}

// `.`, `./`, `..` or a trailing separator: the operand names a directory, so a
// link created there is placed *in* it rather than *as* it.
function isDirectoryOperand(word: string): boolean {
  return /^\.{1,2}$/.test(word) || /[\\/]$/.test(word);
}

function simpleCommand(input: string[], cwd: Location | null): CommandEffect {
  let words = input;
  // Leading assignments and transparent wrappers (`env X=1 nice ln …`).
  for (let guard = 0; guard < 8 && words.length; guard += 1) {
    if (/^[A-Za-z_]\w*=/.test(words[0])) {
      words = words.slice(1);
      continue;
    }
    if (!WRAPPERS.has(words[0])) break;
    let i = 1;
    while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i]))) {
      i += WRAPPER_VALUE_FLAGS.has(words[i]) ? 2 : 1;
    }
    if (words[0] === "nice" && /^-?\d+$/.test(words[i] ?? "")) i += 1;
    words = words.slice(i);
  }
  const effect: CommandEffect = { cwd, writing: false };
  if (!words.length) return effect;
  const verb = (words[0].split(/[\\/]/).pop() ?? "").toLowerCase();
  const args = words.slice(1);
  const location = (word: string | undefined) => (word === undefined ? null : resolveAt(cwd, word));
  const write = (word: string | undefined) => {
    if (escapes(location(word))) effect.writing = true;
  };

  if (verb === "cd" || verb === "pushd" || verb === "chdir") {
    const target = args.find((arg) => !/^(?:-[LPe@]|\/d)$/i.test(arg));
    effect.cwd = target === undefined ? null : resolveAt(cwd, target);
    return effect;
  }
  if (verb === "popd") {
    effect.cwd = null;
    return effect;
  }

  if (verb === "mklink") {
    const flags = args.filter((arg) => /^\/[a-z]$/i.test(arg)).map((arg) => arg.toLowerCase());
    const [link, target] = args.filter((arg) => !/^\/[a-z]$/i.test(arg));
    const linkAt = location(link);
    if (escapes(linkAt)) effect.writing = true;
    if (target !== undefined) {
      // Junctions and hard links resolve against the cwd; symlinks against the link.
      if (flags.includes("/j") || flags.includes("/h")) write(target);
      else {
        const dir = linkAt ? parentOf(linkAt) : null;
        if (dir && escapes(resolveAt(dir, target))) effect.writing = true;
      }
    }
    return effect;
  }

  const parsed = parseOperands(verb, args);
  if (verb === "copy" || verb === "move" || verb === "xcopy") {
    const operands = parsed.operands.filter((arg) => !/^\/[a-z-]+$/i.test(arg));
    if (operands.length >= 2) write(operands[operands.length - 1]);
    else if (escapes(cwd)) effect.writing = true;
    if (verb === "move") operands.forEach(write);
    return effect;
  }
  if (verb === "cp" || verb === "install" || verb === "rsync") {
    if (parsed.target !== undefined) write(parsed.target);
    else if (verb === "install" && parsed.flags.some((flag) => /^-[a-zA-Z]*d/.test(flag))) {
      parsed.operands.forEach(write);
    } else if (parsed.operands.length >= 2) write(parsed.operands[parsed.operands.length - 1]);
    return effect;
  }
  if (verb === "mv") {
    if (parsed.target !== undefined) write(parsed.target);
    parsed.operands.forEach(write);
    return effect;
  }
  if (verb === "tee") {
    parsed.operands.forEach(write);
    return effect;
  }
  if (verb === "sed") {
    if (!parsed.flags.some((flag) => /^-[a-zA-Z]*i|^--in-place/.test(flag))) return effect;
    const files = parsed.scriptGiven ? parsed.operands : parsed.operands.slice(1);
    files.forEach(write);
    return effect;
  }
  if (verb === "ln") {
    const symbolic = parsed.flags.some((flag) => /^-[a-zA-Z]*s|^--symbolic$/.test(flag));
    const relative = parsed.flags.some((flag) => /^-[a-zA-Z]*r|^--relative$/.test(flag));
    let targets = parsed.operands;
    let linkDir: Location | null;
    if (parsed.target !== undefined) {
      linkDir = location(parsed.target);
    } else if (targets.length >= 2) {
      const last = targets[targets.length - 1];
      targets = targets.slice(0, -1);
      if (isDirectoryOperand(last)) {
        linkDir = location(last);
      } else {
        // Otherwise read the last operand as the link's own path, the reading
        // that puts the link highest; `ln -s ../dist/cli.js bin/cli` stays
        // inside either way.
        const link = location(last);
        if (escapes(link)) effect.writing = true;
        linkDir = link ? parentOf(link) : null;
      }
    } else {
      linkDir = cwd;
    }
    if (escapes(linkDir)) effect.writing = true;
    for (const target of targets) {
      if (!symbolic || relative) write(target);
      else if (linkDir && escapes(resolveAt(linkDir, target))) effect.writing = true;
    }
    return effect;
  }
  return effect;
}

const VALUE_FLAGS: Record<string, Set<string>> = {
  install: new Set(["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"]),
  cp: new Set(["-S", "--suffix"]),
  rsync: new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--exclude-from"]),
  sed: new Set(["-e", "--expression", "-f", "--file", "-l"]),
  ln: new Set(["-S", "--suffix"]),
  mv: new Set(["-S", "--suffix"]),
};

const TARGET_DIRECTORY_VERBS = new Set(["cp", "mv", "ln", "install"]);

function parseOperands(
  verb: string,
  args: string[],
): { operands: string[]; flags: string[]; target?: string; scriptGiven: boolean } {
  const operands: string[] = [];
  const flags: string[] = [];
  let target: string | undefined;
  let scriptGiven = false;
  const valueFlags = VALUE_FLAGS[verb] ?? new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (TARGET_DIRECTORY_VERBS.has(verb) && arg.startsWith("--target-directory=")) {
      target = arg.slice("--target-directory=".length);
      continue;
    }
    if (
      TARGET_DIRECTORY_VERBS.has(verb) &&
      (arg === "-t" || arg === "--target-directory" || /^-[a-zA-Z]+t$/.test(arg))
    ) {
      flags.push(arg);
      target = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.push(arg);
      if (verb === "sed" && /^(?:-e|--expression|-f|--file)/.test(arg)) scriptGiven = true;
      if (valueFlags.has(arg)) i += 1;
      continue;
    }
    operands.push(arg);
  }
  return { operands, flags, target, scriptGiven };
}

// A lifecycle command starts at the package root.
export function shellInstallRootWrite(command: string): InstallRootWrite | null {
  return shellWrites(literal(command), 0) ? { line: 1 } : null;
}
