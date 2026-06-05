import { isRootGypPath, normalizeStringRecord } from "../tar-parser.js";
import { scanContent } from "../review";
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
  // Full package.json text (scanText when truncated) used for manifest parsing
  // and finding line numbers, so a padded manifest can't push fields past the
  // persisted sample window.
  packageJsonText: string | null;
  packageJsonParseFailed: boolean;
  scripts: Record<string, string>;
  implicitScripts: Record<string, string>;
  rootGypFile: FileRecord | undefined;
  patterns: typeof JS_PATTERN_SET;
  codePatternSet: CodePatternSet | undefined;
}

export function buildRuleContext(
  files: FileRecord[],
  diff: DiffEntry[],
  packageJsonSummary: PackageJsonSummary | null | undefined,
  options: DeterministicFindingOptions,
): RuleContext {
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  const packageJsonFile = files.find((file) => file.path === "package.json" && file.textSample);
  const packageJsonText = packageJsonFile ? scanContent(packageJsonFile) : null;
  const rawPackageJson = packageJsonText
    ? (safeJson(packageJsonText) as PackageJsonSummary | null)
    : null;
  const packageJsonParseFailed = Boolean(packageJsonText) && rawPackageJson === null;
  const packageJson = packageJsonSummary ?? rawPackageJson;
  return {
    files,
    diff,
    diffByPath,
    packageJson,
    packageJsonFile,
    packageJsonText,
    packageJsonParseFailed,
    scripts: normalizeStringRecord(packageJson?.scripts),
    implicitScripts: normalizeStringRecord(packageJson?.implicitScripts),
    rootGypFile: files.find((file) => isRootGypPath(file.path)),
    patterns: codePatternsFor(options.codePatternSet),
    codePatternSet: options.codePatternSet,
  };
}

// Prefix shared by file-scoped rules so evidence reflects whether the match
// lands on a release delta.
export function changedPrefix(ctx: RuleContext, path: string): string {
  const changed = ctx.diffByPath.get(path)?.status;
  return changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";
}
