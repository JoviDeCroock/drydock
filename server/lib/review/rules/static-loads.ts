import type { RuleContext } from "./context";
import { loaderCandidate } from "./dynamic-loaders";
import { isLoadableDataPath, isMinifiedBundlePath } from "./file-types";
import { codeViewsForScanning, normalizeCodeForScanning } from "./normalize";

// Load grading may demote a file nothing names only when it can tell what the
// package runs. A denylist of dynamic loaders cannot be complete (`require` has
// too many aliases), so this is an allowlist: every file the package runs must
// load only modules it names with a plain string literal and reach no code
// compiler. Anything else, anywhere, keeps every file at full severity.
//
// Allowed: `require('x')`, `require.resolve(…)`, `typeof require`, a static
// `import … from 'x'`, `import('x')`, `import.meta`, `module.exports`,
// `typeof module`, `module &&`/`module ===` guards, and `require`/`module`/
// `import` as object keys or another object's properties. Never allowed:
// eval, `Function` (beyond `Function.prototype`, `Function.toString` and
// `instanceof Function`), `x.constructor.constructor` or a constructor called
// off a parenthesised value (`(function(){}).constructor(src)`), the vm/module/
// worker_threads/repl/inspector/cluster builtins, a Worker, process.dlopen/
// binding, `mainModule`, a computed key or `Reflect.get` on `globalThis`,
// `global` or `process`, the AsyncFunction/GeneratorFunction constructor, a
// native addon, and with child_process: fork, execPath, argv0/argv[0] or a
// command that runs `node` by any path. Literal bracket keys and string
// concatenation are folded first (`module['req'+'uire']` reads as `module.require`), so
// checked text is both as written and folded. A key computed at run time off
// an alias of a global object is beyond this check.

const JS_PATH = /\.[cm]?js$/i;
const NODE_SHEBANG = /^#![^\n]*\bnode\b/;
const PYTHON_PATH = /\.pyw?$/i;

