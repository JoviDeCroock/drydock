import type { AiReview } from "./ai-review-types";
import { displayedAiResult } from "./ai-review-types";
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

export function computeScanRisk(ruleFindings: Finding[], aiReview: AiReview): RiskLevel {
  const ai = displayedAiResult(aiReview);
  const deterministicRisk = computeRisk(ruleFindings);
  if (ai?.kind !== "complete") {
    // Fail safe, not safe-looking. An AI review that was attempted but did not
    // complete (status invalid/unavailable while a model id is present) must
    // not let a release read as clean: a release could otherwise slip through
    // by inducing the reviewer to crash or emit an unparseable submission.
    // Escalate to manual-review risk. A review that never ran — AI review
    // disabled for the org, so `model` is null — stays neutral and contributes
    // nothing, preserving the deterministic-only verdict.
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
