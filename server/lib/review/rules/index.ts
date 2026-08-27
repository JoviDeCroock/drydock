import type { DiffEntry, FileRecord, Finding, PackageJsonDiff, PackageJsonSummary } from "..";
import { buildRuleContext, type DeterministicFindingOptions } from "./context";
import { metadataFindings } from "./metadata";
import { scriptFindings } from "./scripts";
import { binaryFindings } from "./binaries";
import { dependencyDiffFindings } from "./deps";
import { entrypointDiffFindings, entrypointPresenceFindings } from "./entrypoints";

// Bump when deterministic rule semantics, severities, or coverage change in a
// way that should invalidate cached scan reports. Stored alongside each finding
// so historical reports can be traced back to the ruleset that produced them.
// Lives here (not in a family module) because versioning spans every family.
export const DETERMINISTIC_RULES_VERSION = "1.69.0";

export { DETERMINISTIC_RULE_IDS, deterministicRuleIds } from "./rule-ids";
export {
  codePatternsFor,
  FINDING_SECRET_PATTERNS,
  JS_PATTERN_SET,
  PYTHON_PATTERN_SET,
  PYTHON_EXECUTION_CAPABILITY_PATTERNS,
  SECRET_PATTERNS,
  SHELL_DOWNLOAD_EXECUTE_PATTERN_SET,
} from "./patterns";
export { safeJson } from "./helpers";
export type { DeterministicFindingOptions } from "./context";

// Every deterministic finding carries the same ruleset version, so the family
// modules tag rule IDs only and the version is stamped once here.
function stampVersion(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({ ...finding, ruleVersion: DETERMINISTIC_RULES_VERSION }));
}

export function deterministicFindings(
  files: FileRecord[],
  diff: DiffEntry[] = [],
  packageJsonSummary?: PackageJsonSummary | null,
  options: DeterministicFindingOptions = {},
): Finding[] {
  const ctx = buildRuleContext(files, diff, packageJsonSummary, options);
  return stampVersion([
    ...metadataFindings(ctx),
    ...scriptFindings(ctx),
    ...binaryFindings(ctx),
    ...entrypointPresenceFindings(ctx),
  ]);
}

export function packageJsonDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  return stampVersion([
    ...dependencyDiffFindings(packageJsonDiff, stagedPackageJsonText),
    ...entrypointDiffFindings(packageJsonDiff, stagedPackageJsonText),
  ]);
}
