import type { SupportedEcosystem } from "./config";

/** Artifact names the ecosystem workflow-gate guides upload, per release target. */
export const SETUP_ARTIFACT_NAMES: Record<SupportedEcosystem, string> = {
  npm: "npm-release-candidates",
  pypi: "pypi-release-candidate",
  vscode: "vscode-release-candidate",
};

interface PublisherSetupScope {
  installationRowId: string;
  repositoryFullName: string;
}

export interface PublisherSetupInspection extends PublisherSetupScope {
  repositoryId: number;
  defaultBranch: string;
  baseSha: string;
  workflows: { path: string; sha: string; content: string }[];
  warnings: string[];
}

export interface PublisherSetupDraftRequest extends PublisherSetupScope {
  workflowPath: string;
  baseSha: string;
  environment: string;
  ecosystem: SupportedEcosystem;
  createPullRequest?: true;
}

export interface PublisherSetupProposal extends PublisherSetupDraftRequest {
  repositoryId: number;
  defaultBranch: string;
  originalSha: string;
  content: string;
  summary: string;
  manualSteps: string[];
  expiresAt: number;
  supportingFiles?: {
    path: string;
    content: string;
    originalSha: string | null;
    originalContent: string | null;
  }[];
}

export interface PublisherSetupDraft {
  proposal: PublisherSetupProposal;
}

export interface PublisherSetupPullRequest {
  number: number;
  url: string;
  branch: string;
}

export interface PublisherSetupStatus {
  repositoryFullName: string;
  environment: string;
  targetMapped: boolean;
  environmentExists: boolean;
  protectionEnabled: boolean;
  administratorsCanBypass: boolean | null;
  firstReview: {
    gateId: string;
    scanId: string | null;
    status: string;
    scanStatus: string | null;
    requestedAt: string;
    completedAt: string | null;
  } | null;
  checks: { label: string; status: "passed" | "pending" | "unknown"; detail: string }[];
}

export interface PublisherSetupJudgeAssessment {
  verdict: "pass" | "changes_requested";
  summary: string;
  issues: string[];
  model: string;
  digest: string;
}

export type PublisherSetupJobStage =
  | "queued"
  | "fetch_source"
  | "draft"
  | "validate"
  | "judge"
  | "create_pr"
  | "ready";
export type PublisherSetupJobStatus = "queued" | "running" | "ready" | "failed";

export interface PublisherSetupDraftJob {
  id: string;
  status: PublisherSetupJobStatus;
  stage: PublisherSetupJobStage;
  request: PublisherSetupDraftRequest;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  failure: { code: string; message: string } | null;
  judge: PublisherSetupJudgeAssessment | null;
  feedback?: string[];
  result:
    | (PublisherSetupDraft & {
        originalContent: string;
        pullRequest: PublisherSetupPullRequest;
      })
    | null;
}
