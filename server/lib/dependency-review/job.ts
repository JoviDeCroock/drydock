import { createDb, type AppDb } from "../../db/client";
import {
  claimDependencyReviewAttempt,
  completeDependencyReview,
  DEPENDENCY_REVIEW_LEASE_MS,
  failDependencyReview,
  findApprovedChanges,
  getDependencyReview,
  getDependencyReviewSettings,
  isChangeApproved,
  readDependencyReviewProgress,
  releaseDependencyReview,
  saveDependencyReviewProgress,
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
import { cancelSupersededReview, ensureCheckRun, publishResult, reportProgress } from "./check-run";
import { collectBumps } from "./collect";
import type { DependencyReviewJobInput, ReviewContext } from "./context";
import { DependencyReviewGithubError, fetchPullRequest, updateCheckRun } from "./github";
import { concludeDependencyReview, decideBump } from "./policy";
import {
  DependencyReviewStalePassError,
  parseProgress,
  ProgressWriter,
  storableCollection,
  type DependencyReviewProgress,
} from "./progress";
import { ageRecheckAt, recheckApplies, recheckEarly, sendAgeRecheck } from "./recheck";
import { MAX_STORED_BUMPS } from "./render";
import { PASS_BUDGET_MS, runReviewStage } from "./review-bumps";
import { postSkippedCheck } from "./skip";
import type { ReviewedBump } from "./types";

// 500 stored bumps at 12 cold diffs a pass need 42; the rest is slack for
// passes cut short. A pass that survives at the bound publishes what is left
// as over the cap; a pass that starts past it (the ones before were killed)
// fails the review.
const MAX_REVIEW_PASSES = 50;
// Sent before the claim is released, so it must outlast the release; one
// arriving early waits out the lease like any duplicate.
const CONTINUATION_DELAY_SECONDS = 10;

export type { DependencyReviewJobInput } from "./context";

class DependencyReviewPassLimitError extends Error {
  constructor() {
    super("review exceeded its pass limit");
    this.name = "DependencyReviewPassLimitError";
  }
}

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
 * finished review. A review runs in passes, one per queue invocation, until
 * its bumps are settled (`runReview`). Retryable GitHub failures rethrow for
 * the queue to retry; anything else fails the review and, when a check run
 * exists, fails the check so the PR never sits on an in-progress run forever.
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
  let recheck = input.recheck;
  if (recheck) {
    if (recheckApplies(review, recheck)) {
      if (recheckEarly(recheck, Date.now())) {
        await sendAgeRecheck(env, review, recheck, Date.now());
        return;
      }
    } else if (review.status === "queued" || review.status === "running") {
      // A redelivery of a recheck whose pass was released for a retry or
      // killed mid-pass: the review now carries that recheck's run, so the
      // message resumes it like any redelivery instead of stranding it.
      recheck = undefined;
    } else {
      return;
    }
  }
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
  if (recheck) {
    // A merged or closed PR keeps its finished check as it is: the recheck
    // claims nothing and posts nothing unless the commit is still the head.
    const pr = await fetchPullRequest(token, repo, review.pullNumber);
    if (!pr || pr.headSha !== review.headSha || pr.state !== "open") return;
  }
  const attempt = await claimDependencyReviewAttempt(
    db,
    review.id,
    recheck
      ? { recheckOfRun: recheck.checkRunId }
      : { rerun: input.rerun, continuation: input.continuation },
  );
  if (attempt === null) {
    if (recheck) return;
    const current = await getDependencyReview(db, review.organizationId, review.id);
    // A redelivery may be the only survivor of a terminated worker. Do not
    // acknowledge it while its claim is still leased; retry after it can be
    // reclaimed, rather than spending all queue attempts inside the lease.
    if (current?.status === "running") {
      throw new DependencyReviewLeaseError(current.updatedAt);
    }
    return;
  }
  context.attempt = attempt;
  try {
    // Another attempt may have moved the review to a newer run since it was read.
    context.review = (await getDependencyReview(db, review.organizationId, review.id)) ?? review;
    await runReview(context, review.status, attempt);
  } catch (err) {
    // A newer claim owns the review; it posts the result.
    if (err instanceof DependencyReviewStalePassError) return;
    if (err instanceof DependencyReviewPassLimitError) {
      await failReview(
        context,
        err,
        "Drydock stopped this review after its passes kept ending before they finished. Use Re-run to start it over; a pull request with fewer dependency updates reviews in fewer passes.",
      );
      return;
    }
    const retryable = err instanceof DependencyReviewGithubError ? err.retryable : true;
    if (retryable && !options.finalAttempt) {
      await releaseDependencyReview(db, review.id, context.review.checkRunId, attempt);
      throw err;
    }
    await failReview(context, err);
  }
}

