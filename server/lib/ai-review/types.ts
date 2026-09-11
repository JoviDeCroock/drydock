import type {
  CapabilityDelta,
  DiffEntry,
  FileRecord,
  Finding,
  PackageJsonDiff,
  RiskLevel,
} from "../review";
import type { AiReviewEcosystem } from "./contract";

interface AiFinding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  recommendation: string;
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
  // Advisory capability delta computed by the deterministic phase; context
  // for the reviewer's judgment, never something it can downgrade.
  capabilities?: CapabilityDelta;
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
    };
  }
  return {
    kind: "unavailable",
    model: review.model,
    summary: review.summary,
    status: review.status === "complete" ? "invalid" : review.status,
  };
}
