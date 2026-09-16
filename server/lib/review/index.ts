import { deterministicRuleIds } from "./rules";

export type {
  CodePatternSet,
  FileRecord,
  Finding,
  FindingDiffAnnotation,
  FindingDiffStatus,
  RiskLevel,
} from "./types";
import type { RiskLevel } from "./types";

export { createPackageDiff } from "./diff";
export type { DiffEntry } from "./diff";
export { summarizePackageJsonDiff } from "./serialize";
export type { PackageJsonDiff, PackageJsonDiffEntry, PackageJsonSummary } from "./serialize";
export {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  tarSuspiciousEntryFindings,
} from "./rules";
export { PYTHON_EXECUTION_CAPABILITY_PATTERNS } from "./rules/patterns";
export {
  annotateFindingsWithDiffStatus,
  normalizeFindingDiffStatus,
  projectReleaseRuleFindings,
} from "./diff-annotation";
export { redactFileRecords, redactFindings, redactJson, redactText } from "./redaction";

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Which rules score by capability co-occurrence versus anchoring at their
// severity is declared per rule in the manifest (`rules/rule-ids.ts`), with
// the rationale for each classification next to its entry.
const CODE_CAPABILITY_RULE_IDS = deterministicRuleIds(
  (spec) => spec.risk === "capability" || spec.risk === "weak-lone-capability",
);
const WEAK_LONE_CAPABILITY_RULE_IDS = deterministicRuleIds(
  (spec) => spec.risk === "weak-lone-capability",
);

function severityToRisk(severity: string | null | undefined): RiskLevel {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
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
