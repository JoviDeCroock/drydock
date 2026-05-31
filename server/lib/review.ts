import type { TarSuspiciousEntry } from "./tar-parser.js";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review-rules";
import type { DiffEntry } from "./review-diff";

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

export { createPackageDiff } from "./review-diff";
export type { DiffEntry } from "./review-diff";
export { summarizePackageJsonDiff } from "./review-serialize";
export type {
  DependencySection,
  PackageJsonDiff,
  PackageJsonDiffEntry,
  PackageJsonSummary,
} from "./review-serialize";
export {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
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
