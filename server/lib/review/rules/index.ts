import type { TarSuspiciousEntry } from "../../tar-parser.js";
import type { DiffEntry } from "../diff";
import type { PackageJsonDiff, PackageJsonSummary } from "../serialize";
import type { FileRecord, Finding } from "../types";
import { buildRuleContext, type DeterministicFindingOptions } from "./context";
import { metadataFindings } from "./metadata";
import { scriptFindings } from "./scripts";
import { binaryFindings } from "./binaries";
import { dependencyDiffFindings } from "./deps";
import { entrypointDiffFindings, entrypointPresenceFindings } from "./entrypoints";
import { propagationFindings } from "./propagation";
import { promptInjectionFindings } from "./prompt-injection";
import { tarEntryFindings } from "./tar-entries";

// Bump when deterministic rule semantics, severities, or coverage change in a
// way that should invalidate cached scan reports. Stored alongside each finding
// so historical reports can be traced back to the ruleset that produced them.
// Lives here (not in a family module) because versioning spans every family.
export const DETERMINISTIC_RULES_VERSION = "1.44.0";

export { DETERMINISTIC_RULE_IDS, deterministicRuleIds } from "./rule-ids";
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
    ...promptInjectionFindings(ctx),
    ...entrypointPresenceFindings(ctx),
    ...propagationFindings(ctx),
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

export function tarSuspiciousEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
  options: {
    dialect?: "npm" | "pypi";
    fileDiff?: Array<Pick<DiffEntry, "status" | "flags">>;
  } = {},
): Finding[] {
  return stampVersion(tarEntryFindings(entries, options));
}
