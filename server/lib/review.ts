import type { TarSuspiciousEntry } from "./tar-parser.js";
import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  firstJsonPropertyLine,
} from "./review-rules";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  textSample?: string;
  flags: string[];
}

export interface Finding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  line?: number;
  ruleId?: string;
  ruleVersion?: string;
}

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  implicitScripts?: Record<string, string>;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
}

export type DependencySection = "dependencies" | "optionalDependencies" | "peerDependencies";

export interface PackageJsonDiffEntry {
  key: string;
  status: "added" | "removed" | "modified";
  previous?: string;
  staged?: string;
  section?: DependencySection;
}

export interface PackageJsonDiff {
  name: string | null;
  previousVersion: string | null;
  stagedVersion: string | null;
  scripts: PackageJsonDiffEntry[];
  dependencies: PackageJsonDiffEntry[];
  entrypointsChanged: boolean;
}

export interface DiffEntry {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  previousSize?: number;
  stagedSize?: number;
  previousSha256?: string;
  stagedSha256?: string;
  flags: string[];
}

export type FindingDiffStatus = DiffEntry["status"] | "unknown";

export interface FindingDiffAnnotation {
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}

export type CodePatternSet = "javascript" | "python";

export interface FindingAnnotationOptions {
  previousFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  stagedFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  persistedAnnotations?: Map<string, FindingDiffAnnotation>;
  codePatternSet?: CodePatternSet;
}

export {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  PYTHON_EXECUTION_CAPABILITY_PATTERNS,
} from "./review-rules";
export type { DeterministicFindingOptions } from "./review-rules";
export {
  annotateFindingsWithDiffStatus,
  isReleaseDeltaStatus,
  normalizeFindingDiffStatus,
} from "./review-diff-annotation";
export { redactFileRecords, redactFindings, redactJson, redactText } from "./review-redaction";

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function tarSuspiciousEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
): Finding[] {
  if (!entries || !entries.length) return [];
  return entries.map((entry) => ({
    severity: tarSuspiciousSeverity(entry),
    file: entry.path || "<unknown>",
    evidence: `${entry.kind}: ${entry.detail}`,
    reason: tarSuspiciousReason(entry),
    ruleId: DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  }));
}

function tarSuspiciousSeverity(entry: TarSuspiciousEntry): Finding["severity"] {
  if (entry.kind === "non-regular") {
    return entry.detail.includes("(directory)") ? "info" : "high";
  }
  return "medium";
}

function tarSuspiciousReason(entry: TarSuspiciousEntry): string {
  switch (entry.kind) {
    case "non-regular":
      if (entry.detail.includes("(directory)")) {
        return "archive contains an explicit directory entry; npm pack normally emits regular file records, so this is recorded for provenance but does not by itself indicate executable or link behavior";
      }
      return "npm publish only emits regular files; symlinks, hardlinks, devices, FIFOs, directories, or reserved entries in a tarball indicate a hand-crafted archive that may target the consumer's filesystem on extract";
    case "duplicate":
      return "two entries share the same normalized path; last-write-wins extraction means a benign first entry can mask a malicious second";
    case "unicode-confusable":
      return "path contains zero-width or visually-confusable characters; the consumer's tar implementation may canonicalize this differently than the reviewer and let it bypass deterministic file checks";
  }
}

export function createPackageDiff(
  previousFiles: FileRecord[],
  stagedFiles: FileRecord[],
): DiffEntry[] {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const staged = new Map(stagedFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...staged.keys()])].sort();

  return paths.map((path) => {
    const before = previous.get(path);
    const after = staged.get(path);
    if (!before && after)
      return {
        path,
        status: "added",
        stagedSize: after.size,
        stagedSha256: after.sha256,
        flags: after.flags,
      };
    if (before && !after)
      return {
        path,
        status: "removed",
        previousSize: before.size,
        previousSha256: before.sha256,
        flags: before.flags,
      };
    if (before && after && before.sha256 !== after.sha256) {
      return {
        path,
        status: "modified",
        previousSize: before.size,
        stagedSize: after.size,
        previousSha256: before.sha256,
        stagedSha256: after.sha256,
        flags: [...new Set([...before.flags, ...after.flags])],
      };
    }
    return {
      path,
      status: "unchanged",
      previousSize: before?.size,
      stagedSize: after?.size,
      previousSha256: before?.sha256,
      stagedSha256: after?.sha256,
      flags: [...new Set([...(before?.flags || []), ...(after?.flags || [])])],
    };
  });
}

