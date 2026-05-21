import type { AiReview } from "./ai-review";
import { combineRisk, computeRisk, type Finding, type RiskLevel } from "./review";

export function computeScanRisk(ruleFindings: Finding[], aiFindings: AiReview): RiskLevel {
  const aiReviewCompleted = aiFindings.status === "complete";
  const aiHasEvidence = aiFindings.findings.length > 0 || aiFindings.requiresManualReview;
  return combineRisk(
    computeRisk(ruleFindings),
    aiReviewCompleted && aiHasEvidence ? aiFindings.risk : "low",
    aiReviewCompleted && aiFindings.requiresManualReview ? "medium" : "low",
  );
}
