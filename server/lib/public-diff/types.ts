import type { CodePatternSet, DiffEntry, Finding, PackageJsonDiff } from "../review";
import type { FileRecord, PackageJsonSummary } from "../review";

export interface PublicDiffAcquiredSide {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  /**
   * When the registry says this version was published, for the release-age
   * signal on the verdict projection. Omitted when the ecosystem has no
   * publication timestamp for the side (pkg.pr.new previews, atpm records).
   */
  publishedAt?: string;
}

export interface PublicDiffProvenanceEntry {
  label: string;
  value: string;
  detail?: string;
}

interface PublicDiffAttestationBuild {
  repository: string;
  ref: string | null;
  commit: string | null;
  workflow: string | null;
  runUrl: string | null;
  runnerEnvironment: string | null;
  signedAt: string | null;
  logIndex: string | null;
  logBaseUrl: string;
}

export interface PublicDiffAttestation {
  status: "verified" | "mismatch" | "invalid" | "absent" | "not-evaluated";
  build?: PublicDiffAttestationBuild;
  reason?: string;
  declared?: {
    repository: string;
    workflow: string;
    allowPublish: boolean;
  };
  match?:
    | "match"
    | "repository-mismatch"
    | "workflow-mismatch"
    | "workflow-unverified"
    | "unknown-provider";
}

export interface PublicDiffAcquiredSources {
  from: PublicDiffAcquiredSide;
  to: PublicDiffAcquiredSide;
  buildFindings(fileDiff: DiffEntry[], manifestDiff: PackageJsonDiff): Finding[];
  notices?: string[];
  provenance?: PublicDiffProvenanceEntry[];
  attestation?: PublicDiffAttestation;
  displayName?: string;
  // Absolute expiry prevents downstream caches from restarting a mutable record's TTL.
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

interface PublicDiffVersion {
  version: string;
  distTags?: string[];
  publishedAt?: string;
}

export interface PublicDiffVersionListing {
  packageName: string;
  displayName?: string;
  cacheExpiresAt?: string;
  versions: PublicDiffVersion[];
  suggested: { from: string; to: string } | null;
}

export interface PublicDiffAdapter {
  readonly ecosystem: string;
  readonly registryUrl: string;
  /**
   * Language family the deterministic rules read this ecosystem's files as.
   * Declared on the adapter rather than per acquisition because the
   * published-pair scan capability reuses it before anything is acquired.
   */
  readonly codePatternSet?: CodePatternSet;

  // Bump these when deterministic output or cached payload shape changes.
  readonly rulesVersionSegment: string;
  readonly payloadVersion: string;
  readonly cacheTtlSeconds?: number;

  isValidPackageName(name: string): boolean;
  normalizePackageName(name: string): string;
  isValidVersion(version: string): boolean;
  cacheTag(packageName: string): string;

  // Mutable sources must still exist before a computed cache hit is served.
  validateCachedPair?(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    input: PublicDiffInput,
  ): Promise<void>;

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
