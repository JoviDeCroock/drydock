import type { CodePatternSet, DiffEntry, Finding, PackageJsonDiff } from "../review";
import type { FileRecord, PackageJsonSummary } from "../review";

/** One raw (unredacted) side of a public diff. */
export interface PublicDiffAcquiredSide {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
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
export interface PublicDiffVersion {
  version: string;
  distTags?: string[];
  publishedAt?: string;
}

export interface PublicDiffVersionListing {
  /** Canonical package name as the registry spells it. */
  packageName: string;
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
 * Implementations must stay credential-free: they may only read public registry
 * data, and nothing they return is persisted to D1.
 */
export interface PublicDiffAdapter {
  readonly ecosystem: string;
  /** Canonical public registry base URL for this ecosystem. */
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
