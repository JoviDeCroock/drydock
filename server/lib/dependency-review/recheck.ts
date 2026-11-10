import type { DependencyReviewRecord } from "../../db/dependency-reviews";
import { isOpenHold } from "./approval";
import type { DependencyReviewJobInput } from "./context";
import type { DependencyReviewConclusion, ReviewedBump } from "./types";

// Cloudflare Queues cap a message's delay at 12 hours; a later recheck hops.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;
// Lands the last hop just past `passesAt`, so the age has surely passed.
const RECHECK_SLACK_SECONDS = 60;

/**
 * When a held review should be looked at again on its own: only when every
 * open hold is an age hold with a known `passesAt` (nothing a person has to
 * read), at the earliest of them. A review held for anything else, or held on
 * coverage alone, waits for an approval, a push, or Re-run.
 */
export function ageRecheckAt(
  reviewed: readonly ReviewedBump[],
  conclusion: DependencyReviewConclusion,
  heldOnCoverage: boolean,
): string | null {
  if (conclusion !== "held" || heldOnCoverage) return null;
  let earliest: string | null = null;
  for (const bump of reviewed.filter(isOpenHold)) {
    const { verdict } = bump;
    if (verdict.status !== "hold" || !verdict.passesAt) return null;
    if (verdict.reasons.some((reason) => reason !== "too-new")) return null;
    if (earliest === null || Date.parse(verdict.passesAt) < Date.parse(earliest)) {
      earliest = verdict.passesAt;
    }
  }
  return earliest;
}

/**
 * Queue the recheck, or the next 12-hour hop toward it. Throws when the send
 * fails; a lost recheck only means the hold stays until someone presses
 * Re-run or pushes, never that anything passes.
 */
export async function sendAgeRecheck(
  env: Cloudflare.Env,
  review: Pick<DependencyReviewRecord, "id" | "organizationId">,
  recheck: NonNullable<DependencyReviewJobInput["recheck"]>,
  nowMs: number,
): Promise<void> {
  if (!env.SCAN_QUEUE) return;
  const waitSeconds = Math.ceil((Date.parse(recheck.at) - nowMs) / 1000) + RECHECK_SLACK_SECONDS;
  await env.SCAN_QUEUE.send(
    {
      kind: "dependency_review",
      organizationId: review.organizationId,
      reviewId: review.id,
      recheck,
    },
    { delaySeconds: Math.max(1, Math.min(MAX_QUEUE_DELAY_SECONDS, waitSeconds)) },
  );
}

/** Whether a recheck message arrived before its time and must hop again. */
export function recheckEarly(
  recheck: NonNullable<DependencyReviewJobInput["recheck"]>,
  nowMs: number,
): boolean {
  return nowMs < Date.parse(recheck.at);
}

/**
 * Whether a recheck message still applies: the review is the completed, held
 * result on the run the recheck was scheduled for. Anything else (approved,
 * re-run, superseded) owns the review now, and the recheck does nothing.
 */
export function recheckApplies(
  review: DependencyReviewRecord,
  recheck: NonNullable<DependencyReviewJobInput["recheck"]>,
): boolean {
  return (
    review.status === "completed" &&
    review.conclusion === "held" &&
    review.checkRunId === recheck.checkRunId
  );
}
