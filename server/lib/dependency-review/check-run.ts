import {
  getDependencyReview,
  setDependencyReviewCheckRun,
  supersedeDependencyReview,
} from "../../db/dependency-reviews";
import type { DependencyReviewStatus } from "../../db/enums";
import { bumpDiffUrl } from "./approvable";
import type { CollectedBumps } from "./collect";
import type { ReviewContext } from "./context";
import { createCheckRun, latestCheckRun, updateCheckRun, type CheckRunState } from "./github";
import {
  APPROVE_ACTION_IDENTIFIER,
  DEPENDENCY_REVIEW_CHECK_NAME,
  listsEveryHold,
  renderDependencyReviewCheck,
  SKIP_EXTERNAL_ID_PREFIX,
  type CheckRunOutput,
  type RenderDependencyReviewInput,
} from "./render";
import type { DependencyReviewConclusion, ReviewedBump } from "./types";

export async function cancelSupersededReview(
  context: ReviewContext,
  checkRunId: number,
): Promise<void> {
  // `cancelled`, not `neutral`: GitHub counts neutral as passing.
  await updateCheckRun(
    context.token,
    context.repo,
    checkRunId,
    {
      status: "completed",
      conclusion: "cancelled",
      output: {
        title: "Not reviewed",
        summary:
          "This commit is no longer the head of an open PR. Use Re-run if it becomes the head again.",
      },
    },
    context.detailsUrl,
  );
  // An expired attempt may still finish after a replacement has claimed the
  // same review. Its cancellation must not supersede the replacement's row.
  await supersedeDependencyReview(context.db, context.review.id, checkRunId, context.attempt);
}

function inProgressState(progress: string | null): CheckRunState {
  return {
    status: "in_progress",
    output: {
      title: "Reviewing dependency changes",
      summary: progress ?? "Drydock is diffing the package versions this PR changes.",
    },
  };
}

/**
 * The run this pass reports on. `progress` is the line a continuing review
 * last showed (null on a first pass); a continuation reuses its in-progress
 * run as it stands.
 */
export async function ensureCheckRun(
  context: ReviewContext,
  statusBeforeClaim: DependencyReviewStatus,
  progress: string | null,
): Promise<number> {
  const { review, repo, token } = context;
  const inProgress = inProgressState(progress);
  // A run this review already finished (completed, failed, or cancelled as
  // superseded) is left as history: a Re-run gets a new check run, which is
  // also what GitHub's Re-run button shows.
  if (review.checkRunId && statusBeforeClaim === "queued") {
    if (progress === null) {
      await updateCheckRun(token, repo, review.checkRunId, inProgress, context.detailsUrl);
    }
    return review.checkRunId;
  }
  const checkRunId = await createCheckRun(
    token,
    repo,
    {
      name: DEPENDENCY_REVIEW_CHECK_NAME,
      headSha: review.headSha,
      externalId: review.id,
      detailsUrl: context.detailsUrl,
    },
    inProgress,
  );
  await setDependencyReviewCheckRun(context.db, review.id, checkRunId, context.attempt);
  context.review = { ...review, checkRunId };
  // Reclaiming an expired lease gets a distinct run: the old worker may
  // still finish, and must recognize that this attempt owns the result now.
  if (review.checkRunId && statusBeforeClaim === "running") {
    await cancelReplacedRun(context, review.checkRunId);
  }
  return checkRunId;
}

export async function publishResult(
  context: ReviewContext,
  checkRunId: number,
  reviewed: readonly ReviewedBump[],
  conclusion: DependencyReviewConclusion,
  collected: Pick<CollectedBumps, "unreadLockfiles" | "listingComplete">,
  approvedBy: string | null,
): Promise<boolean> {
  const input = renderInput(context, reviewed, conclusion, collected, approvedBy);
  const approvable = listsEveryHold(input);
  const output: CheckRunOutput = renderDependencyReviewCheck({ ...input, approvable });
  if (!collected.listingComplete) {
    output.summary = `GitHub listed only part of this PR's files, so a lockfile may have gone unread.\n\n${output.summary}`;
  }
  const state: CheckRunState =
    conclusion === "held" && approvable
      ? {
          status: "completed",
          conclusion: "action_required",
          output,
          approveAction: {
            label: "Approve held updates",
            description: "Accept every held update in this PR",
            identifier: APPROVE_ACTION_IDENTIFIER,
          },
        }
      : {
          status: "completed",
          conclusion: conclusion === "held" ? "action_required" : "success",
          output,
        };
  // GitHub reads the newest run of a name on a commit. A skip that raced this
  // review may have landed after our run; the verdict then goes on a fresh run
  // so it is the one that counts. A newer run of this review that the review
  // records belongs to a later attempt (a Re-run), which publishes its own
  // result; one it doesn't record was orphaned (a create whose response was
  // lost) and is adopted.
  const { token, repo, review } = context;
  const newest = await latestCheckRun(
    token,
    repo,
    review.headSha,
    DEPENDENCY_REVIEW_CHECK_NAME,
    context.appId,
  );
  if (newest === null || newest.id === checkRunId) {
    await updateCheckRun(token, repo, checkRunId, state, context.detailsUrl);
    return true;
  }
  if (newest.externalId === review.id) {
    const stored = await getDependencyReview(context.db, review.organizationId, review.id);
    if (stored?.checkRunId === newest.id) return false;
    await updateCheckRun(token, repo, newest.id, state, context.detailsUrl);
    await setDependencyReviewCheckRun(context.db, review.id, newest.id, context.attempt);
    context.review = { ...review, checkRunId: newest.id };
    await cancelReplacedRun(context, checkRunId);
    return true;
  }
  if (!newest.externalId?.startsWith(SKIP_EXTERNAL_ID_PREFIX)) return false;
  const fresh = await createCheckRun(
    token,
    repo,
    {
      name: DEPENDENCY_REVIEW_CHECK_NAME,
      headSha: review.headSha,
      externalId: review.id,
      detailsUrl: context.detailsUrl,
    },
    state,
  );
  await setDependencyReviewCheckRun(context.db, review.id, fresh, context.attempt);
  context.review = { ...review, checkRunId: fresh };
  await cancelReplacedRun(context, checkRunId);
  return true;
}

/** Between passes: the run stays in progress, without an Approve, and says how far it got. */
export async function reportProgress(
  context: ReviewContext,
  checkRunId: number,
  progress: string,
): Promise<void> {
  await updateCheckRun(
    context.token,
    context.repo,
    checkRunId,
    inProgressState(progress),
    context.detailsUrl,
  );
}

async function cancelReplacedRun(context: ReviewContext, checkRunId: number): Promise<void> {
  await updateCheckRun(
    context.token,
    context.repo,
    checkRunId,
    {
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Moved to a newer run", summary: "This review's result is on a newer run." },
    },
    context.detailsUrl,
  );
}

export function renderInput(
  context: ReviewContext,
  bumps: readonly ReviewedBump[],
  conclusion: DependencyReviewConclusion,
  collected: Pick<CollectedBumps, "unreadLockfiles" | "listingComplete">,
  approvedBy: string | null,
): RenderDependencyReviewInput {
  return {
    bumps,
    conclusion,
    approvedBy,
    unreadLockfiles: collected.unreadLockfiles,
    listingComplete: collected.listingComplete,
    diffUrl: bumpDiffUrl(context.env),
  };
}
