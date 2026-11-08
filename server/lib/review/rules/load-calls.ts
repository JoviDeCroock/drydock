import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";
import type { RuleContext } from "./context";
import {
  isDocumentationPath,
  isJsonDataPath,
  isLoadableDataPath,
  isMarkupPath,
  isTypeDeclarationPath,
} from "./file-types";
import {
  normalizeReachabilityPath,
  scriptCommandTokens,
  scriptPathCandidates,
} from "./reachability";

// Whether something in the package provably loads a file as code. Used only to
// grade findings: a file nobody provably loads is still scanned.

// Path tokens in the arguments of calls that can load a file as code, so a
// data-looking file named there (`require(__dirname + '/payload.txt')`,
// `fork('run.css')`) keeps full severity. Basenames and bare extensions
// (`+ '.txt'`) are collected once so the per-file check is a set lookup.
const LOAD_CALL_ARGUMENTS =
  /\b(?:require|import|fork|Worker|spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?)\s*\(([^\n;]{0,300})/g;
const LOAD_CALL_PATH_TOKEN = /[^\s'"`\\/()+,;${}[\]]+/g;

const LOAD_CALL_NAMES = new WeakMap<RuleContext, Set<string>>();

// Collected once per rule pass; several rule families grade by it.
function codeLoadCallNames(ctx: RuleContext): Set<string> {
  // Only names some file here can be looked up by are kept: the text is hostile
  // and its distinct tokens are bounded only by the retained bytes.
  const lookups = new Set(ctx.files.flatMap((file) => loadCallLookupNames(file.path)));
  const names = new Set<string>();
  for (const file of ctx.files) {
    const path = file.path;
    if (!file.textSample || path === ctx.packageJsonFile?.path) continue;
    if (isJsonDataPath(path) || isLoadableDataPath(path) || isMarkupPath(path)) continue;
    if (isDocumentationPath(path) || isTypeDeclarationPath(path)) continue;
    LOAD_CALL_ARGUMENTS.lastIndex = 0;
    for (const call of file.textSample.matchAll(LOAD_CALL_ARGUMENTS)) {
      for (const [token] of call[1].matchAll(LOAD_CALL_PATH_TOKEN)) {
        const name = token.toLowerCase();
        if (lookups.has(name)) names.add(name);
      }
    }
  }
  return names;
}

// Reachable from main/bin/exports or a lifecycle hook through static imports,
// named by a lifecycle command, or named in a load call.
export function loadedAsCode(ctx: RuleContext, path: string): boolean {
  if (ctx.consumerReachable.has(normalizeReachabilityPath(path))) return true;
  return isLifecycleScriptFile(ctx, path) || namedInLoadCall(ctx, path);
}

// The file's name, stem or bare extension appears in a load call's arguments.
// A path assembled outside the call is not followed.
export function namedInLoadCall(ctx: RuleContext, path: string): boolean {
  let names = LOAD_CALL_NAMES.get(ctx);
  if (!names) {
    names = codeLoadCallNames(ctx);
    LOAD_CALL_NAMES.set(ctx, names);
  }
  const [basename, extension, stem] = loadCallLookupNames(path);
  return names.has(basename) || names.has(extension) || names.has(stem);
}

// Lowercased: `require('./PAYLOAD.TXT')` loads payload.txt on a case-insensitive
// filesystem. The stem covers `require('./app.min')`, which resolves app.min.js.
function loadCallLookupNames(path: string): [string, string, string] {
  const basename = (path.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase();
  return [basename, basename.slice(basename.lastIndexOf(".")), basename.replace(/\.[cm]?js$/, "")];
}

export function isLifecycleScriptFile(ctx: RuleContext, path: string): boolean {
  const candidates = new Set([...scriptPathCandidates(path)].map((value) => value.toLowerCase()));
  return CONSUMER_INSTALL_LIFECYCLE_SCRIPTS.some((script) => {
    const command = ctx.scripts[script];
    if (!command || ctx.implicitScripts[script] === command) return false;
    return scriptCommandTokens(command).some((token) => candidates.has(token.toLowerCase()));
  });
}
