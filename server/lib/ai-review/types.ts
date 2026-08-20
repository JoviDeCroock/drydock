import type { DiffEntry, FileRecord, Finding, PackageJsonDiff, RiskLevel } from "../review";
import type { AiReviewEcosystem } from "./contract";

interface AiFinding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  recommendation: string;
}

/**
 * `pending` is the deferred-review placeholder: the deterministic report is
 * finished and readable, and the advisory review runs afterwards on its own
 * queue message (see docs/architecture.md "Scan pipeline"). It is deliberately
 * *not* a failure — `computeScanRisk` scores a pending review as no
 * contribution at all, so the risk a maintainer sees is the deterministic one
 * and the follow-up can only ever raise it.
 */
export type AiReviewStatus = "complete" | "invalid" | "unavailable" | "pending";

type AiReleaseAssessment = "nothing_unusual" | "review_recommended" | "suspicious" | "blocked";

export interface AiReview {
  status: AiReviewStatus;
  risk: RiskLevel;
  releaseAssessment: AiReleaseAssessment | "not_assessed";
  summary: string;
  findings: AiFinding[];
  requiresManualReview: boolean;
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
    }
  | {
      kind: "pending";
      model: string | null;
      summary: string;
    }
  | {
      kind: "unavailable";
      model: string | null;
      summary: string;
      status: Exclude<AiReviewStatus, "complete" | "pending">;
    };

// Single safe accessor for AiReview consumers. The fallback shape returned when
// the assistant did not complete (`status` "invalid" or "unavailable") carries
// `risk: "low"` and `releaseAssessment: "not_assessed"` — reading those raw
// would surface "we couldn't review this" as "low risk / nothing unusual."
// Always route AiReview through this helper before rendering or computing risk.
export function displayedAiResult(review: AiReview | null | undefined): DisplayedAiResult | null {
  if (!review) return null;
  // A deferred review that has not run yet is its own state. Collapsing it into
  // `unavailable` would be wrong in both directions: the reader would be told
  // the reviewer failed, and `computeScanRisk` would floor the scan at medium
  // for a review that is still on its way.
  if (review.status === "pending") {
    return { kind: "pending", model: review.model, summary: review.summary };
  }
  if (review.status === "complete" && review.releaseAssessment !== "not_assessed") {
    return {
      kind: "complete",
      model: review.model,
      summary: review.summary,
      risk: review.risk,
      releaseAssessment: review.releaseAssessment,
      findings: review.findings,
      requiresManualReview: review.requiresManualReview,
    };
  }
  return {
    kind: "unavailable",
    model: review.model,
    summary: review.summary,
    status: review.status === "complete" ? "invalid" : review.status,
  };
}

const AI_REVIEW_PENDING_SUMMARY =
  "AI review is still running; the deterministic findings below are final.";

/**
 * The placeholder persisted when the advisory review is deferred to its own
 * queue message. `model` is null on purpose — no model has been picked yet, and
 * a non-null model is what tells `computeScanRisk` a review was *attempted and
 * failed*.
 */
export function pendingAiReview(): AiReview {
  return {
    status: "pending",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: AI_REVIEW_PENDING_SUMMARY,
    findings: [],
    requiresManualReview: false,
    model: null,
    // Null for the same reason `model` is: no reviewer contract has been
    // exercised yet, so recording one would claim a run that has not happened.
    reviewerVersion: null,
  };
}
