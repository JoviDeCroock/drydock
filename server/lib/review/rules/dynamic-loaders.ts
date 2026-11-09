import type { RuleContext } from "./context";
import { isUnreachableTestFile } from "./context";
import {
  isDocumentationPath,
  isJsonDataPath,
  isLoadableDataPath,
  isMarkupPath,
  isMinifiedBundlePath,
  isPythonMetadataPath,
  isTypeDeclarationPath,
} from "./file-types";
import { loadedAsCode } from "./load-calls";
import { codeViewsForScanning, normalizeCodeForScanning } from "./normalize";

// The clear shapes of code that loads a file no static reference names, for
// the `code.dynamic-load` finding. Whether load grading may demote anything is
// the separate allowlist in `static-loads.ts`: this list cannot be complete.

type DynamicLoaderKind = "computed-load" | "compiled-file" | "loader-hook";

export interface DynamicLoader {
  path: string;
  line: number;
  kind: DynamicLoaderKind;
  /** No loader at least this strong in the file's previous version. */
  introduced: boolean;
}

const RANK: Record<DynamicLoaderKind, number> = {
  "loader-hook": 0,
  "compiled-file": 1,
  "computed-load": 2,
};

// Call names whose first argument names a module or script to run, on any
// receiver (`require.main.require`, `cp.fork`, `new wt.Worker`). The argument
// is checked separately: a single plain string literal is a static load.
const SPECIFIER_CALL =
  /(?<![\w$])(?:require|import|createRequire|importScripts|fork|dlopen)\s*\(|\bnew\s+(?:[\w$]+\s*\.\s*)?Worker\s*\(|(?:\)|\bModule|\bconstructor)\s*\.\s*_load\s*\(/g;
// Compile a string as module code. Only `compiled-file` when a file read sits
// beside it; alone these are jsdom/vite-node style contexts.
const CODE_COMPILER =
  /\brunIn(?:This|New)?Context\s*\(|\bcompileFunction\s*\(|\bnew\s+(?:vm\s*\.\s*)?(?:Script|SourceTextModule)\s*\(|\._compile\s*\(|\b(?:Module|module\s*\.\s*constructor)\s*\.\s*_load\s*\(|\b(?:spawn|execFile|fork)(?:Sync)?\s*\(\s*process\s*\.\s*(?:execPath\b|argv0\b|argv\s*\[\s*0\s*\])/g;
// A `node` command, by any path, runs its script argument; read on the view
// with strings.
const NODE_COMMAND =
  /\b(?:spawn|execFile|exec|fork)(?:Sync)?\s*\(\s*["'`](?:[^"'`\n]*[\s/\\])?node(?:\.exe)?(?=["'`\s])/g;
// eval and the Function constructor are ordinary in bundles; only beside a
// file read are they a loader.
const EVALUATOR =
  /(?<![\w$.])(?:eval|Function)\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])eval\s*\)\s*\(/g;
// Extension hooks change how every later `require` compiles a file. Only the
// loader's own objects: `this._extensions` is a WebSocket or plugin table.
const LOADER_HOOK =
  /\brequire\s*\.\s*extensions\b|\b(?:Module|module\s*\.\s*constructor)\s*(?:\.\s*_extensions\b|\[\s*["']_extensions["']\s*\])/g;
// `require` or `module` handed on as a value (`{require}`, `[require]`,
// `require.call`, `const {require: r} = module`) is a load nothing here can
// follow.
const REQUIRE_AS_VALUE =
  /(?:[^=!<>]=|[:,(?{[]|\breturn)\s*(?:require|module)\s*(?=[;,)\]}\n]|$)|(?<![\w$.])module\s*\[|(?<![\w$.])require\s*\.\s*(?:call|apply|bind)\b/g;
const FILE_READ = /\b(?:readFileSync|readFile|createReadStream|readSync)\s*\(/g;
const COMPILED_FILE_WINDOW = 300;
const PREFILTER =
  /require|import|module|Worker|fork|dlopen|runIn|compileFunction|Script|_compile|_load|extensions|execPath|argv|node|eval|Function/;

// Python: text run as code without the import system's `.py` check.
const PYTHON_LOADER =
  /(?<![\w.])(?:exec|compile)\s*\(|\brunpy\s*\.\s*run_path\s*\(|\bSourceFileLoader\s*\(|\bspec_from_(?:file_location|loader)\s*\(|\bzipimport\b|\bsys\s*\.\s*path\s*\.\s*(?:append|insert|extend)\s*\(/g;

const LOADERS = new WeakMap<RuleContext, DynamicLoader[]>();

export function dynamicLoaders(ctx: RuleContext): DynamicLoader[] {
  let loaders = LOADERS.get(ctx);
  if (!loaders) {
    loaders = [];
    for (const file of ctx.files) {
      const sample = file.textSample;
      if (!sample || !loaderCandidate(ctx, file.path)) continue;
      const loader = firstLoader(ctx, file.path, sample);
      if (!loader) continue;
      // A rebuilt bundle or a register hook ships its loader every release;
      // only one the previous version lacked is this release's.
      const status = ctx.diffByPath.get(file.path)?.status;
      const previous = ctx.previousByPath.get(file.path)?.textSample;
      const before =
        status === "added" || previous === undefined ? null : firstLoader(ctx, file.path, previous);
      const introduced =
        status === "added" ||
        (status === "modified" && (!before || RANK[before.kind] > RANK[loader.kind]));
      loaders.push({ path: file.path, ...loader, introduced });
    }
    LOADERS.set(ctx, loaders);
  }
  return loaders;
}

function firstLoader(
  ctx: RuleContext,
  path: string,
  text: string,
): Omit<DynamicLoader, "path" | "introduced"> | null {
  return ctx.codePatternSet === "python"
    ? firstPythonLoader(text)
    : firstJavaScriptLoader(path, text);
}

// Files that run when something loads the package. A file load grading would
// itself demote is not one: its loader would only matter once it is loaded.
export function loaderCandidate(ctx: RuleContext, path: string): boolean {
  if (isDocumentationPath(path) || isTypeDeclarationPath(path) || isJsonDataPath(path)) {
    return false;
  }
  if (path === ctx.packageJsonFile?.path || isMarkupPath(path)) return false;
  if (ctx.codePatternSet === "python" && isPythonMetadataPath(path)) return false;
  if (isUnreachableTestFile(ctx, path)) return false;
  if (isMinifiedBundlePath(path) || isLoadableDataPath(path)) return loadedAsCode(ctx, path);
  return true;
}

function firstPythonLoader(sample: string): Omit<DynamicLoader, "path" | "introduced"> | null {
  PYTHON_LOADER.lastIndex = 0;
  for (const match of sample.matchAll(PYTHON_LOADER)) {
    const line = lineAt(sample, match.index);
    // A `#` earlier on the line is a comment.
    const start = sample.lastIndexOf("\n", match.index) + 1;
    if (sample.slice(start, match.index).includes("#")) continue;
    return { line, kind: "computed-load" };
  }
  return null;
}

// The text as written and with literal keys and concatenations folded
// (`module['req'+'uire']` reads as `module.require`; lines are kept).
function firstJavaScriptLoader(
  path: string,
  sample: string,
): Omit<DynamicLoader, "path" | "introduced"> | null {
  if (!PREFILTER.test(sample)) return null;
  const written = firstLoaderIn(path, sample);
  const normalized = normalizeCodeForScanning(sample);
  const folded = normalized === sample ? null : firstLoaderIn(path, normalized);
  if (!written || !folded) return written ?? folded;
  return RANK[folded.kind] < RANK[written.kind] ? folded : written;
}

function firstLoaderIn(
  path: string,
  sample: string,
): Omit<DynamicLoader, "path" | "introduced"> | null {
  // `code` keeps string bodies, which the literal-argument check reads;
  // `codeNoStrings` hides calls that exist only inside a string.
  const { code, codeNoStrings } = codeViewsForScanning(path, sample);
  const offsets: Array<[number, DynamicLoaderKind]> = [];
  for (const match of codeNoStrings.matchAll(SPECIFIER_CALL)) {
    if (!computedArgument(code, match.index + match[0].length)) continue;
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue;
    offsets.push([match.index, "computed-load"]);
    break;
  }
  for (const match of codeNoStrings.matchAll(REQUIRE_AS_VALUE)) {
    offsets.push([match.index, "computed-load"]);
    break;
  }
  const reads = [...codeNoStrings.matchAll(FILE_READ)].map((match) => match.index);
  let compilers = 0;
  for (const match of codeNoStrings.matchAll(CODE_COMPILER)) {
    if (reads.some((read) => Math.abs(read - match.index) <= COMPILED_FILE_WINDOW)) {
      offsets.push([match.index, "compiled-file"]);
      break;
    }
    if (compilers === 0) offsets.push([match.index, "computed-load"]);
    // Bounded: a bundle can hold thousands of compiler calls.
    if (++compilers >= 64) break;
  }
  for (const match of code.matchAll(NODE_COMMAND)) {
    offsets.push([match.index, "computed-load"]);
    break;
  }
  let evaluators = 0;
  for (const match of codeNoStrings.matchAll(EVALUATOR)) {
    if (reads.some((read) => Math.abs(read - match.index) <= COMPILED_FILE_WINDOW)) {
      offsets.push([match.index, "compiled-file"]);
      break;
    }
    if (++evaluators >= 64) break;
  }
  for (const match of codeNoStrings.matchAll(LOADER_HOOK)) {
    offsets.push([match.index, "loader-hook"]);
    break;
  }
  if (offsets.length === 0) return null;
  // The strongest shape names the finding; the earliest of that shape anchors it.
  offsets.sort((a, b) => RANK[a[1]] - RANK[b[1]] || a[0] - b[0]);
  const [offset, kind] = offsets[0];
  return { line: lineAt(code, offset), kind };
}

// Whether the argument opening at `start` is anything but one plain string
// literal (or no argument at all).
function computedArgument(code: string, start: number): boolean {
  let index = start;
  while (index < code.length && /\s/.test(code[index])) index += 1;
  const quote = code[index];
  if (quote === ")") return false;
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return !methodDefinition(code, index);
  }
  for (let end = index + 1; end < code.length && end < index + 4096; end += 1) {
    const char = code[end];
    if (char === "\\") {
      end += 1;
      continue;
    }
    if (quote === "`" && char === "$" && code[end + 1] === "{") return true;
    if (char === "\n" && quote !== "`") return true;
    if (char !== quote) continue;
    let next = end + 1;
    while (next < code.length && /\s/.test(code[next])) next += 1;
    return code[next] !== ")" && code[next] !== ",";
  }
  return true;
}

// `require(name) {`: a method or shim named `require`, not a call.
function methodDefinition(code: string, index: number): boolean {
  const close = code.indexOf(")", index);
  if (close < 0 || close - index > 200) return false;
  if (!/^[\w$\s,=]*$/.test(code.slice(index, close))) return false;
  return /^\s*\{/.test(code.slice(close + 1, close + 40));
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (
    let index = text.indexOf("\n");
    index >= 0 && index < offset;
    index = text.indexOf("\n", index + 1)
  ) {
    line += 1;
  }
  return line;
}
