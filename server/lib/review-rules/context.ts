import { isRootGypPath, normalizeStringRecord } from "../tar-parser.js";
import type { CodePatternSet, DiffEntry, FileRecord, PackageJsonSummary } from "../review";
import { codePatternsFor, LIFECYCLE_SCRIPTS, type JS_PATTERN_SET } from "./patterns";
import { safeJson } from "./helpers";

export interface DeterministicFindingOptions {
  codePatternSet?: CodePatternSet;
}

// How a file is reached from the package manifest. Capability weighting keys off
// this: code that runs automatically on install, or that the consumer invokes
// through a declared entrypoint, is materially riskier than a build/source file
// the manifest never references.
//   - install    — referenced by an explicit pre/post/install/prepare hook
//                   command; runs automatically on `npm install`.
//   - runtime     — the package's `bin`, `main`/`module`/`types`/`exports`
//                   entry (or the default `index.js` when none is declared);
//                   runs when the consumer imports or invokes the package.
//   - unreferenced — no manifest field references it; typically local maintainer
//                   build/source tooling the consumer never executes.
export type FileReachability = "install" | "runtime" | "unreferenced";

// Resolved inputs shared by every rule family for a single deterministic pass.
// Built once so the manifest parse, script normalization, and lookup maps are
// not recomputed per family.
export interface RuleContext {
  files: FileRecord[];
  diff: DiffEntry[];
  diffByPath: Map<string, DiffEntry>;
  packageJson: PackageJsonSummary | null;
  packageJsonFile: FileRecord | undefined;
  packageJsonParseFailed: boolean;
  scripts: Record<string, string>;
  implicitScripts: Record<string, string>;
  rootGypFile: FileRecord | undefined;
  patterns: typeof JS_PATTERN_SET;
  // Defaults to "javascript" so npm callers (which omit the option) read a
  // concrete value; the PyPI adapter passes "python". Main's constant-folding
  // pre-pass and this module's process-execution weighting both gate on it.
  codePatternSet: CodePatternSet;
  // Path tokens (normalized basenames/relative paths) that a lifecycle hook or
  // an entrypoint field points at. Precomputed once; consumed by fileReachability.
  installReferenceTokens: Set<string>;
  runtimeReferenceTokens: Set<string>;
  hasPackageRootEntryOverride: boolean;
}

export function buildRuleContext(
  files: FileRecord[],
  diff: DiffEntry[],
  packageJsonSummary: PackageJsonSummary | null | undefined,
  options: DeterministicFindingOptions,
): RuleContext {
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  const packageJsonFile = files.find((file) => file.path === "package.json" && file.textSample);
  const rawPackageJson = packageJsonFile?.textSample
    ? (safeJson(packageJsonFile.textSample) as PackageJsonSummary | null)
    : null;
  const packageJsonParseFailed = Boolean(packageJsonFile?.textSample) && rawPackageJson === null;
  const packageJson = packageJsonSummary ?? rawPackageJson;
  const scripts = normalizeStringRecord(packageJson?.scripts);
  const implicitScripts = normalizeStringRecord(packageJson?.implicitScripts);
  return {
    files,
    diff,
    diffByPath,
    packageJson,
    packageJsonFile,
    packageJsonParseFailed,
    scripts,
    implicitScripts,
    rootGypFile: files.find((file) => isRootGypPath(file.path)),
    patterns: codePatternsFor(options.codePatternSet),
    codePatternSet: options.codePatternSet ?? "javascript",
    installReferenceTokens: collectInstallReferenceTokens(scripts, implicitScripts),
    runtimeReferenceTokens: collectRuntimeReferenceTokens(packageJson),
    hasPackageRootEntryOverride: packageJsonHasPackageRootEntryOverride(packageJson),
  };
}

// Prefix shared by file-scoped rules so evidence reflects whether the match
// lands on a release delta.
export function changedPrefix(ctx: RuleContext, path: string): string {
  const changed = ctx.diffByPath.get(path)?.status;
  return changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";
}

// Resolve a file to its reachability tier from the manifest reference maps.
// Install reachability wins over runtime (a file both run on install and listed
// as an entrypoint is treated by its strongest, install-time, exposure).
export function fileReachability(ctx: RuleContext, path: string): FileReachability {
  if (setsIntersect(scriptPathCandidates(path), ctx.installReferenceTokens)) return "install";
  if (setsIntersect(runtimePathCandidates(path), ctx.runtimeReferenceTokens)) return "runtime";
  if (!ctx.hasPackageRootEntryOverride && isDefaultEntryFile(path)) return "runtime";
  return "unreferenced";
}

