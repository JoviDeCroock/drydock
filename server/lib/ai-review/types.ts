import type { DiffEntry, FileRecord, Finding, PackageJsonDiff, RiskLevel } from "../review";
import type { AiFindingCategory, AiReviewEcosystem } from "./contract";

interface AiFinding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  /** Absent on reviews recorded before reviewer 1.8.0. */
  category?: AiFindingCategory;
  file: string;
  /** 1-based staged-file line the reviewer took from a search match (1.8.0+). */
  line?: number;
  evidence: string;
  reason: string;
  recommendation: string;
}

export interface AiDeterministicAssessment {
  ruleId: string;
  file: string;
  verdict: "confirmed" | "disputed";
  note: string;
}

export type AiReviewStatus = "complete" | "invalid" | "unavailable";

type AiReleaseAssessment = "nothing_unusual" | "review_recommended" | "suspicious" | "blocked";

export interface AiReview {
  status: AiReviewStatus;
  risk: RiskLevel;
  releaseAssessment: AiReleaseAssessment | "not_assessed";
  summary: string;
  findings: AiFinding[];
  requiresManualReview: boolean;
  /**
   * The reviewer's reading of individual deterministic findings (1.8.0+).
   * Display-only: it never edits a finding or moves any risk score.
   */
  deterministicAssessments?: AiDeterministicAssessment[];
  model: string | null;
  /** Version of the prompt, evidence tools, and routing contract used. */
  reviewerVersion: string | null;
}

// Operational telemetry for one AI review run. Kept off `AiReview` so it never
// reaches persistence or the report digest — it is emitted to observability
// only. Token counts are `null` when the provider does not report them.
export interface AiReviewUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  steps: number;
}

export interface AiReviewResult {
  review: AiReview;
  usage: AiReviewUsage | null;
}

export interface SelectiveAiReviewOptions {
  scanId?: string;
  stageId?: string;
  organizationId?: string;
  ecosystem: AiReviewEcosystem | string;
  files: FileRecord[];
  previousFiles?: FileRecord[];
  diff: DiffEntry[];
  packageJsonDiff: PackageJsonDiff;
  /**
   * Release-delta deterministic findings only (projectReleaseRuleFindings), so
   * the reviewer's deterministicRisk anchor is this release's score, not the
   * whole package's.
   */
  ruleFindings: Finding[];
  previousVersionAvailable: boolean;
}

export type DisplayedAiResult =
  | {
      kind: "complete";
      model: string | null;
      summary: string;
      risk: RiskLevel;
      releaseAssessment: AiReleaseAssessment;
      findings: AiFinding[];
      requiresManualReview: boolean;
      deterministicAssessments: AiDeterministicAssessment[];
    }
  | {
      kind: "unavailable";
      model: string | null;
      summary: string;
      status: Exclude<AiReviewStatus, "complete">;
    };

// Single safe accessor for AiReview consumers. The fallback shape returned when
// the assistant did not complete (`status` "invalid" or "unavailable") carries
// `risk: "low"` and `releaseAssessment: "not_assessed"` — reading those raw
// would surface "we couldn't review this" as "low risk / nothing unusual."
// Always route AiReview through this helper before rendering or computing risk.
export function displayedAiResult(review: AiReview | null | undefined): DisplayedAiResult | null {
  if (!review) return null;
  if (review.status === "complete" && review.releaseAssessment !== "not_assessed") {
    return {
      kind: "complete",
      model: review.model,
      summary: review.summary,
      risk: review.risk,
      releaseAssessment: review.releaseAssessment,
      findings: review.findings,
      requiresManualReview: review.requiresManualReview,
      deterministicAssessments: displayableDeterministicAssessments(
        review.deterministicAssessments,
      ),
    };
  }
  return {
    kind: "unavailable",
    model: review.model,
    summary: review.summary,
    status: review.status === "complete" ? "invalid" : review.status,
  };
}

// The scan page reads `ai_json` without schema validation, so this accessor is
// the one place a legacy (absent) or malformed list is reduced to what can be
// rendered as inert text.
function displayableDeterministicAssessments(value: unknown): AiDeterministicAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is AiDeterministicAssessment =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof entry.ruleId === "string" &&
      typeof entry.file === "string" &&
      (entry.verdict === "confirmed" || entry.verdict === "disputed") &&
      typeof entry.note === "string",
  );
}
