import { getPublicDiffAdapter } from "../ecosystems";
import { mapWithConcurrency } from "../platform/concurrency";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { loadPublicPackageDiff, publicDiffEgressAllowed, PublicDiffError } from "../public-diff";
import type { ReviewContext } from "./context";
import {
  evaluateBumpEvidence,
  extractBumpEvidence,
  newPackageVerdict,
  unreviewedVerdict,
} from "./policy";
import type {
  BumpVerdict,
  DependencyBump,
  DependencyReviewPolicy,
  UnreviewedReason,
} from "./types";

// Cold diffs run the sandbox, so both the count and the concurrency are
// bounded; cached pairs (the common case for popular bumps) cost a KV read.
const MAX_REVIEWED_BUMPS = 40;
const DIFF_CONCURRENCY = 4;
// Under the queue consumer's wall-clock limit with room to post the result.
const DIFF_BUDGET_MS = 8 * 60 * 1000;

export async function reviewBumps(
  context: ReviewContext,
  bumps: readonly DependencyBump[],
  policy: DependencyReviewPolicy,
  startedAtMs: number,
): Promise<BumpVerdict[]> {
  const deadline = startedAtMs + DIFF_BUDGET_MS;
  let diffed = 0;
  const plan = bumps.map((bump) => {
    if (bump.fromVersion === null || bump.privateSource) return { bump, review: false as const };
    diffed += 1;
    return { bump, review: diffed <= MAX_REVIEWED_BUMPS };
  });
  return mapWithConcurrency(plan, DIFF_CONCURRENCY, async ({ bump, review }) => {
    if (bump.privateSource) return unreviewedVerdict("private-source", policy);
    if (bump.fromVersion === null) return newPackageVerdict(policy);
    if (!review) return unreviewedVerdict("over-cap", policy);
    if (Date.now() > deadline) return unreviewedVerdict("timed-out", policy);
    const outcome = await diffBump(context, bump, bump.fromVersion);
    return typeof outcome === "string"
      ? unreviewedVerdict(outcome, policy)
      : evaluateBumpEvidence(outcome, policy);
  });
}

async function diffBump(
  context: ReviewContext,
  bump: DependencyBump,
  fromVersion: string,
): Promise<ReturnType<typeof extractBumpEvidence> | UnreviewedReason> {
  if (!publicDiffEgressAllowed(context.env)) return "unsupported";
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  // npm's public diff also accepts preview URLs as versions; a lockfile
  // version never is one.
  if (
    !adapter ||
    !adapter.isValidPackageName(bump.name) ||
    !adapter.isValidVersion(fromVersion) ||
    !adapter.isValidVersion(bump.toVersion) ||
    fromVersion.includes(":") ||
    bump.toVersion.includes(":")
  ) {
    return "unsupported";
  }
  try {
    const diff = await loadPublicPackageDiff(context.env, context.ctx, {
      ecosystem: adapter.ecosystem,
      packageName: adapter.normalizePackageName(bump.name),
      fromVersion,
      toVersion: bump.toVersion,
      registryUrl: adapter.registryUrl,
    });
    return extractBumpEvidence(diff);
  } catch (err) {
    if (err instanceof PublicDiffError) {
      if (err.status === 404) return "not-found";
      if (err.status === 400 || err.status === 413) return "unsupported";
    }
    emitOperationalEvent("warn", "dependency_review.diff_failed", {
      organizationId: context.review.organizationId,
      reviewId: context.review.id,
      ecosystem: bump.ecosystem,
      error: describeOperationalError(err),
    });
    return "failed";
  }
}