export function summarizePackageJsonDiff(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiff {
  const changedScripts = diffObject(previousPkg?.scripts || {}, stagedPkg?.scripts || {});
  const changedDependencies = diffDependencySections(previousPkg, stagedPkg);
  return {
    name: stagedPkg?.name || previousPkg?.name || null,
    previousVersion: previousPkg?.version || null,
    stagedVersion: stagedPkg?.version || null,
    scripts: changedScripts,
    dependencies: changedDependencies,
    entrypointsChanged:
      JSON.stringify([
        previousPkg?.bin,
        previousPkg?.main,
        previousPkg?.module,
        previousPkg?.types,
        previousPkg?.exports,
      ]) !==
      JSON.stringify([
        stagedPkg?.bin,
        stagedPkg?.main,
        stagedPkg?.module,
        stagedPkg?.types,
        stagedPkg?.exports,
      ]),
  };
}

export function packageJsonDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of packageJsonDiff.dependencies) {
    if (entry.status !== "added" && entry.status !== "modified") continue;
    if (entry.section === "optionalDependencies" && entry.status === "added") {
      findings.push({
        severity: "high",
        file: "package.json",
        line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
        evidence: `${entry.key}: ${entry.staged}`,
        reason:
          "optional dependencies can execute install lifecycle hooks while failing softly on unsupported platforms, so newly added optional dependencies require manual review",
        ruleId: DETERMINISTIC_RULE_IDS.dependencyOptionalAdded,
        ruleVersion: DETERMINISTIC_RULES_VERSION,
      });
    }
    if (!entry.staged) continue;
    const kind = unusualDependencySpecKind(entry.staged);
    if (!kind) continue;
    findings.push({
      severity: "high",
      file: "package.json",
      line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
      evidence: `${entry.key}: ${entry.staged}`,
      reason: `${kind} dependency specs resolve code outside normal npm semver ranges and can introduce unreviewed install-time behavior`,
      ruleId: DETERMINISTIC_RULE_IDS.dependencyUnusualSpec,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
  }
  return findings;
}

export function computeRisk(findings: Array<{ severity?: string | null }>): RiskLevel {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "high")) return "high";
  if (findings.some((f) => f.severity === "medium")) return "medium";
  return "low";
}

export function combineRisk(...risks: Array<RiskLevel | null | undefined>): RiskLevel {
  return risks.reduce<RiskLevel>((highest, risk) => {
    if (!risk) return highest;
    return RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest;
  }, "low");
}

export function normalizeRisk(value: unknown): RiskLevel {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

function diffDependencySections(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiffEntry[] {
  const sectionEntries = (section: DependencySection) =>
    diffObject(previousPkg?.[section] || {}, stagedPkg?.[section] || {}).map((entry) => ({
      ...entry,
      section,
    }));

  return [
    ...sectionEntries("dependencies"),
    ...sectionEntries("optionalDependencies"),
    ...sectionEntries("peerDependencies"),
  ].sort((a, b) => a.key.localeCompare(b.key) || a.section.localeCompare(b.section));
}

function unusualDependencySpecKind(spec: string): string | null {
  const normalized = spec.trim().toLowerCase();
  if (/^(?:github|gitlab|bitbucket):/.test(normalized)) return "git-hosted";
  if (/^(?:git\+ssh|git\+https|git\+http|git|ssh):/.test(normalized)) return "git";
  if (/^https?:/.test(normalized))
    return normalized.endsWith(".tgz") ? "remote tarball" : "remote URL";
  if (normalized.startsWith("file:")) return "local file";
  if (normalized.startsWith("npm:")) return "npm alias";
  return null;
}

function diffObject(
  before: Record<string, string>,
  after: Record<string, string>,
): PackageJsonDiffEntry[] {
  const out: PackageJsonDiffEntry[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in before)) out.push({ key, status: "added", staged: after[key] });
    else if (!(key in after)) out.push({ key, status: "removed", previous: before[key] });
    else if (before[key] !== after[key])
      out.push({ key, status: "modified", previous: before[key], staged: after[key] });
  }
  return out;
}
