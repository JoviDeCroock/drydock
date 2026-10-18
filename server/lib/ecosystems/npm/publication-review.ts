/**
 * Resolving a publication alert with a review of the published release.
 *
 * An alert says npm published a version this organization never approved.
 * The organization can review the published bytes after the fact (a
 * published-pair review started from the alert) and approve or decline them.
 * The decision is recorded on the alert, but only an approval of the published
 * bytes themselves (the reviewed tarball's digests equal the ones the monitor
 * recorded) settles it; a decline, or approving bytes that differ or could not
 * be compared, leaves it open. Whether the decision may also
 * speak on the public README badge is a separate, stricter question, because
 * a published-pair review needs no credential and anyone can run one against
 * any public package: it may only when the organization is a registry-verified
 * publisher of the exact name, and the reviewed tarball is provably the one
 * the monitor saw npm publish (their digests agree).
 */
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client";
import {
  badgePackage,
  isRegistryVerifiedPublisher,
  listPackageBadgeTags,
} from "../../../db/package-badge";
import {
  getPublicationAlertReview,
  resolvePublicationAlertReview,
  type PublicationAlertResolution,
  type PublicationAlertResolutionBadge,
  type PublicationAlertReviewedBytes,
} from "../../../db/publication-alerts";
import { publicationObservations, publicationWatches, scans } from "../../../db/schema";
import {
  compareArchiveDigests,
  normalizeArchiveDigests,
  publishedPairArtifactDigest,
  type ArchiveDigests,
} from "../artifact-integrity";
import { DEFAULT_BADGE_TAG } from "../../public-feed";
import { publishedPairStageId } from "../published-pair";
import type { PostReleaseResolution } from "../types";
import { recordPublishedReleaseDigests } from "./publication-monitor";
import { npmPublicationRegistry } from "./publication-registry";
import { PUBLIC_NPM_REGISTRY } from "./publication-verdict";

/** Whether the review's summary names exactly the alerted release. */
// Whether the summary is a published-pair review's. Its name and version are
// not compared: the summary is stored through the secret redactor, so a
// version or package name shaped like a token (`1.0.1-AKIA…`) no longer equals
// the alert's. The unredacted stage id carries the coordinates instead.
function isPublishedPairSummary(summaryJson: unknown): boolean {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return false;
  const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
  if (!stagedPublish || typeof stagedPublish !== "object" || Array.isArray(stagedPublish)) {
    return false;
  }
  return (stagedPublish as { mode?: unknown }).mode === "published_pair";
}

/** The registry a published-pair review says it read the release from. */
function reviewedRegistryUrl(summaryJson: unknown): string | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
  if (!stagedPublish || typeof stagedPublish !== "object" || Array.isArray(stagedPublish)) {
    return null;
  }
  const registryUrl = (stagedPublish as { registryUrl?: unknown }).registryUrl;
  return typeof registryUrl === "string" ? registryUrl : null;
}

async function observedDigests(
  db: AppDb,
  target: { organizationId: string; packageName: string; version: string },
): Promise<{ digests: ArchiveDigests | null; distTags: string[] | null } | null> {
  const [observation] = await db
    .select({
      sha1: publicationObservations.sha1,
      sha256: publicationObservations.sha256,
      distTags: publicationObservations.distTags,
    })
    .from(publicationObservations)
    .innerJoin(publicationWatches, eq(publicationWatches.id, publicationObservations.watchId))
    .where(
      and(
        eq(publicationWatches.organizationId, target.organizationId),
        eq(publicationWatches.packageName, target.packageName),
        eq(publicationObservations.organizationId, target.organizationId),
        eq(publicationObservations.version, target.version),
      ),
    )
    .limit(1);
  if (!observation) return null;
  return {
    digests: normalizeArchiveDigests(observation),
    distTags: observation.distTags ?? null,
  };
}

/**
 * Whether the reviewed tarball is the one the monitor saw npm publish. Asked
 * of every decided review, whoever decides it: it is what lets an approval
 * settle the alert at all, not only what lets it reach the badge.
 */
async function compareReviewedBytes(
  db: AppDb,
  env: Cloudflare.Env,
  input: {
    organizationId: string;
    packageName: string;
    version: string;
    summaryJson: unknown;
  },
): Promise<{ bytes: PublicationAlertReviewedBytes; distTags: string[] | null }> {
  let observed = await observedDigests(db, input);
  // A release with no Drydock record was decided without its bytes; the Scan
  // action asked the monitor to hash them, and this is the last chance.
  if (observed && !observed.digests) {
    await recordPublishedReleaseDigests(db, env, input);
    observed = await observedDigests(db, input);
  }
  const comparison = compareArchiveDigests(
    publishedPairArtifactDigest(input.summaryJson),
    observed?.digests ?? null,
  );
  return {
    bytes: comparison === "incomparable" ? "unavailable" : comparison,
    distTags: observed?.distTags ?? null,
  };
}

