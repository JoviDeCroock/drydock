import { packageDiffPath } from "../../../src/lib/package-diff-path";
import type { DependencyReviewCoverage } from "../../db/dependency-reviews";
import { publicDiffUrl } from "../notify/links";
import { listsEveryHold } from "./render";
import type { DependencyBump, ReviewedBump } from "./types";

/** The public `/diff` link a check run gives one bump; private sources get none. */
export function bumpDiffUrl(env: Cloudflare.Env): (bump: DependencyBump) => string | null {
  return (bump) =>
    bump.fromVersion && !bump.privateSource
      ? publicDiffUrl(
          env,
          packageDiffPath(bump.ecosystem, bump.name, bump.fromVersion, bump.toVersion),
        )
      : null;
}

/**
 * Whether the check offers Approve for these stored bumps: the same
 * `listsEveryHold` test the approval handler applies, so the dashboard never
 * points at an Approve the check doesn't show.
 */
export function approvableOnCheck(
  env: Cloudflare.Env,
  bumps: readonly ReviewedBump[],
  coverage: DependencyReviewCoverage,
): boolean {
  return listsEveryHold({
    bumps,
    conclusion: "held",
    approvedBy: null,
    unreadLockfiles: coverage.unreadLockfiles,
    listingComplete: coverage.listingComplete,
    diffUrl: bumpDiffUrl(env),
  });
}
