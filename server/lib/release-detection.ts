import type { RegistryMetadata } from "./registry";

export const SCAN_RELEASE_STATUSES = ["released", "released_mismatch", "withdrawn"] as const;
export type ScanReleaseStatus = (typeof SCAN_RELEASE_STATUSES)[number];

// A stage that was approved or rejected simply vanishes from the registry's
// stage listing — npm exposes no status field and no webhook. Registry
// propagation can also lag the disappearance, so a missing stage whose version
// has not surfaced in the packument yet is only concluded withdrawn after this
// window (three 15-minute discovery sweeps).
export const STAGE_WITHDRAWN_CONFIRMATION_MS = 45 * 60 * 1000;

export type StageDisappearanceOutcome =
  | { status: "released"; shasumVerified: boolean; publishedAt: Date | null }
  | { status: "released_mismatch"; publishedShasum: string | null; publishedAt: Date | null }
  | { status: "withdrawn" }
  | { status: "pending" };

/**
 * Disambiguate why a staged publish disappeared from the stage listing. The
 * packument is the only signal: the staged version being published with the
 * staged shasum means the bytes that were reviewed are the bytes that shipped;
 * a shasum mismatch means something else was published under that version and
 * must be surfaced, never silently resolved.
 */
export function classifyDisappearedStage(input: {
  stagedVersion: string | null;
  stagedShasum: string | null;
  /** null when the package has no packument at all (e.g. a 404). */
  metadata: RegistryMetadata | null;
  stageMissingSince: Date | null;
  now: Date;
}): StageDisappearanceOutcome {
  const published = input.stagedVersion
    ? input.metadata?.versions?.[input.stagedVersion]
    : undefined;
  if (published) {
    const publishedShasum = published.dist?.shasum ?? null;
    const publishedAt = readPublishTime(input.metadata, input.stagedVersion);
    if (input.stagedShasum && publishedShasum && publishedShasum !== input.stagedShasum) {
      return { status: "released_mismatch", publishedShasum, publishedAt };
    }
    return {
      status: "released",
      shasumVerified: Boolean(input.stagedShasum && publishedShasum),
      publishedAt,
    };
  }
  if (
    input.stageMissingSince &&
    input.now.getTime() - input.stageMissingSince.getTime() >= STAGE_WITHDRAWN_CONFIRMATION_MS
  ) {
    return { status: "withdrawn" };
  }
  return { status: "pending" };
}

function readPublishTime(metadata: RegistryMetadata | null, version: string | null): Date | null {
  if (!metadata || !version) return null;
  const raw = metadata.time?.[version];
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
