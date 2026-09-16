import { WorkflowArtifactError } from "../github-app/artifacts";
import type { PreparedReleaseCandidate } from "./types";

interface ReleaseCandidateIdentity {
  /** Grouping key (normalized name); artifacts sharing it are one package. */
  key: string;
  /** Display spelling recorded on the manifest and in error messages. */
  name: string;
  version: string;
}

export interface GroupReleaseCandidatesOptions<TEntry extends { path: string }, TManifest> {
  /**
   * Read the package identity from a parsed artifact. Throw
   * `WorkflowArtifactError("artifact_identity_missing", …)` when the artifact
   * carries no usable name/version; the message should name `entry.path`.
   */
  identity(entry: TEntry): ReleaseCandidateIdentity;
  /**
   * Whether one package version may span several artifacts (PyPI's wheel
   * matrix). When false, a second artifact claiming an already-seen identity
   * fails closed with `duplicateMessage`.
   */
  allowMultiplePerGroup: boolean;
  duplicateMessage?(identity: ReleaseCandidateIdentity): string;
  /**
   * Build and validate the ecosystem's release manifest for one group. Throw
   * `WorkflowArtifactError("artifact_identity_missing", …)` when the derived
   * identity is not a valid release.
   */
  buildManifest(identity: ReleaseCandidateIdentity, entries: TEntry[]): TManifest;
  candidate(manifest: TManifest, entries: TEntry[]): PreparedReleaseCandidate;
}

/**
 * Split a bundle's parsed artifacts into one release candidate per distinct
 * package.
 *
 * A monorepo publishes several packages from one release, so artifacts are
 * grouped by their identity key and each group becomes its own candidate → its
 * own scan against its own baseline. Every artifact must expose a
 * name/version, and all artifacts that share a key must agree on the version,
 * so a metadata-less or version-skewed file slipped into a package's set is
 * rejected rather than silently shipped. Distinct packages with distinct names
 * are kept apart — that is the expected monorepo shape, not a conflict.
 *
 * All callers consume sandbox-parsed artifacts (no bytes, no credentials); the
 * ecosystem only supplies how identity is read and how its manifest is shaped.
 *
 * `artifacts` is non-empty: the resolver throws `bundle_empty` for a bundle
 * with no reviewable artifacts, so the result always has at least one package.
 */
export function groupReleaseCandidates<TEntry extends { path: string }, TManifest>(
  artifacts: TEntry[],
  options: GroupReleaseCandidatesOptions<TEntry, TManifest>,
): PreparedReleaseCandidate[] {
  const groups = new Map<string, { identity: ReleaseCandidateIdentity; entries: TEntry[] }>();
  for (const entry of artifacts) {
    const identity = options.identity(entry);
    const group = groups.get(identity.key);
    if (!group) {
      groups.set(identity.key, { identity, entries: [entry] });
      continue;
    }
    if (identity.version !== group.identity.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.path} version ${identity.version} disagrees with ${group.identity.version} for ${group.identity.name}`,
      );
    }
    if (!options.allowMultiplePerGroup) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        options.duplicateMessage?.(group.identity) ??
          `package ${group.identity.name} has more than one artifact in this release`,
      );
    }
    group.entries.push(entry);
  }

  return [...groups.values()].map((group) =>
    options.candidate(options.buildManifest(group.identity, group.entries), group.entries),
  );
}

/**
 * Wrap an ecosystem manifest builder's validation failure in the gate's typed
 * error so the resolver stores a stable `failureReason` on the gate.
 */
export function buildManifestOrFail<TManifest>(
  build: () => TManifest,
  fallbackMessage: string,
): TManifest {
  try {
    return build();
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : fallbackMessage,
    );
  }
}
