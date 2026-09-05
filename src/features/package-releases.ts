/**
 * Pure shaping for the package release view: channel grouping, the rows that
 * deserve a highlight, and the sentence that states which baseline a release
 * was diffed against. Kept free of rendering so the rules can be unit tested
 * and reused by any surface that lists releases per package.
 */
import { settledRegistryStatus, type SettledRegistryStatus } from "../lib/npm-stage-follow-up";

export interface PackageReleaseLike {
  id: string;
  source?: string | null;
  status?: string | null;
  tag: string | null;
  decision?: string | null;
  registryVersionStatus?: string | null;
  registryReleaseOutcome?: SettledRegistryStatus | null;
  registryStatusSupersededAt?: string | number | Date | null;
  baseline?: {
    version?: string | null;
    source?: string | null;
    tag?: string | null;
  } | null;
  previousVersion?: string | null;
}

export type ReleaseAttention = "published_without_review" | "published_despite_block";

/**
 * The two disagreements between Drydock's record and npm's outcome that a
 * maintainer reading per package must not miss. Superseded rows are history
 * for an obsolete stage and never flagged; a `blocked` outcome is npm refusing
 * the version, which is not a gap in review.
 */
export function releaseAttention(release: PackageReleaseLike): ReleaseAttention | null {
  if (release.registryStatusSupersededAt != null) return null;
  const outcome =
    release.registryReleaseOutcome ?? settledRegistryStatus(release.registryVersionStatus);
  if (outcome !== "published" && outcome !== "deleted") return null;
  if (!release.decision) return "published_without_review";
  if (release.decision === "no_publish") return "published_despite_block";
  return null;
}

export interface ReleaseChannel<T extends PackageReleaseLike> {
  /** Dist-tag, or null for reviews whose source records no channel. */
  tag: string | null;
  releases: T[];
}

/**
 * Group newest-first rows by dist-tag without reordering them. `latest` leads
 * because it is what `npm install` resolves; other channels follow in order
 * of their most recent release; rows with no recorded channel (workflow-gate
 * and published-pair reviews) close the list.
 */
export function groupReleasesByChannel<T extends PackageReleaseLike>(
  releases: readonly T[],
): Array<ReleaseChannel<T>> {
  const byTag = new Map<string | null, T[]>();
  for (const release of releases) {
    const key = release.tag?.trim() || null;
    const bucket = byTag.get(key);
    if (bucket) bucket.push(release);
    else byTag.set(key, [release]);
  }
  const channels = [...byTag.entries()].map(([tag, rows]) => ({ tag, releases: rows }));
  // Map preserves first-seen order, which for newest-first input is already
  // "most recent release first"; only `latest` and the untagged bucket move.
  return [
    ...channels.filter((channel) => channel.tag === "latest"),
    ...channels.filter((channel) => channel.tag !== "latest" && channel.tag !== null),
    ...channels.filter((channel) => channel.tag === null),
  ];
}

export function channelLabel(tag: string | null): string {
  return tag ?? "no dist-tag";
}

/**
 * What the release was compared against, and why, as the reviewer should read
 * it: "1.2.3 (next)" when the channel's own dist-tag chose the baseline,
 * "1.2.3 (previous version)" when semver did, and an explicit "no baseline"
 * when the diff was all-added. The persisted `previousVersion` is the version
 * actually downloaded and wins over the selector's choice whenever both exist.
 */
export function describeBaseline(release: PackageReleaseLike): string {
  const version = release.previousVersion ?? release.baseline?.version ?? null;
  if (!version) return release.status === "complete" ? "no baseline (all files added)" : "—";
  const source = release.baseline?.source;
  if (source === "dist-tag" && release.baseline?.tag) {
    return `${version} (${release.baseline.tag})`;
  }
  if (source === "semver-predecessor") return `${version} (previous version)`;
  if (source === "highest-published") return `${version} (highest published)`;
  return version;
}