// npm resolves the package root entry to `index.js` (or its `.cjs`/`.mjs`
// siblings) unless package-root resolution is overridden by `main` or `exports`.
const DEFAULT_ENTRY_PATHS = new Set(["index.js", "index.cjs", "index.mjs"]);

function isDefaultEntryFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  return DEFAULT_ENTRY_PATHS.has(withoutPackage);
}

// Lifecycle hooks run automatically on `npm install`; any file their command
// references is install-reachable. Implicit defaults (e.g. npm's own
// `node-gyp rebuild`) are skipped so only maintainer-declared hooks count.
function collectInstallReferenceTokens(
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): Set<string> {
  const tokens = new Set<string>();
  for (const script of LIFECYCLE_SCRIPTS) {
    const command = scripts[script];
    if (!command || implicitScripts[script] === command) continue;
    for (const token of scriptCommandTokens(command)) tokens.add(token);
  }
  return tokens;
}

// `bin` (CLI), `main`/`module`/`types`, and `exports` string leaves are the
// surface a consumer invokes or imports when they use the package.
function collectRuntimeReferenceTokens(packageJson: PackageJsonSummary | null): Set<string> {
  const tokens = new Set<string>();
  if (!packageJson) return tokens;
  const bin = packageJson.bin;
  if (typeof bin === "string") addReferenceTokens(tokens, bin);
  else if (bin && typeof bin === "object") {
    for (const value of Object.values(bin)) {
      if (typeof value === "string") addReferenceTokens(tokens, value);
    }
  }
  for (const entry of [packageJson.main, packageJson.module, packageJson.types]) {
    if (typeof entry === "string") addReferenceTokens(tokens, entry);
  }
  collectExportStringLeaves(packageJson.exports, tokens);
  return tokens;
}

function addReferenceTokens(tokens: Set<string>, value: string): void {
  for (const token of entryReferenceTokens(value)) tokens.add(token);
}

// `exports` may be a string, a nested conditions/subpath object, or arrays of
// those; collect every string leaf as a referenced path.
function collectExportStringLeaves(node: unknown, tokens: Set<string>): void {
  if (typeof node === "string") {
    addReferenceTokens(tokens, node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectExportStringLeaves(item, tokens);
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectExportStringLeaves(value, tokens);
  }
}

function packageJsonHasPackageRootEntryOverride(packageJson: PackageJsonSummary | null): boolean {
  if (!packageJson) return false;
  return typeof packageJson.main === "string" || packageJson.exports != null;
}

// Normalize a file path to the set of forms a script command might use to name
// it: the full relative path, the `package/`-stripped path, the basename, and
// each of those with the extension dropped.
function scriptPathCandidates(path: string): Set<string> {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  const basename = withoutPackage.split("/").at(-1) ?? withoutPackage;
  const baseValues = [normalized, withoutPackage, basename];
  const values = [...baseValues];
  for (const value of baseValues) {
    values.push(value.replace(/\.[^/.]+$/, ""));
  }
  return new Set(values.filter(Boolean));
}

// Runtime entrypoints are manifest paths, not shell commands. Keep matching
// path-scoped so `main: "index.js"` does not make `src/index.js` reachable just
// because the basenames match.
function runtimePathCandidates(path: string): Set<string> {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  const baseValues = [normalized, withoutPackage];
  const values = [...baseValues];
  for (const value of baseValues) {
    values.push(value.replace(/\.[^/.]+$/, ""));
  }
  return new Set(values.filter(Boolean));
}

function entryReferenceTokens(value: string): string[] {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  const baseValues = [normalized, withoutPackage];
  const values = [...baseValues];
  for (const item of baseValues) {
    values.push(item.replace(/\.[^/.]+$/, ""));
  }
  return [...new Set(values.filter(Boolean))];
}

// Pull path-shaped tokens out of a script command, dropping any leading `./` so
// they line up with scriptPathCandidates output.
function scriptCommandTokens(command: string): string[] {
  return [...command.matchAll(/(?:\.\/)?[\w@./-]+(?:\.[\w-]+)?\b/g)].map((match) =>
    match[0].replace(/^\.\//, ""),
  );
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  if (!b.size) return false;
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}
