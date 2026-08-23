import { isRootGypPath, normalizeStringRecord } from "../../tar-parser.js";
import type { CodePatternSet, DiffEntry, FileRecord, PackageJsonSummary } from "..";
import { codePatternsFor, type JS_PATTERN_SET } from "./patterns";
import {
  consumerReachablePaths,
  lifecycleScriptSeedPaths,
  normalizeReachabilityPath,
} from "./reachability";
import { isTestPath } from "./file-types";
import { safeJson } from "./helpers";

export type EntrypointResolution = "npm" | "vscode";

export interface DeterministicFindingOptions {
  codePatternSet?: CodePatternSet;
  /**
   * Package-relative scripts that the ecosystem loads for consumers outside
   * package.json semantics, such as WebExtension background/content scripts.
   * These are reachability seeds only; callers must parse and validate paths.
   */
  consumerEntrypointPaths?: string[];
  /**
   * Opt an ecosystem into manifest-entrypoint resolution. Deliberately has no
   * default: the rule reads `package.json` semantics, and an ecosystem that
   * merely happens to carry a root `package.json` (a Python sdist bundling JS
   * assets) must not inherit npm's `require()` rules by omission.
   */
  entrypointResolution?: EntrypointResolution;
}

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
  consumerReachable: Set<string>;
  patterns: typeof JS_PATTERN_SET;
  codePatternSet: CodePatternSet | undefined;
  entrypointResolution: EntrypointResolution | null;
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
    consumerReachable: consumerReachablePaths(
      files,
      packageJson,
      [
        ...lifecycleScriptSeedPaths(files, scripts, implicitScripts),
        ...(options.consumerEntrypointPaths ?? []),
      ],
      options.codePatternSet,
    ),
    patterns: codePatternsFor(options.codePatternSet),
    codePatternSet: options.codePatternSet,
    entrypointResolution: options.entrypointResolution ?? null,
  };
}

// Prefix shared by file-scoped rules so evidence reflects whether the match
// lands on a release delta.
export function changedPrefix(ctx: RuleContext, path: string): string {
  const changed = ctx.diffByPath.get(path)?.status;
  return changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";
}

// A test-suite file nothing consumer-facing can statically reach. Capability
// findings in these files are demoted (never dropped): a test runner's own
// tests legitimately spawn processes and read the environment, but the file is
// still hostile evidence, so the finding survives at reduced severity.
export function isUnreachableTestFile(ctx: RuleContext, path: string): boolean {
  return isTestPath(path) && !ctx.consumerReachable.has(normalizeReachabilityPath(path));
}
