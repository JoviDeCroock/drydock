import type { AiReview } from "../ai-review/types";
import { displayedAiResult } from "../ai-review/types";
import type { FindingProfileEntry, ReleaseConsistency } from "../scan/release-memory";
import { combineRisk, computeRisk, normalizeRisk, type Finding, type RiskLevel } from "./";
import { deterministicRuleIds } from "./rules/rule-ids";

export interface ScanRiskBreakdown {
  artifactRisk: RiskLevel;
  releaseRisk: RiskLevel;
  contextRisk: RiskLevel;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
  priorApprovedContextFindingCount: number;
}

type RiskFinding = Finding & {
  diffStatus?: string | null;
  releaseDelta?: boolean | null;
};

export function computeScanRisk(ruleFindings: Finding[], aiReview: AiReview): RiskLevel {
  const ai = displayedAiResult(aiReview);
  const deterministicRisk = computeRisk(ruleFindings);
  if (ai?.kind !== "complete") {
    // An attempted but unavailable review must not read as clean.
    if (ai?.kind === "unavailable" && ai.model != null) {
      return combineRisk(deterministicRisk, "medium");
    }
    return deterministicRisk;
  }
  const aiHasEvidence = ai.findings.length > 0 || ai.requiresManualReview;
  return combineRisk(
    deterministicRisk,
    aiHasEvidence ? ai.risk : "low",
    ai.requiresManualReview ? "medium" : "low",
  );
}

export function computeScanRiskBreakdown(
  ruleFindings: RiskFinding[],
  aiFindings: AiReview,
  releaseConsistency?: ReleaseConsistency | null,
  options: { baselineComparisonSkipped?: boolean } = {},
): ScanRiskBreakdown {
  const releaseFindings = ruleFindings.filter((finding) => finding.releaseDelta === true);
  const contextFindings = ruleFindings.filter((finding) => finding.releaseDelta !== true);
  const { kept: scoredContextFindings, approvedCount } = dropPriorApprovedFindings(
    contextFindings,
    // Never discount findings when the baseline was not compared.
    options.baselineComparisonSkipped ? null : releaseConsistency,
  );
  const scoredFindings =
    approvedCount === 0 ? ruleFindings : [...releaseFindings, ...scoredContextFindings];
  const artifactRisk = computeScanRisk(scoredFindings, aiFindings);
  return {
    artifactRisk,
    // Without a trustworthy baseline, a low delta score is only an absence of
    // comparison evidence. Preserve the artifact risk as the public lower bound;
    // callers still use the explicit skip state to require manual review.
    releaseRisk: options.baselineComparisonSkipped
      ? artifactRisk
      : computeScanRisk(releaseFindings, aiFindings),
    contextRisk: computeRisk(scoredContextFindings),
    releaseFindingCount: releaseFindings.length,
    contextFindingCount: contextFindings.length,
    unknownFindingCount: contextFindings.filter((finding) => finding.diffStatus === "unknown")
      .length,
    priorApprovedContextFindingCount: approvedCount,
  };
}

// Approval never discounts evidence of active compromise.
const STANDING_DANGER_RULE_IDS = deterministicRuleIds((spec) => spec.standingDanger === true);

function dropPriorApprovedFindings(
  contextFindings: RiskFinding[],
  releaseConsistency: ReleaseConsistency | null | undefined,
): { kept: RiskFinding[]; approvedCount: number } {
  const none = { kept: contextFindings, approvedCount: 0 };
  if (!releaseConsistency || !releaseConsistency.priorScanId) return none;

  const eligible = (finding: RiskFinding) =>
    Boolean(finding.ruleId) && !STANDING_DANGER_RULE_IDS.has(finding.ruleId as string);

  if (releaseConsistency.status === "match" || releaseConsistency.status === "subset") {
    const kept = contextFindings.filter((finding) => !eligible(finding));
    return { kept, approvedCount: contextFindings.length - kept.length };
  }
  if (releaseConsistency.status !== "diverged") return none;
  if (releaseConsistency.newFindings.length !== releaseConsistency.newFindingCount) return none;

  const newCounts = new Map<string, number>();
  for (const entry of releaseConsistency.newFindings) {
    const key = profileKey(entry);
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  }
  const kept: RiskFinding[] = [];
  for (const finding of contextFindings) {
    if (!eligible(finding)) {
      kept.push(finding);
      continue;
    }
    const key = profileKey({
      ruleId: finding.ruleId ?? "unknown",
      severity: finding.severity,
      file: finding.file,
    });
    const remaining = newCounts.get(key) ?? 0;
    if (remaining > 0) {
      newCounts.set(key, remaining - 1);
      kept.push(finding);
    }
  }
  return { kept, approvedCount: contextFindings.length - kept.length };
}

function profileKey(entry: FindingProfileEntry): string {
  return `${entry.ruleId}\u0000${entry.severity}\u0000${entry.file}`;
}

export function normalizeScanRiskBreakdown(value: unknown): Partial<ScanRiskBreakdown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof ScanRiskBreakdown, unknown>>;
  const out: Partial<ScanRiskBreakdown> = {};
  if (typeof item.artifactRisk === "string") out.artifactRisk = normalizeRisk(item.artifactRisk);
  if (typeof item.releaseRisk === "string") out.releaseRisk = normalizeRisk(item.releaseRisk);
  if (typeof item.contextRisk === "string") out.contextRisk = normalizeRisk(item.contextRisk);
  if (typeof item.releaseFindingCount === "number") {
    out.releaseFindingCount = Math.max(0, Math.floor(item.releaseFindingCount));
  }
  if (typeof item.contextFindingCount === "number") {
    out.contextFindingCount = Math.max(0, Math.floor(item.contextFindingCount));
  }
  if (typeof item.unknownFindingCount === "number") {
    out.unknownFindingCount = Math.max(0, Math.floor(item.unknownFindingCount));
  }
  if (typeof item.priorApprovedContextFindingCount === "number") {
    out.priorApprovedContextFindingCount = Math.max(
      0,
      Math.floor(item.priorApprovedContextFindingCount),
    );
  }
  return Object.keys(out).length ? out : null;
}
