import { createDb, type AppDb } from "../../db/client";
import {
  claimDependencyReview,
  completeDependencyReview,
  DEPENDENCY_REVIEW_LEASE_MS,
  failDependencyReview,
  findApprovedChanges,
  getDependencyReview,
  getDependencyReviewSettings,
  isChangeApproved,
  releaseDependencyReview,
} from "../../db/dependency-reviews";
import type { DependencyReviewStatus } from "../../db/enums";
import { recordProductEvent } from "../analytics";
import { getInstallationAccessToken } from "../github-app/api";
import { readGithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import { parseRepositoryFullName } from "../github-app/validation";
import { dependencyReviewUrl } from "../notify/links";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { applyApproval, isOpenHold } from "./approval";
import { cancelSupersededReview, ensureCheckRun, publishResult } from "./check-run";
import { collectBumps } from "./collect";
import type { DependencyReviewJobInput, ReviewContext } from "./context";
import { DependencyReviewGithubError, fetchPullRequest, updateCheckRun } from "./github";
import { concludeDependencyReview } from "./policy";
import { MAX_STORED_BUMPS } from "./render";
import { reviewBumps } from "./review-bumps";
import { postSkippedCheck } from "./skip";
import type { ReviewedBump } from "./types";

export type { DependencyReviewJobInput } from "./context";

export class DependencyReviewLeaseError extends Error {
  readonly retryAfterSeconds: number;

  constructor(updatedAt: Date) {
    super("review is running; re-run later");
    this.name = "DependencyReviewLeaseError";
    this.retryAfterSeconds = Math.max(
      1,
      Math.ceil((updatedAt.getTime() + DEPENDENCY_REVIEW_LEASE_MS - Date.now()) / 1000) + 1,
    );
  }
}

/**
 * Review one dependency-update PR commit, or apply an Approve click to a
 * finished review. Retryable GitHub failures rethrow for the queue to retry;
 * anything else fails the review and, when a check run exists, fails the check
 * so the PR never sits on an in-progress run forever.
 */
export async function executeDependencyReviewJob(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: DependencyReviewJobInput,
  options: { finalAttempt: boolean },
  db: AppDb = createDb(env.DB),
): Promise<void> {
  if (input.skip) {
    await postSkippedCheck(env, db, input.organizationId, input.skip);
    return;
  }
  if (!input.reviewId) return;
  const review = await getDependencyReview(db, input.organizationId, input.reviewId);
  if (!review) return;
  const repo = parseRepositoryFullName(review.repositoryFullName);
  if (!repo) {
    await failDependencyReview(db, review.id, "invalid repository name");
    return;
  }
  const installationId = await getInstallationExternalId(
    db,
    review.installationRowId,
    review.organizationId,
  );
  if (!installationId) {
    await failDependencyReview(db, review.id, "installation missing");
    return;
  }
  const appConfig = readGithubAppConfig(env);
  const token = await getInstallationAccessToken(appConfig, installationId);
  const context: ReviewContext = {
    env,
    ctx,
    db,
    review,
    repo,
    token,
    appId: appConfig.appId,
    detailsUrl: dependencyReviewUrl(env, review.id, review.organizationId),
  };

  if (input.approver) {
    await applyApproval(context, input.approver);
    return;
  }
  if (!(await claimDependencyReview(db, review.id, { rerun: input.rerun }))) {
    const current = await getDependencyReview(db, review.organizationId, review.id);
    // A redelivery may be the only survivor of a terminated worker. Do not
    // acknowledge it while its claim is still leased; retry after it can be
    // reclaimed, rather than spending all queue attempts inside the lease.
    if (current?.status === "running") {
      throw new DependencyReviewLeaseError(current.updatedAt);
    }
    return;
  }
  try {
    // Another attempt may have moved the review to a newer run since it was read.
    context.review = (await getDependencyReview(db, review.organizationId, review.id)) ?? review;
    await runReview(context, review.status);
  } catch (err) {
    const retryable = err instanceof DependencyReviewGithubError ? err.retryable : true;
    if (retryable && !options.finalAttempt) {
      await releaseDependencyReview(db, review.id, context.review.checkRunId);
      throw err;
    }
    await failReview(context, err);
  }
}

async function runReview(
  context: ReviewContext,
  statusBeforeClaim: DependencyReviewStatus,
): Promise<void> {
  const { db, review, repo, token } = context;
  const startedAtMs = Date.now();
  const checkRunId = await ensureCheckRun(context, statusBeforeClaim);

  const pr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!pr || pr.headSha !== review.headSha || pr.state !== "open") {
    await cancelSupersededReview(context, checkRunId);
    return;
  }

  const settings = await getDependencyReviewSettings(db, review.organizationId);
  const collected = await collectBumps(context, pr.baseSha, pr.changedFiles);
  const approvedChanges = await findApprovedChanges(
    db,
    review.organizationId,
    review.repositoryId,
    collected.bumps,
  );
  const verdicts = await reviewBumps(context, collected.bumps, settings.policy, startedAtMs);
  const reviewed: ReviewedBump[] = collected.bumps.map((bump, index) => {
    const verdict = verdicts[index];
    return {
      bump,
      verdict,
      approved: verdict.status === "hold" && isChangeApproved(approvedChanges, bump),
    };
  });

  let conclusion = concludeDependencyReview(reviewed);
  // An unread lockfile, or a listing GitHub cut short, may hide bumps, so the
  // review can't call the PR clear on what it saw.
  const partial = collected.unreadLockfiles.length > 0 || !collected.listingComplete;
  if (partial && settings.policy.holdOnUnreviewed && conclusion !== "held") {
    conclusion = "held";
  }
  // Diffs can run for minutes. A bot may have rebased or closed its PR after
  // the first head check; never publish that work as the current review.
  const currentPr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!currentPr || currentPr.headSha !== review.headSha || currentPr.state !== "open") {
    await cancelSupersededReview(context, checkRunId);
    return;
  }
  // A later attempt owns the newest run; its result is the one to store.
  if (!(await publishResult(context, checkRunId, reviewed, conclusion, collected, null))) return;
  const completed = await completeDependencyReview(db, review.id, {
    conclusion,
    bumps: storedBumps(reviewed),
    bumpCount: reviewed.length,
    heldCount: reviewed.filter(isOpenHold).length,
    coverage: {
      unreadLockfiles: collected.unreadLockfiles,
      listingComplete: collected.listingComplete,
    },
    ifRunningOnRun: context.review.checkRunId ?? checkRunId,
  });
  if (!completed) return;
  recordProductEvent(context.env, {
    name: "dependency_review.completed",
    organizationId: review.organizationId,
    conclusion,
    bumpCount: reviewed.length,
    heldCount: reviewed.filter((b) => b.verdict.status === "hold" && !b.approved).length,
    durationMs: Date.now() - startedAtMs,
  });
}

// `MAX_STORED_BUMPS` bounds what is persisted per review, holds first. Approve
// is only offered when the check shows every hold (`listsEveryHold`), far below it.
function storedBumps(reviewed: readonly ReviewedBump[]): ReviewedBump[] {
  return [...reviewed.filter(isOpenHold), ...reviewed.filter((b) => !isOpenHold(b))].slice(
    0,
    MAX_STORED_BUMPS,
  );
}

async function failReview(context: ReviewContext, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.name : "error";
  emitOperationalEvent("error", "dependency_review.failed", {
    organizationId: context.review.organizationId,
    reviewId: context.review.id,
    error: describeOperationalError(err),
  });
  const failed = await failDependencyReview(
    context.db,
    context.review.id,
    reason,
    context.review.checkRunId,
  );
  if (!failed) return;
  if (!context.review.checkRunId) return;
  await updateCheckRun(
    context.token,
    context.repo,
    context.review.checkRunId,
    {
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Dependency review failed",
        summary: "Drydock could not finish this review. Use Re-run to try again.",
      },
    },
    context.detailsUrl,
  ).catch(() => undefined);
}