const TOKEN = /(?<![\w$])(?:require|module|import)(?![\w$])/g;
const DENIED =
  /(?<![\w$])(?:eval|mainModule|dlopen|importScripts|runIn(?:This|New)?Context|compileFunction|SourceTextModule|createRequire|_linkedBinding)(?![\w$])|\bprocess\s*\.\s*binding\b|(?<![\w$])Worker\s*\(|\.\s*constructor\s*\.\s*constructor\b|\)\s*\.\s*constructor\s*\(|(?<![\w$.])(?:globalThis|global|process)\s*\[\s*(?!["'`])|\bReflect\s*\.\s*get\s*\(\s*(?:globalThis|global|process|module)\b|\bgetPrototypeOf\s*\(\s*(?:async\b|function\s*\*)|(?:=>|\bfunction\s*\*?\s*\(\s*\))\s*\{\s*\}\s*\)\s*\.\s*constructor\b/g;
const FUNCTION = /(?<![\w$])Function(?![\w$])/g;
const DENIED_SPECIFIER =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'`])(?:node:)?(?:vm|module|worker_threads|repl|inspector|cluster)\1/;
const CHILD_PROCESS = /["'`](?:node:)?child_process["'`]/;
const NODE_RUN =
  /(?<![\w$])fork\s*\(|\.\s*fork\s*\(|\bexecPath\b|\bargv0\b|\bargv\s*\[\s*0\s*\]|["'`](?:[^"'`\n]*[\s/\\])?node(?:\.exe)?(?=["'`\s])/;
const PYTHON_DENIED =
  /(?<![\w.])(?:exec|eval|compile|__import__)\s*\(|\b(?:runpy|SourceFileLoader|zipimport)\b|\bimportlib\b(?!\s*\.\s*(?:metadata|resources)\b)|\bsys\s*\.\s*path\b/;

const STATIC = new WeakMap<RuleContext, boolean>();

/** Every file the package runs loads only files it names. */
export function loadsOnlyNamedFiles(ctx: RuleContext): boolean {
  let result = STATIC.get(ctx);
  if (result === undefined) {
    result = ctx.files.every((file) => fileLoadsOnlyNamed(ctx, file.path, file.textSample));
    STATIC.set(ctx, result);
  }
  return result;
}

function fileLoadsOnlyNamed(ctx: RuleContext, path: string, sample: string | undefined): boolean {
  // A native addon can load anything; a `.pth` runs its import lines at startup.
  if (/\.node$/i.test(path)) return false;
  if (!sample || !loaderCandidate(ctx, path)) return true;
  if (ctx.codePatternSet === "python") {
    if (/\.pth$/i.test(path)) return false;
    return !PYTHON_PATH.test(path) || !pythonLoads(sample);
  }
  // A loaded data file or bundle runs as JavaScript too.
  const runs =
    JS_PATH.test(path) ||
    NODE_SHEBANG.test(sample) ||
    isMinifiedBundlePath(path) ||
    isLoadableDataPath(path);
  if (!runs) return true;
  const normalized = normalizeCodeForScanning(sample);
  return (
    javaScriptLoadsOnlyNamed(path, sample) &&
    (normalized === sample || javaScriptLoadsOnlyNamed(path, normalized))
  );
}

function pythonLoads(sample: string): boolean {
  // Whole-line comments only: a `#` later on a line may sit in a string.
  return sample.split("\n").some((line) => !/^\s*#/.test(line) && PYTHON_DENIED.test(line));
}

// The raw text first: a violation there that is only prose or string content
// disappears in the code views, which cost a tokenizer pass.
function javaScriptLoadsOnlyNamed(path: string, text: string): boolean {
  if (firstViolation(text, text) === null) return true;
  const { code, codeNoStrings } = codeViewsForScanning(path, text);
  if (code === text && codeNoStrings === text) return false;
  return firstViolation(code, codeNoStrings) === null;
}

/** Offset of the first shape that loads something unnamed, or null. */
function firstViolation(code: string, codeNoStrings: string): number | null {
  if (DENIED_SPECIFIER.test(code)) return 0;
  if (CHILD_PROCESS.test(code)) {
    const run = NODE_RUN.exec(code);
    if (run) return run.index;
  }
  DENIED.lastIndex = 0;
  const denied = DENIED.exec(codeNoStrings);
  if (denied) return denied.index;
  for (const match of codeNoStrings.matchAll(FUNCTION)) {
    const before = codeNoStrings.slice(Math.max(0, match.index - 16), match.index);
    const after = codeNoStrings.slice(match.index + 8, match.index + 24);
    if (/\binstanceof\s+$/.test(before) || /^\s*\.\s*(?:prototype|toString)\b/.test(after))
      continue;
    return match.index;
  }
  for (const match of codeNoStrings.matchAll(TOKEN)) {
    if (!allowedToken(code, codeNoStrings, match.index, match[0])) return match.index;
  }
  return null;
}

function allowedToken(code: string, view: string, index: number, token: string): boolean {
  const before = view.slice(Math.max(0, index - 16), index);
  const end = index + token.length;
  const after = view.slice(end, end + 24);
  const member = /\.\s*$/.test(before);
  if (/\btypeof\s+$/.test(before)) return true;
  // An object key: `{ require: './x.cjs' }`, `exports: { import: … }`.
  if (/[{,]\s*$/.test(before) && /^\s*:/.test(after)) return true;
  if (token === "require") {
    if (member) return false;
    if (/^\s*\.\s*resolve\b/.test(after)) return true;
    return /^\s*\(/.test(after) && literalCall(code, end);
  }
  if (token === "module") {
    if (member) return true;
    return /^\s*(?:\.\s*exports\b|&&|[!=]==?)/.test(after);
  }
  // import
  if (/^\s*\.\s*meta\b/.test(after)) return true;
  if (/^\s*\(/.test(after)) return !member && literalCall(code, end);
  if (member) return true;
  return /^\s*(?:[\w$*{]|["'`])/.test(after);
}

// The call opening after `start` takes exactly one plain string literal.
function literalCall(code: string, start: number): boolean {
  let index = code.indexOf("(", start) + 1;
  while (/\s/.test(code[index] ?? "")) index += 1;
  const quote = code[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  for (let end = index + 1; end < code.length && end < index + 4096; end += 1) {
    const char = code[end];
    if (char === "\\") {
      end += 1;
      continue;
    }
    if (quote === "`" && char === "$" && code[end + 1] === "{") return false;
    if (char === "\n" && quote !== "`") return false;
    if (char !== quote) continue;
    let next = end + 1;
    while (/\s/.test(code[next] ?? "")) next += 1;
    return code[next] === ")";
  }
  return false;
}
