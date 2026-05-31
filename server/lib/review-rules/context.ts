import { isRootGypPath, normalizeStringRecord } from "../tar-parser.js";
import type { CodePatternSet, DiffEntry, FileRecord, PackageJsonSummary } from "../review";
import { codePatternsFor, type JS_PATTERN_SET } from "./patterns";
import { safeJson } from "./helpers";

export interface DeterministicFindingOptions {
  codePatternSet?: CodePatternSet;
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
  patterns: typeof JS_PATTERN_SET;
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
  return {
    files,
    diff,
    diffByPath,
    packageJson,
    packageJsonFile,
    packageJsonParseFailed,
    scripts: normalizeStringRecord(packageJson?.scripts),
    implicitScripts: normalizeStringRecord(packageJson?.implicitScripts),
    rootGypFile: files.find((file) => isRootGypPath(file.path)),
    patterns: codePatternsFor(options.codePatternSet),
  };
}

// Prefix shared by file-scoped rules so evidence reflects whether the match
// lands on a release delta.
export function changedPrefix(ctx: RuleContext, path: string): string {
  const changed = ctx.diffByPath.get(path)?.status;
  return changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";
}
