import type { DiffEntry, FileRecord, Finding, PackageJsonDiff, RiskLevel } from "./review";

export interface AiFinding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  recommendation: string;
}

export type AiReviewStatus = "complete" | "invalid" | "unavailable";

export interface AiReview {
  status: AiReviewStatus;
  risk: RiskLevel;
  releaseAssessment:
    | "nothing_unusual"
    | "review_recommended"
    | "suspicious"
    | "blocked"
    | "not_assessed";
  summary: string;
  findings: AiFinding[];
  requiresManualReview: boolean;
  model: string | null;
  escalated: boolean;
  escalationReasons: string[];
}

export interface SelectiveAiReviewOptions {
  scanId?: string;
  files: FileRecord[];
  previousFiles?: FileRecord[];
  diff: DiffEntry[];
  packageJsonDiff: PackageJsonDiff;
  ruleFindings: Finding[];
  previousVersionAvailable: boolean;
}

export interface PreAiEscalationInput {
  ruleFindings: Finding[];
  packageJsonDiff: PackageJsonDiff;
  previousVersionAvailable: boolean;
  defaultInputTokenEstimate?: number;
}
