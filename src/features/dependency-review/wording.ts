import type { DependencyReviewPolicy } from "../../../server/lib/dependency-review/types";
import type { RiskLevel } from "../../../server/lib/review/types";
import type { DependencyReview } from "../../models/dependency-review";

export { HOLD_REASON_TEXT, UNREVIEWED_TEXT } from "../../../server/lib/dependency-review/wording";

type PolicySwitch = Exclude<keyof DependencyReviewPolicy, "holdAtReleaseRisk">;

/** One settings checkbox per policy switch, phrased to finish "Hold an update that…". */
export const POLICY_SWITCHES: ReadonlyArray<{ key: PolicySwitch; label: string; hint?: string }> = [
  { key: "holdOnInstallScripts", label: "adds or changes an install script" },
  { key: "holdOnNativeBinaries", label: "adds a native binary" },
  { key: "holdOnNewDependencies", label: "adds a dependency" },
  { key: "holdOnNewBinCommands", label: "adds a bin command" },
  {
    key: "holdOnUninspectedFiles",
    label: "changes files or artifacts Drydock could not read",
    hint: "Minified bundles, oversized or unknown binary files, and PyPI wheels the diff did not read.",
  },
  {
    key: "holdOnUnreviewed",
    label: "has no Drydock verdict",
    hint: "From a private registry, over the per-PR limit, missing from the registry, a failed diff, or an unread lockfile. Off lets them pass.",
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

export type ReviewState = "reviewing" | "failed" | "held" | "approved" | "clear";

export function reviewState(review: Pick<DependencyReview, "status" | "conclusion">): ReviewState {
  if (review.status === "failed") return "failed";
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
