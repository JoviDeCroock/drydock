import type { SupportedEcosystem } from "./config";

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
}

export interface PublisherSetupProposal extends PublisherSetupDraftRequest {
  repositoryId: number;
  defaultBranch: string;
  originalSha: string;
  content: string;
  summary: string;
  manualSteps: string[];
  expiresAt: number;
}

export interface PublisherSetupDraft {
  proposal: PublisherSetupProposal;
  proposalToken: string;
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
