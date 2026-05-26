import type { AiReview } from "./ai-review";
import { combineRisk, computeRisk, normalizeRisk, type Finding, type RiskLevel } from "./review";

export interface ScanRiskBreakdown {
  artifactRisk: RiskLevel;
  releaseRisk: RiskLevel;
  contextRisk: RiskLevel;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
}

type RiskFinding = Finding & {
  diffStatus?: string | null;
  releaseDelta?: boolean | null;
};

export function computeScanRisk(ruleFindings: Finding[], aiFindings: AiReview): RiskLevel {
  const aiReviewCompleted = aiFindings.status === "complete";
  const aiHasEvidence = aiFindings.findings.length > 0 || aiFindings.requiresManualReview;
  return combineRisk(
    computeRisk(ruleFindings),
    aiReviewCompleted && aiHasEvidence ? aiFindings.risk : "low",
    aiReviewCompleted && aiFindings.requiresManualReview ? "medium" : "low",
  );
}

export function computeScanRiskBreakdown(
  ruleFindings: RiskFinding[],
  aiFindings: AiReview,
): ScanRiskBreakdown {
  const releaseFindings = ruleFindings.filter((finding) => finding.releaseDelta === true);
  const contextFindings = ruleFindings.filter((finding) => finding.releaseDelta !== true);
  return {
    artifactRisk: computeScanRisk(ruleFindings, aiFindings),
    releaseRisk: computeScanRisk(releaseFindings, aiFindings),
    contextRisk: computeRisk(contextFindings),
    releaseFindingCount: releaseFindings.length,
    contextFindingCount: contextFindings.length,
    unknownFindingCount: contextFindings.filter((finding) => finding.diffStatus === "unknown")
      .length,
  };
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
  return Object.keys(out).length ? out : null;
}
