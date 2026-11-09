import { DEFAULT_DEPENDENCY_REVIEW_POLICY, type DependencyReviewPolicy } from "./types";

export type DependencyReviewPolicyProfile = "capability" | "prevention";

const PREVENTION_POLICY: DependencyReviewPolicy = {
  ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
  holdOnUninspectedFiles: true,
  holdOnUnreviewed: true,
  holdOnNewPackages: true,
};

/** Profiles expand into the existing policy fields; choosing one never migrates saved settings. */
export function dependencyReviewPolicyForProfile(
  profile: DependencyReviewPolicyProfile,
): DependencyReviewPolicy {
  return {
    ...(profile === "prevention" ? PREVENTION_POLICY : DEFAULT_DEPENDENCY_REVIEW_POLICY),
  };
}

export function dependencyReviewPolicyProfile(
  policy: DependencyReviewPolicy,
): DependencyReviewPolicyProfile | "custom" {
  const keys = Object.keys(DEFAULT_DEPENDENCY_REVIEW_POLICY) as Array<keyof DependencyReviewPolicy>;
  for (const profile of ["capability", "prevention"] as const) {
    const expected = dependencyReviewPolicyForProfile(profile);
    if (keys.every((key) => policy[key] === expected[key])) return profile;
  }
  return "custom";
}
