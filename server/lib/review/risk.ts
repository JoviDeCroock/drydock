import type { AiReview, DisplayedAiResult } from "../ai-review/types";
import { displayedAiResult } from "../ai-review/types";
import type { FindingProfileEntry, ReleaseConsistency } from "../scan/release-memory";
import { capRisk, combineRisk, computeRisk, normalizeRisk, severityToRisk } from "./";
import type { Finding, RiskLevel } from "./types";
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
  releaseDeltaKind?: string | null;
};

/**
 * One completed-review AI finding as the pipeline projects and diff-annotates
 * it (see mergeAiFindings). Its release attribution is file-level.
 */
interface AiRiskFinding {
  severity?: string | null;
  diffStatus?: string | null;
  releaseDelta?: boolean | null;
}

export interface ScanRiskOptions {
  baselineComparisonSkipped?: boolean;
  /**
   * The completed AI review's findings with their diff annotations, kept apart
   * from the deterministic `ruleFindings` so the review's contribution can be
   * bounded. When every one is package context, the review's risk is kept out
   * of `releaseRisk`. Omit (or pass empty) to score the review wholesale.
   */
  aiFindings?: ReadonlyArray<AiRiskFinding>;
}

type AiReleaseAssessment = Extract<DisplayedAiResult, { kind: "complete" }>["releaseAssessment"];

// The reviewer's own verdict bounds what its review can add to any score. A
// review that reports nothing unusual cannot raise risk however it labels its
// findings (it filed them to discuss evidence, not to flag it), and only a
// blocking verdict can reach critical. This only limits the AI's upgrade:
// every score is still combined with the deterministic one through a max.
const AI_VERDICT_RISK_CAP: Record<AiReleaseAssessment, RiskLevel> = {
  nothing_unusual: "low",
  review_recommended: "medium",
  suspicious: "high",
  blocked: "critical",
};

/** The most a completed review can add to any score, given its own verdict. */
export function aiVerdictRiskCap(releaseAssessment: AiReleaseAssessment): RiskLevel {
  return AI_VERDICT_RISK_CAP[releaseAssessment];
}

export function computeScanRisk(ruleFindings: Finding[], aiReview: AiReview): RiskLevel {
  return combineRisk(computeRisk(ruleFindings), aiArtifactRisk(aiReview));
}

export function computeScanRiskBreakdown(
  ruleFindings: RiskFinding[],
  aiFindings: AiReview,
  releaseConsistency?: ReleaseConsistency | null,
  options: ScanRiskOptions = {},
): ScanRiskBreakdown {
  const releaseFindings = ruleFindings.filter((finding) => finding.releaseDelta === true);
  // Only the release score treats an expanded capability as weaker; the
  // artifact score still describes everything the package does.
  const scoredReleaseFindings = releaseFindings.map((finding) =>
    finding.releaseDeltaKind === "expanded" ? { ...finding, expandedCapability: true } : finding,
  );
  const contextFindings = ruleFindings.filter((finding) => finding.releaseDelta !== true);
  const { kept: scoredContextFindings, approvedCount } = dropPriorApprovedFindings(
    contextFindings,
    // Never discount findings when the baseline was not compared.
    options.baselineComparisonSkipped ? null : releaseConsistency,
  );
  const scoredFindings =
    approvedCount === 0 ? ruleFindings : [...releaseFindings, ...scoredContextFindings];
  const aiRecords = options.aiFindings ?? [];
  const aiContextRecords = aiRecords.filter((finding) => finding.releaseDelta !== true);
  return {
    artifactRisk: computeScanRisk(scoredFindings, aiFindings),
    releaseRisk: combineRisk(
      computeRisk(scoredReleaseFindings),
      aiReleaseRisk(aiFindings, options.aiFindings),
    ),
    contextRisk: combineRisk(
      computeRisk(scoredContextFindings),
      aiFindingSeverityRisk(aiFindings, aiContextRecords),
    ),
    releaseFindingCount: releaseFindings.length + aiRecords.length - aiContextRecords.length,
    contextFindingCount: contextFindings.length + aiContextRecords.length,
    unknownFindingCount: [...contextFindings, ...aiContextRecords].filter(
      (finding) => finding.diffStatus === "unknown",
    ).length,
    priorApprovedContextFindingCount: approvedCount,
  };
}

// The whole review's contribution: its overall risk (when it cites evidence
// or asks for manual review) and its findings' severities, bounded by its own
// verdict. An attempted but unavailable review must not read as clean.
function aiArtifactRisk(aiReview: AiReview): RiskLevel {
  const ai = displayedAiResult(aiReview);
  if (ai?.kind !== "complete") {
    return ai?.kind === "unavailable" && ai.model != null ? "medium" : "low";
  }
  return withManualReviewFloor(ai, verdictBoundedRisk(ai, ai.findings));
}

// The deterministic side grades `releaseRisk` from release-delta findings only,
// and the workflow gate reads that score. The AI review's risk is a single
// review-level number, so it is attributed through the files its findings
// cite: when every cited file is package context (unchanged in this release),
// the concern is about the package, not the delta, and it must not reject a
// gate that nothing in the release changed. `artifactRisk` still carries it.
// The review's manual-review flag survives as its usual medium floor, which is
// below the gate's blocking threshold. Otherwise the review scores on the
// release exactly as on the artifact: bounded by its own verdict. Attribution
// is deliberately file-level and needs no finding at all — a reviewer told not
// to restate deterministic findings may escalate with none, and a located-line
// requirement would be defeated by a decoy call on an unchanged line, a clipped
// baseline, or a modified binary.
function aiReleaseRisk(
  aiReview: AiReview,
  annotatedAiFindings: ScanRiskOptions["aiFindings"],
): RiskLevel {
  const ai = displayedAiResult(aiReview);
  if (ai?.kind !== "complete") return aiArtifactRisk(aiReview);
  const annotated = annotatedAiFindings?.length ? annotatedAiFindings : null;
  if (
    annotated &&
    ai.findings.length > 0 &&
    !annotated.some((finding) => finding.releaseDelta === true)
  ) {
    return withManualReviewFloor(ai, "low");
  }
  const releaseAiFindings = annotated
    ? annotated.filter((finding) => finding.releaseDelta === true)
    : ai.findings;
  return withManualReviewFloor(ai, verdictBoundedRisk(ai, releaseAiFindings));
}

function verdictBoundedRisk(
  ai: Extract<DisplayedAiResult, { kind: "complete" }>,
  findings: ReadonlyArray<{ severity?: string | null }>,
): RiskLevel {
  const claimed = combineRisk(
    ai.findings.length > 0 || ai.requiresManualReview ? ai.risk : "low",
    ...findings.map((finding) => severityToRisk(finding.severity)),
  );
  return capRisk(claimed, AI_VERDICT_RISK_CAP[ai.releaseAssessment]);
}

// AI findings on package context still count toward `contextRisk`, under the
// same verdict bound as everywhere else.
function aiFindingSeverityRisk(
  aiReview: AiReview,
  findings: ReadonlyArray<AiRiskFinding>,
): RiskLevel {
  const ai = displayedAiResult(aiReview);
  if (ai?.kind !== "complete" || findings.length === 0) return "low";
  return capRisk(
    combineRisk(...findings.map((finding) => severityToRisk(finding.severity))),
    AI_VERDICT_RISK_CAP[ai.releaseAssessment],
  );
}

function withManualReviewFloor(
  ai: Extract<DisplayedAiResult, { kind: "complete" }>,
  risk: RiskLevel,
): RiskLevel {
  return combineRisk(risk, ai.requiresManualReview ? "medium" : "low");
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
