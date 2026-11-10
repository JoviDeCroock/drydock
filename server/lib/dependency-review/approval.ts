import {
  completeDependencyReview,
  readDependencyReviewResult,
  recordDependencyApprovals,
} from "../../db/dependency-reviews";
import { recordScanEvent } from "../../db/events";
import { recordProductEvent } from "../analytics";
import { emitOperationalEvent } from "../platform/observability";
import { publishResult, renderInput } from "./check-run";
import type { DependencyReviewJobInput, ReviewContext } from "./context";
import { fetchPullRequest, hasRepositoryWriteAccess } from "./github";
import { listsEveryHold } from "./render";
import type { DependencyReviewConclusion, ReviewedBump } from "./types";

export function isOpenHold(bump: ReviewedBump): boolean {
  return bump.verdict.status === "hold" && !bump.approved;
}

/**
 * An Approve click. GitHub vouches for who clicked (the webhook is signed),
 * not for whether they may approve, so repository write access is checked
 * here before anything is recorded. Approving a commit that is no longer the
 * PR's head would approve bumps nobody was shown, so that is refused too.
 */
export async function applyApproval(
  context: ReviewContext,
  approver: NonNullable<DependencyReviewJobInput["approver"]>,
): Promise<void> {
  const { db, review, repo, token } = context;
  if (review.status !== "completed" || !review.checkRunId) return;
  // The click was on a run a Re-run has since replaced: its holds may differ.
  if (approver.checkRunId !== undefined && approver.checkRunId !== review.checkRunId) return;
  if (review.conclusion === "approved" && review.approvedByLogin === approver.login) {
    // A retry after the approval was stored but its check update failed.
    const { bumps, coverage } = await readDependencyReviewResult(db, review.id);
    await publishResult(context, review.checkRunId, bumps, "approved", coverage, approver.login);
    return;
  }
  if (review.conclusion !== "held") return;
  const log = (reason: string) =>
    emitOperationalEvent("warn", "dependency_review.approval_refused", {
      organizationId: review.organizationId,
      reviewId: review.id,
      reason,
    });
  if (!(await hasRepositoryWriteAccess(token, repo, approver.login))) {
    log("no_write_access");
    return;
  }
  const pr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!pr || pr.headSha !== review.headSha || pr.state !== "open") {
    log("head_moved");
    return;
  }
  const { bumps, coverage } = await readDependencyReviewResult(db, review.id);
  const held = bumps.filter(isOpenHold);
  // The run offered no Approve, so this click is forged or stale.
  if (!listsEveryHold(renderInput(context, bumps, "held", coverage, null))) {
    log("too_many_holds");
    return;
  }
  await recordDependencyApprovals(db, {
    organizationId: review.organizationId,
    repositoryId: review.repositoryId,
    reviewId: review.id,
    approvedByLogin: approver.login,
    approvedByGithubId: approver.githubId,
    bumps: held.map((b) => b.bump),
  });
  // Recorded with the approvals: they carry to later commits whatever happens
  // to this run, so the audit trail can't depend on it.
  await recordScanEvent(db, {
    organizationId: review.organizationId,
    type: "dependency_review.approved",
    metadata: {
      reviewId: review.id,
      repositoryFullName: review.repositoryFullName,
      pullNumber: review.pullNumber,
      approvedByLogin: approver.login,
      approvedCount: held.length,
    },
  });
  const approved = bumps.map((b) => (b.verdict.status === "hold" ? { ...b, approved: true } : b));
  // A writer accepted what was held, including a hold that came from an unread
  // lockfile with no per-bump hold behind it, so this reads as approved.
  const conclusion: DependencyReviewConclusion = "approved";
  const current = await completeDependencyReview(db, review.id, {
    conclusion,
    bumps: approved,
    bumpCount: Math.max(review.bumpCount, approved.length),
    heldCount: 0,
    coverage,
    approvedByLogin: approver.login,
    ifCompletedOnRun: review.checkRunId,
  });
  // A Re-run claimed the review since the click; it will find the approvals.
  if (!current) return;
  await publishResult(context, review.checkRunId, approved, conclusion, coverage, approver.login);
  recordProductEvent(context.env, {
    name: "dependency_review.approved",
    organizationId: review.organizationId,
    approvedCount: held.length,
  });
}