/**
 * Whether the decision may speak on the public badge, or why not. Every
 * check fails closed, and the order only decides which reason is reported.
 */
async function badgeEffect(
  db: AppDb,
  env: Cloudflare.Env,
  input: {
    organizationId: string;
    packageName: string;
    summaryJson: unknown;
    bytes: PublicationAlertReviewedBytes;
  },
): Promise<PublicationAlertResolutionBadge> {
  // The badge speaks for the public npm registry only: both the monitor that
  // saw the release and the review that read it must have read it there.
  if (
    npmPublicationRegistry(env) !== PUBLIC_NPM_REGISTRY ||
    reviewedRegistryUrl(input.summaryJson) !== PUBLIC_NPM_REGISTRY
  ) {
    return "not_public_npm";
  }
  // The same credential-backed tie the off switch requires: a completed staged
  // review of a public-npm stage of this exact name that the organization's
  // own token could read. Watching or reviewing a public package is not one.
  if (
    !(await isRegistryVerifiedPublisher(
      db,
      input.organizationId,
      badgePackage("npm", input.packageName),
    ))
  ) {
    return "not_a_verified_publisher";
  }
  return input.bytes === "match"
    ? "applied"
    : input.bytes === "differ"
      ? "digests_differ"
      : "digests_unavailable";
}

/**
 * The review linked to one of the organization's alerts was decided: record
 * the resolution beside the alert. Null when the scan answers no alert, or is
 * not a completed, decided review of exactly the alerted release.
 */
export async function resolvePostReleaseReview(
  db: AppDb,
  env: Cloudflare.Env,
  input: { organizationId: string; scanId: string; actorUserId: string },
): Promise<PostReleaseResolution | null> {
  const alert = await getPublicationAlertReview(db, input.organizationId, input.scanId);
  if (!alert) return null;
  const [scan] = await db
    .select({
      source: scans.source,
      status: scans.status,
      decision: scans.decision,
      stageId: scans.stageId,
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  if (
    !scan ||
    scan.source !== "published" ||
    scan.status !== "complete" ||
    !scan.decision ||
    // The linked review was started for these coordinates; it may only ever
    // resolve the release it reviewed. Its stage id carries the
    // registry-resolved pair and is never redacted; `package_name` /
    // `staged_version` are rewritten from the reviewed tarball's own manifest,
    // which a hostile release can make say anything, and the summary's copy
    // is redacted, so neither may decide whether a decline lands.
    scan.stageId !==
      publishedPairStageId({
        ecosystem: "npm",
        packageName: alert.packageName,
        version: alert.version,
        baselineVersion: "",
      }) ||
    !isPublishedPairSummary(scan.summaryJson)
  ) {
    return null;
  }
  const resolution: PublicationAlertResolution =
    scan.decision === "publish" ? "approved_after_release" : "declined_after_release";
  const reviewed = await compareReviewedBytes(db, env, {
    organizationId: input.organizationId,
    packageName: alert.packageName,
    version: alert.version,
    summaryJson: scan.summaryJson,
  });
  const resolutionBadge = await badgeEffect(db, env, {
    organizationId: input.organizationId,
    packageName: alert.packageName,
    summaryJson: scan.summaryJson,
    bytes: reviewed.bytes,
  });
  const resolved = await resolvePublicationAlertReview(db, {
    alertId: alert.id,
    organizationId: input.organizationId,
    scanId: input.scanId,
    actorUserId: input.actorUserId,
    packageName: alert.packageName,
    version: alert.version,
    resolution,
    resolutionBadge,
    reviewedBytes: reviewed.bytes,
  });
  if (!resolved) return null;
  // Every line this could have changed, including one it changed back.
  const target = badgePackage("npm", alert.packageName);
  const badgeTags = new Set([
    DEFAULT_BADGE_TAG,
    ...(reviewed.distTags ?? []),
    ...(await listPackageBadgeTags(db, target)),
  ]);
  return {
    packageName: alert.packageName,
    version: alert.version,
    resolution,
    resolutionBadge,
    reviewedBytes: reviewed.bytes,
    badgeKey: target.packageKey,
    badgeTags: [...badgeTags],
  };
}
