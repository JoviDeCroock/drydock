import type { AppDb } from "../../db/client";
import type { DependencyReviewRecord } from "../../db/dependency-reviews";
import type { RepositoryRef } from "./github";

export interface DependencyReviewJobInput {
  organizationId: string;
  reviewId?: string;
  // Re-run a completed review (the check's Re-run button, or a skip raced it).
  rerun?: boolean;
  // The next pass of a review still in progress: it only continues a queued
  // review (or one whose pass died), never starts one over.
  continuation?: true;
  // `checkRunId` is the run clicked; a Re-run since then made it history.
  approver?: { login: string; githubId: number; checkRunId?: number };
  // Re-run a review held only by age once its earliest hold passes (`at`),
  // if its held result is still the one on `checkRunId`.
  recheck?: { checkRunId: number; at: string };
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
  // The claim a review pass holds (`claimDependencyReviewAttempt`); its writes
  // name it. Absent outside a pass (an approval).
  attempt?: number;
}
