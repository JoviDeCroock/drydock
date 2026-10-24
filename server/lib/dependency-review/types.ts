import type { FindingSeverity, RiskLevel } from "../review/types";

export type DependencyEcosystem = "npm" | "pypi";

/**
 * One package version change a dependency-update PR merges, read from the
 * lockfiles it changes. `fromVersion` is null for a package the PR adds.
 * Names and versions come from repository bytes and upstream packages, so
 * they are validated before they leave the lockfile layer and treated as
 * untrusted text everywhere after it.
 */
export interface DependencyBump {
  ecosystem: DependencyEcosystem;
  name: string;
  fromVersion: string | null;
  toVersion: string;
  // Declared by a manifest the lockfile covers, as opposed to pulled in by
  // another package.
  direct: boolean;
  lockfilePath: string;
  // Resolved from a registry other than the public one (or a name the
  // repository's config routes elsewhere). Never diffed: the bytes are not
  // public, and a same-named public package would be someone else's code.
  privateSource?: true;
}

export type LockfileKind = "npm" | "pnpm" | "yarn" | "uv" | "requirements";

export interface DependencyReviewPolicy {
  // Hold when the target version adds or changes an install-time hook.
  holdOnInstallScripts: boolean;
  holdOnNativeBinaries: boolean;
  holdOnNewDependencies: boolean;
  holdOnNewBinCommands: boolean;
  // Hold at or above this release risk; null turns the risk threshold off.
  holdAtReleaseRisk: RiskLevel | null;
  // Changed files Drydock could not read (minified bundles, oversized or
  // non-native binary bodies). Off means a clean verdict can rest on bytes no
  // rule inspected.
  holdOnUninspectedFiles: boolean;
  // Bumps without a verdict: over the per-review cap, not found, or failed.
  // GitHub treats a `neutral` check as passing, so off lets them merge.
  holdOnUnreviewed: boolean;
  // Packages the PR introduces have no previous version to diff against.
  holdOnNewPackages: boolean;
}

export const DEFAULT_DEPENDENCY_REVIEW_POLICY: DependencyReviewPolicy = {
  holdOnInstallScripts: true,
  holdOnNativeBinaries: true,
  holdOnNewDependencies: true,
  holdOnNewBinCommands: true,
  holdAtReleaseRisk: "high",
  holdOnUninspectedFiles: true,
  holdOnUnreviewed: true,
  holdOnNewPackages: false,
};

export type HoldReason =
  | "install-script-added"
  | "install-script-changed"
  | "native-binary-added"
  | "dependency-added"
  | "bin-command-added"
  | "release-risk"
  | "uninspected-files"
  | "unreviewed"
  | "new-package";

export type UnreviewedReason =
  | "over-cap"
  | "not-found"
  | "unsupported"
  | "failed"
  | "timed-out"
  | "private-source";

export interface BumpFinding {
  severity: FindingSeverity;
  ruleId: string | null;
  file: string;
  reason: string;
}

export interface BumpEvidence {
  releaseRisk: RiskLevel;
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
  installScriptsAdded: number;
  installScriptsChanged: number;
  nativeBinariesAdded: number;
  dependenciesAdded: number;
  binCommandsAdded: number;
  uninspectedFiles: number;
  // Coverage caveats the diff itself reported (an artifact kind or platform
  // wheels it did not read). Same policy switch as uninspected files.
  coverageNotices: number;
  // Release-delta findings, most severe first, bounded.
  findings: BumpFinding[];
  findingCount: number;
}

export type BumpVerdict =
  | { status: "clear"; evidence: BumpEvidence }
  | {
      status: "hold";
      reasons: HoldReason[];
      evidence: BumpEvidence | null;
      unreviewed?: UnreviewedReason;
    }
  | { status: "unreviewed"; unreviewed: UnreviewedReason }
  | { status: "new-package" };

export interface ReviewedBump {
  bump: DependencyBump;
  verdict: BumpVerdict;
  approved: boolean;
}

export type DependencyReviewConclusion = "clear" | "held" | "approved";
