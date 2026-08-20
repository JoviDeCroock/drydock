import type { CodePatternSet, DiffEntry, Finding, PackageJsonDiff } from "../review";
import type { FileRecord, PackageJsonSummary } from "../review";

/** One raw (unredacted) side of a public diff. */
export interface PublicDiffAcquiredSide {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}

/**
 * One step in how the reviewed bytes were located, rendered on the page as a
 * plain label/value list.
 *
 * Optional and empty for the ecosystems that do not need it: on npm or PyPI the
 * answer is "the registry", which is already the page's premise. It exists for
 * ecosystems where locating a release is itself a chain of independent
 * authorities a reader may want to check — atpm resolves a handle through DNS,
 * a DID through a directory, and the bytes from the publisher's own server.
 *
 * Values are rendered as text, never as links: every one of them is derived from
 * data the party under review controls.
 */
export interface PublicDiffProvenanceEntry {
  label: string;
  value: string;
  /** Which mechanism produced this step, e.g. `DNS TXT`. */
  detail?: string;
}

/**
 * One verified build, as a Sigstore bundle records it. Every field here came out
 * of a signature check, not out of the package's own metadata.
 */
export interface PublicDiffAttestationBuild {
  /** Source repository, e.g. `https://github.com/owner/repo`. */
  repository: string;
  /** Ref the build ran from, e.g. `refs/tags/v1.2.3`. */
  ref: string | null;
  commit: string | null;
  /** Workflow file, e.g. `.github/workflows/publish.yml`. */
  workflow: string | null;
  /** CI run the signing certificate was issued to. */
  runUrl: string | null;
  /** `github-hosted` or `self-hosted`, as the certificate recorded it. */
  runnerEnvironment: string | null;
  /** When the signature was made, per the transparency log entry. */
  signedAt: string | null;
  /** Transparency-log index. Present for lookup; inclusion is not verified. */
  logIndex: string | null;
}

/**
 * Whether a release proves where it was built, and whether that agrees with what
 * its publisher declared.
 *
 * Only atpm sets this today: its trusted-publishing records and Sigstore bundles
 * both live in the publisher's own repository, so both are readable without
 * credentials on the anonymous surface. npm's equivalents would need registry
 * calls this path deliberately does not make.
 */
export interface PublicDiffAttestation {
  status: "verified" | "mismatch" | "invalid" | "absent" | "not-evaluated";
  /** Set when a bundle verified intrinsically, including an artifact mismatch. */
  build?: PublicDiffAttestationBuild;
  /** Why the bundle did not verify or did not describe this artifact. */
  reason?: string;
  /** What the publisher declared as their trusted build pipeline, if anything. */
  declared?: {
    repository: string;
    workflow: string;
    /** CI may publish without a human approving the staged candidate. */
    allowPublish: boolean;
  };
  /** How the verified build compares with `declared`. */
  match?:
    | "match"
    | "repository-mismatch"
    | "workflow-mismatch"
    | "workflow-unverified"
    | "unknown-provider";
}

/**
 * What an ecosystem hands back after fetching both sides. The orchestrator in
 * `public-diff/index.ts` owns diffing, redaction, risk, and caching so every
 * ecosystem shares one assembly path; the adapter only knows how to get the
 * bytes and which deterministic rules to run over them.
 */
export interface PublicDiffAcquiredSources {
  from: PublicDiffAcquiredSide;
  to: PublicDiffAcquiredSide;
  buildFindings(fileDiff: DiffEntry[], manifestDiff: PackageJsonDiff): Finding[];
  /** Pattern family for baseline fingerprinting; defaults to the npm/JS set. */
  codePatternSet?: CodePatternSet;
  /** Coverage caveats to render as a banner (e.g. an omitted artifact kind). */
  notices?: string[];
  /** How the bytes were located, when that is not simply "the registry". */
  provenance?: PublicDiffProvenanceEntry[];
  /** Verified build provenance for the target version, when the ecosystem has it. */
  attestation?: PublicDiffAttestation;
  /** Friendlier spelling of the package name; see PublicDiffVersionListing. */
  displayName?: string;
  /**
   * Absolute freshness bound inherited from mutable resolution metadata.
   * Downstream caches must use only the remaining lifetime so moving a value
   * between layers cannot restart its TTL.
   */
  cacheExpiresAt?: string;
}

export interface PublicDiffInput {
  ecosystem: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: string;
  allowInsecureLocalhost?: boolean;
}

/** One selectable version in the `/versions` listing. */
interface PublicDiffVersion {
  version: string;
  distTags?: string[];
  publishedAt?: string;
}

export interface PublicDiffVersionListing {
  /**
   * Canonical package name, and the one `/diff` links and redirects to. An
   * ecosystem that has more than one spelling picks the canonical one here,
   * even if it is not the prettiest: this is what ends up in shared URLs.
   */
  packageName: string;
  /**
   * How to render `packageName` for a reader, when the canonical spelling is not
   * the one a human would recognize. atpm sets this: the canonical name pins the
   * publisher's DID so ordinary handle reassignment cannot redirect it, while
   * the display name is the `@handle/name` form the package is actually known
   * by. Only ever a name this resolution verified — never a claim taken at face
   * value. `did:web` is still domain-bound and is disclosed separately.
   */
  displayName?: string;
  /** Internal freshness bound for the HTTP response cache; not serialized. */
  cacheExpiresAt?: string;
  versions: PublicDiffVersion[];
  suggested: { from: string; to: string } | null;
}

/**
 * Anonymous published-version diffing for one ecosystem.
 *
 * This is the third capability an ecosystem can declare (alongside staged
 * publishes and workflow gates). It exists so the `/diff` orchestrator and its
 * routes stop branching on `ecosystem === "pypi"` for name validation, version
 * syntax, registry selection, cache identity, and acquisition — every one of
 * those was a place a third ecosystem would have had to be threaded through by
 * hand.
 *
 * Implementations must stay credential-free: they may only read public release
 * data, and nothing they return is persisted to D1.
 */
export interface PublicDiffAdapter {
  readonly ecosystem: string;
  /** Canonical public source or protocol identifier for this ecosystem. */
  readonly registryUrl: string;

  /**
   * Cache-identity segment for the deterministic rules this ecosystem runs.
   * Included in the computed-result cache key so a rules bump cannot serve a
   * stale assessment, and kept per-ecosystem so one ecosystem's bump does not
   * invalidate another's cached pairs.
   */
  readonly rulesVersionSegment: string;
  /** Payload-shape version; bump when the cached payload shape changes. */
  readonly payloadVersion: string;
  /**
   * Maximum computed-pair cache lifetime when release identity is mutable.
   * Omit for registry versions whose artifact mapping is immutable.
   */
  readonly cacheTtlSeconds?: number;

  isValidPackageName(name: string): boolean;
  /**
   * Canonicalize a package name at the request boundary so the cache key,
   * cache tag, and payload identity all agree (PyPI applies PEP 503).
   */
  normalizePackageName(name: string): string;
  isValidVersion(version: string): boolean;
  /** Cache-tag for package-level purges. */
  cacheTag(packageName: string): string;

  listVersions(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    packageName: string,
  ): Promise<PublicDiffVersionListing>;

  acquire(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    input: PublicDiffInput,
  ): Promise<PublicDiffAcquiredSources>;
}
