import type { AiReview } from "../ai-review/types";
import { displayedAiResult } from "../ai-review/types";
import type { FindingProfileEntry, ReleaseConsistency } from "../scan/release-memory";
import { combineRisk, computeRisk, normalizeRisk, type Finding, type RiskLevel } from "./";

export interface ScanRiskBreakdown {
  artifactRisk: RiskLevel;
  releaseRisk: RiskLevel;
  contextRisk: RiskLevel;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
  /**
   * Context findings excluded from `contextRisk`/`artifactRisk` because the same
   * (ruleId, severity, file) entry was already in a release this organization
   * reviewed and approved for this package. 0 when release memory did not apply.
   */
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
    // Fail safe: a review that was attempted but didn't complete (model id
    // present) escalates to manual review so a release can't read as clean by
    // crashing the reviewer. A disabled review (model null) stays neutral.
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
): ScanRiskBreakdown {
  const releaseFindings = ruleFindings.filter((finding) => finding.releaseDelta === true);
  const contextFindings = ruleFindings.filter((finding) => finding.releaseDelta !== true);
  // Release memory adjusts package context only. A release-delta finding sits on
  // a file this release changed, so matching a prior profile entry proves
  // nothing about the new bytes — those keep scoring in full, which is what
  // keeps `releaseRisk` (and therefore the workflow gate) untouched.
  const { kept: scoredContextFindings, approvedCount } = dropPriorApprovedFindings(
    contextFindings,
    releaseConsistency,
  );
  const scoredFindings =
    approvedCount === 0 ? ruleFindings : [...releaseFindings, ...scoredContextFindings];
  return {
    artifactRisk: computeScanRisk(scoredFindings, aiFindings),
    releaseRisk: computeScanRisk(releaseFindings, aiFindings),
    contextRisk: computeRisk(scoredContextFindings),
    releaseFindingCount: releaseFindings.length,
    contextFindingCount: contextFindings.length,
    unknownFindingCount: contextFindings.filter((finding) => finding.diffStatus === "unknown")
      .length,
    priorApprovedContextFindingCount: approvedCount,
  };
}

/**
 * Remove context findings that were already present in the prior release this
 * organization approved for this package.
 *
 * A test runner's `code.process-execution` findings are a property of the
 * package, not of the release: re-anchoring every future release's headline on
 * evidence a maintainer already accepted is how a real signal ends up buried
 * (in production, every scan whose release delta was clean but whose package
 * context read high was published anyway).
 *
 * Fails closed. Any state where the approved set can't be reconstructed exactly
 * — no prior scan, or a `diverged` profile whose new-finding list was truncated
 * by RELEASE_CONSISTENCY_NEW_FINDINGS_CAP — drops no findings at all.
 *
 * Only deterministic findings are eligible. `resolveReleaseConsistency` builds
 * the profile from rule findings alone, so an AI finding was never compared
 * against the approved release and a `match` says nothing about it. AI findings
 * are projected without a `ruleId` (`projectAiReviewFindings`), which is what
 * distinguishes them here.
 */
function dropPriorApprovedFindings(
  contextFindings: RiskFinding[],
  releaseConsistency: ReleaseConsistency | null | undefined,
): { kept: RiskFinding[]; approvedCount: number } {
  const none = { kept: contextFindings, approvedCount: 0 };
  if (!releaseConsistency || !releaseConsistency.priorScanId) return none;

  const eligible = (finding: RiskFinding) => Boolean(finding.ruleId);

  if (releaseConsistency.status === "match" || releaseConsistency.status === "subset") {
    // Nothing deterministic in this scan is new relative to the approved
    // profile, so every deterministic context finding is previously-reviewed
    // evidence.
    const kept = contextFindings.filter((finding) => !eligible(finding));
    return { kept, approvedCount: contextFindings.length - kept.length };
  }
  if (releaseConsistency.status !== "diverged") return none;
  if (releaseConsistency.newFindings.length !== releaseConsistency.newFindingCount) return none;

  // Diverged: only the multiset difference (current − approved) is new. Consume
  // it per entry so a rule that fired three times before and four times now
  // keeps exactly one finding scoring.
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
