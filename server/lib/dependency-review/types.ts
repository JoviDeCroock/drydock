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
  // With `privateSource`: a git ref, URL, or tarball rather than a registry.
  // It has no registry publish time, so the age fallback cannot vouch for it.
  remoteSource?: true;
  // With `privateSource`: the entry resolved from one of the organization's
  // `publicMirrors` and pins strong hashes (npm: one `sha512-…` integrity; uv:
  // every `sha256:…` the lock records). The review stage diffs it as a public
  // pair only after `mirror-identity.ts` proves both sides equal the public
  // registry's bytes. `fromHashes` is null for a package the PR adds.
  mirror?: { fromHashes: readonly string[] | null; toHashes: readonly string[] };
  // Proven byte-identical to the public release through `mirror`; set by the
  // review stage, which then clears `privateSource` and `mirror`.
  viaMirror?: true;
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
  // The fallback for what no diff vouched for: an unreviewed public bump, a
  // new package, a git or URL source, or a reviewed bump whose changed files
  // include content no rule read. Such a bump holds while its target version
  // is younger than this many days by the registry's own publish time, or
  // when that time is unknown. null turns the fallback off.
  unreadMinimumAgeDays: number | null;
  // https URL prefixes of registries that only proxy the public one. Entries
  // resolved under a prefix are compared with the public registry by hash;
  // naming a prefix sends those package names and versions to it.
  publicMirrors: string[];
}

export const DEFAULT_DEPENDENCY_REVIEW_POLICY: DependencyReviewPolicy = {
  holdOnInstallScripts: true,
  holdOnNativeBinaries: true,
  holdOnNewDependencies: true,
  holdOnNewBinCommands: false,
  holdAtReleaseRisk: "high",
  holdOnUninspectedFiles: false,
  holdOnUnreviewed: false,
  holdOnNewPackages: false,
  unreadMinimumAgeDays: 3,
  publicMirrors: [],
};

export const MAX_UNREAD_MINIMUM_AGE_DAYS = 90;
export const MAX_PUBLIC_MIRRORS = 10;

export type HoldReason =
  | "install-script-added"
  | "install-script-changed"
  | "native-binary-added"
  | "dependency-added"
  | "bin-command-added"
  | "release-risk"
  | "uninspected-files"
  | "unreviewed"
  | "new-package"
  | "too-new";

export type UnreviewedReason =
  | "over-cap"
  | "not-found"
  | "unsupported"
  | "failed"
  | "timed-out"
  | "private-source"
  | "remote-source";

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
  // Native binaries whose bytes changed. No rule reads them, so they count as
  // unread content, not as a new capability. Absent on evidence stored before
  // the field existed.
  nativeBinariesChanged?: number;
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
      // With `too-new`: when the age fallback stops holding (ISO time). Absent
      // when the registry gave no publish time, which holds until approved.
      passesAt?: string;
    }
  | { status: "unreviewed"; unreviewed: UnreviewedReason }
  | { status: "new-package" };

/**
 * What the review stage learned about one bump, before any policy reads it.
 * `publishedAt` is the target version's publish time on the public registry:
 * an ISO time, null when the lookup found none, absent when nobody looked.
 * Both null and absent read as unknown.
 */
export type BumpOutcome =
  | { kind: "diffed"; evidence: BumpEvidence; publishedAt?: string | null }
  | { kind: "unreviewed"; reason: UnreviewedReason; publishedAt?: string | null }
  | { kind: "new-package"; publishedAt?: string | null };

export interface ReviewedBump {
  bump: DependencyBump;
  verdict: BumpVerdict;
  approved: boolean;
}

export type DependencyReviewConclusion = "clear" | "held" | "approved";
