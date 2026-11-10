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
  // registry's bytes; a failed proof makes it a remote source
  // (`unverified-pin`). `fromHashes` is null for a package the PR adds.
  mirror?: { fromHashes: readonly string[] | null; toHashes: readonly string[] };
  // Proven byte-identical to the public release through `mirror`; set by the
  // review stage, which then clears `privateSource` and `mirror`.
  viaMirror?: true;
  // On a public bump: the strong hashes the lockfile pins for the target
  // version, in the same forms as `mirror`. Whatever registry the installer is
  // configured to use, it only accepts bytes with these hashes, so the review
  // stage diffs the public release only after `verifyPublicPin` proves they are
  // the public registry's. A failed proof makes the bump a remote source.
  // Absent when the format records no comparable pin (Yarn Berry, unhashed
  // requirements). Empty when the format always writes one and this entry has
  // none usable: the proof fails without a lookup.
  pinnedHashes?: readonly string[];
  // The lockfile kept this version and changed what it pins for it. There is
  // no previous version to diff (`fromVersion` is null), and the pin is proven
  // like any other.
  repinned?: true;
  // The lockfile this bump comes from pins every package a frozen install
  // puts in the tree (npm, pnpm, Yarn Berry, uv; never a requirements file or
  // Yarn classic, see `LockfileSnapshot.partialTree`), so a
  // dependency a release adds either resolves to an entry already there or
  // arrives as a bump of its own. Set by collection,
  // kept through the proofs, and cleared when a merged copy of the change
  // comes from a lockfile that does not. Absent: not known, and any dependency
  // the release adds holds (`holdOnNewDependencies`).
  lockfilePinsTree?: true;
  // A package new to the lockfile from the public registry (or a mirror)
  // where the base resolved the same name from a private registry or another
  // non-public source: the base version is no predecessor of the public
  // release, so `fromVersion` is null. Dependency confusion's shape.
  replacesPrivate?: true;
  // PyPI: the lockfile records an sdist for the target version and no wheel
  // every platform installs, so some platform may build it from source, with
  // build requirements installed without being locked.
  buildsFromSource?: true;
  // With `privateSource` and `remoteSource`: a name in a declared private
  // scope that this change moves off a non-public source onto the public
  // registry or a mirror. Never sent to a public registry; it holds until
  // approved (`private-scope-public`).
  privateScopePublic?: true;
}

export type LockfileKind = "npm" | "pnpm" | "yarn" | "uv" | "requirements";

export interface DependencyReviewPolicy {
  // Hold when the target version adds or changes an install-time hook.
  holdOnInstallScripts: boolean;
  holdOnNativeBinaries: boolean;
  // Hold a package new to the lockfile while it is young (`youngPackage` in
  // `policy.ts`), and a release that adds a dependency where the lockfile
  // does not show what it installs (`lockfilePinsTree`, partial coverage).
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
  // https URL prefixes of the organization's own registries. A bump resolved
  // under one is unreviewed and exempt from the age fallback (it has no public
  // publish time and the organization vouches for its own registry). Any other
  // non-public host is a remote source: the PR chooses that URL, so it cannot
  // also choose the exemption.
  privateRegistries: string[];
  // npm scopes (`@corp`) whose names are never sent to the public registry,
  // for lockfiles that record no URL and routing configured outside the
  // repository.
  privateScopes: string[];
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
  privateRegistries: [],
  privateScopes: [],
};

export const MAX_UNREAD_MINIMUM_AGE_DAYS = 90;
export const MAX_PUBLIC_MIRRORS = 10;
export const MAX_PRIVATE_REGISTRIES = 10;
export const MAX_PRIVATE_SCOPES = 50;

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
  // A package new to the lockfile, first published or released too recently,
  // or of unknown age (`holdOnNewDependencies`).
  | "young-package"
  | "too-new";

export type UnreviewedReason =
  | "over-cap"
  | "not-found"
  | "unsupported"
  | "failed"
  | "timed-out"
  | "private-source"
  | "remote-source"
  // A public or mirror bump whose pinned hashes the review stage could not
  // match to the public registry's release. Like a remote source: nothing to
  // diff and no publish time to wait out.
  | "unverified-pin"
  // `privateScopePublic`: dependency confusion's signal. Always held.
  | "private-scope-public";

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
  // Dependencies the target version newly installs: declared in no section
  // before, or moved out of `peerDependencies` into an installing section.
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
      // With `too-new` and no `passesAt`: the bump was past the per-PR review
      // limit, so nobody looked its publish time up.
      pastReviewLimit?: true;
      // With `young-package`: why the new package counts as young.
      young?: YoungPackage;
      // With `dependency-added`: why Drydock can't see what the dependency
      // installs. Absent on verdicts decided before the field existed.
      dependencyUnseen?: "lockfile-unpinned" | "coverage-incomplete";
    }
  | { status: "unreviewed"; unreviewed: UnreviewedReason }
  | { status: "new-package" };

/**
 * Why a package new to the lockfile counts as young: first published, or its
 * installed version published, too recently (`at` is that time), an age the
 * review could not establish, no Drydock verdict at all (a remote or
 * unverified source), or a source build whose build requirements no lockfile
 * pins.
 */
export type YoungPackage =
  | { why: "first-published" | "version-published"; at: string }
  | { why: "age-unknown" | "no-verdict" | "built-from-source" };

/**
 * What the review stage learned about one bump, before any policy reads it.
 * `publishedAt` is the target version's publish time on the public registry:
 * an ISO time, null when the lookup found none, absent when nobody looked.
 * Both null and absent read as unknown. `pastReviewLimit`: the bump was past
 * the per-PR review limit, so the stage did no work on it.
 */
export type BumpOutcome =
  | {
      kind: "diffed";
      evidence: BumpEvidence;
      publishedAt?: string | null;
      // The bump's `lockfilePinsTree`, as a stated fact. Absent (a caller that
      // did not say) reads as false: any added dependency holds.
      lockfilePinsTree?: boolean;
      // Part of the review went unread (a lockfile, registry config, or the
      // file listing), so a new package could hide there.
      coverageIncomplete?: true;
    }
  | {
      kind: "unreviewed";
      reason: UnreviewedReason;
      publishedAt?: string | null;
      pastReviewLimit?: true;
      // A package new to its lockfile (no previous version, not a re-pin).
      newPackage?: true;
    }
  | {
      kind: "new-package";
      publishedAt?: string | null;
      // The package's earliest public release time, same null/absent reading.
      firstPublishedAt?: string | null;
      pastReviewLimit?: true;
      // A re-pin of a version the lockfile already had, not a new package.
      repinned?: true;
      // The bump's `buildsFromSource`.
      buildsFromSource?: true;
    };

export interface ReviewedBump {
  bump: DependencyBump;
  verdict: BumpVerdict;
  approved: boolean;
}

export type DependencyReviewConclusion = "clear" | "held" | "approved";
