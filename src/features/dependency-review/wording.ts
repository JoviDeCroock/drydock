import type { DependencyReviewPolicy } from "../../../server/lib/dependency-review/types";
import type { RiskLevel } from "../../../server/lib/review/types";
import type { DependencyReview } from "../../models/dependency-review";

export {
  HOLD_REASON_TEXT,
  dependencyAddedText,
  holdReasonPhrases,
  REPINNED_TEXT,
  REPLACES_PRIVATE_TEXT,
  unreadContentText,
  unreviewedText,
} from "../../../server/lib/dependency-review/wording";
export { hasUnreadContent } from "../../../server/lib/dependency-review/evidence";

type PolicySwitch = {
  [K in keyof DependencyReviewPolicy]: DependencyReviewPolicy[K] extends boolean ? K : never;
}[keyof DependencyReviewPolicy];

/** One settings checkbox per policy switch, phrased to finish "Hold an update that…". */
export const POLICY_SWITCHES: ReadonlyArray<{ key: PolicySwitch; label: string; hint?: string }> = [
  { key: "holdOnInstallScripts", label: "adds or changes an install script" },
  { key: "holdOnNativeBinaries", label: "adds a native binary" },
  {
    key: "holdOnNewDependencies",
    label: "is a young package new to the lockfile, or adds a dependency Drydock can't follow",
    hint: "Young: first published under 90 days ago, an installed version under 7 days old, or an age Drydock can't establish; a Python package with no wheel holds at any age. An added dependency holds only where the lockfile doesn't show what it installs: requirements files, Yarn classic lockfiles, or a pull request with unread files.",
  },
  { key: "holdOnNewBinCommands", label: "adds a bin command" },
  {
    key: "holdOnUninspectedFiles",
    label: "changes files or artifacts Drydock could not read",
    hint: "Minified bundles, oversized or unknown binary files, native binaries the release changes (or adds, when that isn't held above), and PyPI wheels the diff did not read.",
  },
  {
    key: "holdOnUnreviewed",
    label: "has no Drydock verdict",
    hint: "From a listed private registry, a git or URL source, or a pin that doesn't match the public release; over the per-PR limit, missing from the registry, a failed diff, or an unread lockfile or registry config.",
  },
  {
    key: "holdOnNewPackages",
    label: "is a package the PR adds",
    hint: "There is no previous version to compare against.",
  },
];

export const RELEASE_RISK_THRESHOLDS: ReadonlyArray<{ value: RiskLevel | null; label: string }> = [
  { value: null, label: "Off" },
  { value: "medium", label: "Medium or higher" },
  { value: "high", label: "High or higher" },
  { value: "critical", label: "Critical only" },
];

export type ReviewState = "reviewing" | "failed" | "superseded" | "held" | "approved" | "clear";

export function reviewState(review: Pick<DependencyReview, "status" | "conclusion">): ReviewState {
  if (review.status === "failed") return "failed";
  // The commit stopped being the pull request's head before Drydock ran.
  if (review.status === "superseded") return "superseded";
  if (review.status !== "completed") return "reviewing";
  return review.conclusion ?? "clear";
}

/**
 * Dashboard URL of one dependency review. It names its organization in
 * `?org=` like a scan review, matching the check run's details link.
 */
export function dependencyReviewPath(reviewId: string, organizationId?: string | null): string {
  const qs = organizationId ? `?org=${encodeURIComponent(organizationId)}` : "";
  return `/dashboard/dependency-reviews/${encodeURIComponent(reviewId)}${qs}`;
}

export const DEPENDENCY_REVIEWS_PATH = "/dashboard/dependency-reviews";

/**
 * The pull request on GitHub. The origin is fixed and both path segments are
 * encoded, so a repository name can't steer the link anywhere else.
 */
export function pullRequestUrl(repositoryFullName: string, pullNumber: number): string | null {
  const [owner, repo, ...rest] = repositoryFullName.split("/");
  if (!owner || !repo || rest.length || !Number.isSafeInteger(pullNumber)) return null;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${pullNumber}`;
}

/**
 * The review's check run on GitHub, where Approve and Re-run live. Falls back
 * to the pull request's Checks tab while the run id is unknown. Same origin
 * and encoding guard as `pullRequestUrl`.
 */
export function checkRunUrl(
  repositoryFullName: string,
  pullNumber: number,
  checkRunId: number | null,
): string | null {
  const pull = pullRequestUrl(repositoryFullName, pullNumber);
  if (!pull) return null;
  if (checkRunId === null || !Number.isSafeInteger(checkRunId) || checkRunId <= 0) {
    return `${pull}/checks`;
  }
  const [owner, repo] = repositoryFullName.split("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/runs/${checkRunId}`;
}