function progressLine(progress: Pick<DependencyReviewProgress, "settled" | "total">): string {
  return `Reviewed ${progress.settled} of ${progress.total} ${progress.total === 1 ? "update" : "updates"} so far. The review continues on its own; nothing can be approved until it finishes.`;
}

/**
 * One pass. Each pass claims the review, re-checks that the commit is still
 * the open PR's head before spending anything, collects the bumps again, and
 * spends one pass budget on the bumps not yet settled. Progress is stored on
 * the review row as it lands. While bumps remain, the pass queues the next
 * one and gives the claim back; the check stays in progress with no Approve.
 * The pass that finds nothing left applies the policy and the approvals once,
 * so one check never mixes two policies.
 */
async function runReview(
  context: ReviewContext,
  statusBeforeClaim: DependencyReviewStatus,
  attempt: number,
): Promise<void> {
  const { db, review, repo, token } = context;
  const passStartedAtMs = Date.now();
  const progress = parseProgress(
    await readDependencyReviewProgress(db, review.id),
    passStartedAtMs,
  );
  const checkRunId = await ensureCheckRun(
    context,
    statusBeforeClaim,
    progress.passes > 0 ? progressLine(progress) : null,
  );

  // Ownership: every GitHub write and queue send below follows a fenced
  // write (the claim, or a `writer.flush()`) closely. A fenced write renews
  // the lease, and nothing can claim a running review inside its lease, so a
  // pass that has lost its claim stops at that write instead of touching a
  // run a newer attempt replaced.
  const writer = new ProgressWriter(progress, (json) =>
    saveDependencyReviewProgress(db, review.id, attempt, json),
  );
  // A pass the platform kills never reaches its end, so the bound is checked
  // here, before the next one spends anything.
  if (progress.passes >= MAX_REVIEW_PASSES) throw new DependencyReviewPassLimitError();
  // Counted before any work, so a pass the platform kills still counts.
  progress.passes += 1;
  await writer.flush();

  const pr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!pr || pr.headSha !== review.headSha || pr.state !== "open") {
    await cancelSupersededReview(context, checkRunId);
    return;
  }

  const settings = await getDependencyReviewSettings(db, review.organizationId);
  // The head is fixed, so what the first pass collected still holds; a pass
  // reads the lockfiles again only when the mirror list changed or the
  // collection was too large to keep.
  const mirrors = settings.policy.publicMirrors;
  const kept = progress.collected;
  const collected =
    kept && kept.publicMirrors.join("\n") === mirrors.join("\n")
      ? kept
      : await collectBumps(context, pr.baseSha, pr.changedFiles, settings.policy);
  if (collected !== kept) {
    progress.collected = storableCollection({
      publicMirrors: mirrors,
      bumps: collected.bumps,
      unreadLockfiles: collected.unreadLockfiles,
      listingComplete: collected.listingComplete,
    });
  }
  const stage = await runReviewStage(
    context,
    collected.bumps,
    settings.policy,
    writer,
    passStartedAtMs + PASS_BUDGET_MS,
  );
  progress.total = collected.bumps.length;
  progress.settled = stage.settled;
  await writer.flush();

  if (!stage.complete && progress.passes < MAX_REVIEW_PASSES && context.env.SCAN_QUEUE) {
    await reportProgress(context, checkRunId, progressLine(progress));
    // Sent before the claim is given back: a crash between the two leaves a
    // running review whose lease expires and a message that reclaims it. The
    // other order could strand a queued review with no message to run it.
    await context.env.SCAN_QUEUE.send(
      {
        kind: "dependency_review",
        organizationId: review.organizationId,
        reviewId: review.id,
        continuation: true,
      },
      { delaySeconds: CONTINUATION_DELAY_SECONDS },
    );
    await releaseDependencyReview(db, review.id, checkRunId, attempt);
    return;
  }

  // Approvals are keyed on the change as the review stage resolved it: a
  // mirror-proven bump is looked up under its public identity.
  const approvedChanges = await findApprovedChanges(
    db,
    review.organizationId,
    review.repositoryId,
    stage.bumps,
  );
  const decidedAtMs = Date.now();
  const reviewed: ReviewedBump[] = stage.bumps.map((bump, index) => {
    const verdict = decideBump(stage.outcomes[index], settings.policy, decidedAtMs);
    return {
      bump,
      verdict,
      approved: verdict.status === "hold" && isChangeApproved(approvedChanges, bump),
    };
  });

  let conclusion = concludeDependencyReview(reviewed);
  // An unread lockfile or registry config, or a listing GitHub cut short, may
  // hide bumps nothing vouched for and that have no publish time to wait out,
  // so it holds whenever the age fallback is on (unknown age holds), as well
  // as under `holdOnUnreviewed`. Either way the PR is never called clear.
  const partial = collected.unreadLockfiles.length > 0 || !collected.listingComplete;
  const heldOnCoverage =
    partial && (settings.policy.holdOnUnreviewed || settings.policy.unreadMinimumAgeDays !== null);
  if (heldOnCoverage && conclusion !== "held") conclusion = "held";
  // Diffs can run for minutes. A bot may have rebased or closed its PR after
  // the first head check; never publish that work as the current review.
  const currentPr = await fetchPullRequest(token, repo, review.pullNumber);
  await writer.flush();
  if (!currentPr || currentPr.headSha !== review.headSha || currentPr.state !== "open") {
    await cancelSupersededReview(context, checkRunId);
    return;
  }
  // A later attempt owns the newest run; its result is the one to store.
  if (!(await publishResult(context, checkRunId, reviewed, conclusion, collected, null))) return;
  const completedOnRun = context.review.checkRunId ?? checkRunId;
  const completed = await completeDependencyReview(db, review.id, {
    conclusion,
    bumps: storedBumps(reviewed),
    bumpCount: reviewed.length,
    heldCount: reviewed.filter(isOpenHold).length,
    coverage: {
      unreadLockfiles: collected.unreadLockfiles,
      listingComplete: collected.listingComplete,
    },
    ifRunningOnRun: completedOnRun,
    ifAttempt: attempt,
  });
  if (!completed) return;
  const recheckAt = ageRecheckAt(reviewed, conclusion, heldOnCoverage);
  if (recheckAt) {
    await sendAgeRecheck(
      context.env,
      review,
      { checkRunId: completedOnRun, at: recheckAt },
      Date.now(),
    ).catch((err: unknown) =>
      emitOperationalEvent("warn", "dependency_review.recheck_not_scheduled", {
        organizationId: review.organizationId,
        reviewId: review.id,
        error: describeOperationalError(err),
      }),
    );
  }
  recordProductEvent(context.env, {
    name: "dependency_review.completed",
    organizationId: review.organizationId,
    conclusion,
    bumpCount: reviewed.length,
    heldCount: reviewed.filter((b) => b.verdict.status === "hold" && !b.approved).length,
    // Across every pass of this attempt, not just the final one.
    durationMs: Date.now() - progress.startedAt,
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

async function failReview(
  context: ReviewContext,
  err: unknown,
  summary = "Drydock could not finish this review. Use Re-run to try again.",
): Promise<void> {
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
    context.attempt,
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
        summary,
      },
    },
    context.detailsUrl,
  ).catch(() => undefined);
}
