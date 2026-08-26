import type { TarSuspiciousEntry } from "../tar-parser.js";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION, deterministicRuleIds } from "./rules";
import type { DiffEntry } from "./diff";

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
  obfuscated?: boolean;
  testScoped?: boolean;
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
  baselineComparisonSkipped?: boolean;
}

export { createPackageDiff } from "./diff";
export type { DiffEntry } from "./diff";
export { summarizePackageJsonDiff } from "./serialize";
export type { PackageJsonDiff, PackageJsonDiffEntry, PackageJsonSummary } from "./serialize";
export {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  PYTHON_EXECUTION_CAPABILITY_PATTERNS,
} from "./rules";
export { annotateFindingsWithDiffStatus, normalizeFindingDiffStatus } from "./diff-annotation";
export { redactFileRecords, redactFindings, redactJson, redactText } from "./redaction";

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Which rules score by capability co-occurrence versus anchoring at their
// severity is declared per rule in the manifest (`rules/rule-ids.ts`), with
// the rationale for each classification next to its entry.
const CODE_CAPABILITY_RULE_IDS = deterministicRuleIds((spec) => spec.risk !== "anchor");
const WEAK_LONE_CAPABILITY_RULE_IDS = deterministicRuleIds(
  (spec) => spec.risk === "weak-lone-capability",
);

function severityToRisk(severity: string | null | undefined): RiskLevel {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

export function tarSuspiciousEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
  options: {
    dialect?: "npm" | "pypi";
    fileDiff?: Array<Pick<DiffEntry, "status" | "flags">>;
  } = {},
): Finding[] {
  if (!entries || !entries.length) return [];
  const hasChangedSkippedContent = (options.fileDiff ?? []).some(
    (entry) =>
      (entry.status === "added" || entry.status === "modified") &&
      entry.flags.includes("content-skipped"),
  );
  return entries.map((entry) => ({
    severity: tarSuspiciousSeverity(entry, hasChangedSkippedContent),
    file: entry.path || "<unknown>",
    evidence: `${entry.kind}: ${entry.detail}`,
    reason: tarSuspiciousReason(entry, options.dialect ?? "npm"),
    ruleId: DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  }));
}

function tarSuspiciousSeverity(
  entry: TarSuspiciousEntry,
  hasChangedSkippedContent: boolean,
): Finding["severity"] {
  if (entry.kind === "non-regular") {
    return entry.detail.includes("(directory)") ? "info" : "high";
  }
  if (entry.kind === "retention-tier") {
    return hasChangedSkippedContent ? "medium" : "info";
  }
  return "medium";
}

function tarSuspiciousReason(entry: TarSuspiciousEntry, dialect: "npm" | "pypi"): string {
  switch (entry.kind) {
    case "non-regular":
      if (entry.detail.includes("(directory)")) {
        return dialect === "pypi"
          ? "archive contains an explicit directory entry; Python build backends normally emit these, so this is recorded for provenance but does not by itself indicate executable or link behavior"
          : "archive contains an explicit directory entry; npm pack normally emits regular file records, so this is recorded for provenance but does not by itself indicate executable or link behavior";
      }
      return dialect === "pypi"
        ? "Python build backends only emit regular file and directory records; symlinks, hardlinks, devices, FIFOs, or reserved entries in an sdist indicate a hand-crafted archive that may target the consumer's filesystem on extract"
        : "npm publish only emits regular files; symlinks, hardlinks, devices, FIFOs, directories, or reserved entries in a tarball indicate a hand-crafted archive that may target the consumer's filesystem on extract";
    case "duplicate":
      return "two entries share the same normalized path; last-write-wins extraction means a benign first entry can mask a malicious second";
    case "unicode-confusable":
      return "path contains zero-width or visually-confusable characters; the consumer's tar implementation may canonicalize this differently than the reviewer and let it bypass deterministic file checks";
    case "content-skipped":
      return "file body exceeded the scanner's retention limit, so only its path, size, and content hash were recorded; the content was never inspected — the diff's baseline hash comparison shows whether it changed, and its contents must be verified through provenance or out-of-band review";
    case "retention-tier":
      return "the archive is larger than the scanner's full-inspection tier, so some file bodies were recorded hash-only and never content-inspected; the diff's baseline hash comparison still shows whether each one changed, and changed-but-uninspected files must be verified through provenance or out-of-band review";
  }
}

export function computeRisk(
  findings: Array<{
    severity?: string | null;
    ruleId?: string | null;
    obfuscated?: boolean;
    testScoped?: boolean;
  }>,
): RiskLevel {
  let anchorRisk: RiskLevel = "low";
  const capabilities = new Map<string, { risk: RiskLevel; obfuscated: boolean }>();
  const testCapabilities = new Map<string, RiskLevel>();
  for (const finding of findings) {
    const ruleId = finding.ruleId ?? undefined;
    const risk = severityToRisk(finding.severity);
    if (ruleId && CODE_CAPABILITY_RULE_IDS.has(ruleId) && finding.testScoped) {
      testCapabilities.set(ruleId, combineRisk(testCapabilities.get(ruleId), risk));
    } else if (ruleId && CODE_CAPABILITY_RULE_IDS.has(ruleId)) {
      const prior = capabilities.get(ruleId);
      capabilities.set(ruleId, {
        risk: combineRisk(prior?.risk, risk),
        obfuscated: Boolean(prior?.obfuscated || finding.obfuscated),
      });
    } else {
      anchorRisk = combineRisk(anchorRisk, risk);
    }
  }
  return combineRisk(
    anchorRisk,
    codeCapabilityRisk(capabilities),
    testCapabilityRisk(testCapabilities),
  );
}

function testCapabilityRisk(capabilities: Map<string, RiskLevel>): RiskLevel {
  let highest: RiskLevel = "low";
  for (const [ruleId, risk] of capabilities) {
    highest = combineRisk(highest, WEAK_LONE_CAPABILITY_RULE_IDS.has(ruleId) ? "low" : risk);
  }
  return highest;
}

function codeCapabilityRisk(
  capabilities: Map<string, { risk: RiskLevel; obfuscated: boolean }>,
): RiskLevel {
  if (capabilities.size === 0) return "low";
  if (capabilities.size >= 2) {
    let highest: RiskLevel = "high";
    for (const [, { risk }] of capabilities) highest = combineRisk(highest, risk);
    return highest;
  }
  const [[ruleId, { risk, obfuscated }]] = capabilities;
  if (obfuscated) return risk;
  return WEAK_LONE_CAPABILITY_RULE_IDS.has(ruleId) ? "low" : risk;
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
