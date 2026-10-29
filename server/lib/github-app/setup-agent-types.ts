import type { ModelMessage } from "ai";
import type { PublisherSetupDraftRequest } from "./setup-types";

export interface SetupAgentFile {
  path: string;
  originalSha: string | null;
  originalContent: string | null;
  content: string;
}

/** Private checkpoint data. Never return this object from a Workflow step. */
export interface SetupAgentState {
  request: PublisherSetupDraftRequest;
  originalWorkflow: string;
  messages: ModelMessage[];
  files: Record<string, SetupAgentFile>;
  budgets: { reads: number; bytes: number; edits: number };
  readRevisions?: Record<string, string>;
  missingFiles?: string[];
  inspectedChanges?: Record<string, { digest: string; through: number }>;
  submitted?: { summary: string; digest: string };
  /** Blocker calls refused for naming no concrete missing fact; repeated refusals end the job. */
  vagueBlockers?: number;
  candidateDigest?: string;
  assessment?: {
    verdict: "pass" | "changes_requested";
    summary: string;
    issues: string[];
    digest: string;
  };
}

export interface SetupAgentValidation {
  valid: boolean;
  issues: string[];
}

export interface SetupAgentToolOptions {
  validateChanges?: (
    state: SetupAgentState,
  ) => SetupAgentValidation | Promise<SetupAgentValidation>;
}
