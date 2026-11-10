import type { AppDb } from "../../db/client";
import type { DependencyReviewRecord } from "../../db/dependency-reviews";
import type { RepositoryRef } from "./github";

export interface DependencyReviewJobInput {
  organizationId: string;
  reviewId?: string;
  // Re-run a completed review (the check's Re-run button, or a skip raced it).
  rerun?: boolean;
  // `checkRunId` is the run clicked; a Re-run since then made it history.
  approver?: { login: string; githubId: number; checkRunId?: number };
  // A PR outside the review scope, or a legacy queued skip.
  skip?: {
    installationRowId: string;
    repositoryId: number;
    repositoryFullName: string;
    headSha: string;
    // Absent counts as a fork: the branch-head check only ever withholds a pass.
    fromFork?: boolean;
    // Absent means no write access is assumed. Both must be writers: the
    // sender of a `synchronize` may have pushed someone else's branch tip.
    authorLogin?: string;
    senderLogin?: string;
  };
}

export interface ReviewContext {
  env: Cloudflare.Env;
  ctx: ExecutionContext;
  db: AppDb;
  review: DependencyReviewRecord;
  repo: RepositoryRef;
  token: string;
  appId: string;
  detailsUrl: string | null;
}
