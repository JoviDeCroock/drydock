import { and, desc, eq, inArray } from "drizzle-orm";
import { compareSemver } from "../lib/ecosystems/npm/registry";
import { scanEcosystem, scanPublicPackageName } from "../lib/public-feed";
import type { AppDb } from "./client";
import { findNewerPublishedRelease, type SharedScanRow } from "./scan-share";
import { publicationAlerts, publicationObservations, publicationWatches } from "./schema";

/**
 * What the publication monitor records when npm served something the
 * organization's reviews do not vouch for. `unknown` is deliberately absent:
 * it means the evidence could not be established, not that anything is wrong,
 * and a badge must not go grey on an unanswered question.
 */
const DISCREPANCY_STATUSES = [
  "published_without_approval",
  "published_despite_rejection",
  "artifact_mismatch",
] as const;

// Newest observations first; newer releases are observed later, so this is
// the window a newer discrepancy lives in. Bounded because it runs on every
// badge cache miss for a package that has a review to quote.
const DISCREPANCY_WINDOW = 50;

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.+)?$/;
const isPrerelease = (version: string) => /^\d+\.\d+\.\d+-/.test(version);

/**
 * The version the badge must report as `not reviewed` because the answering
 * organization's own publication monitor says npm served something its
 * reviews do not vouch for — or null when the monitor has nothing to say.
 *
 * Two cases, mirroring the two ways the pick can be wrong:
 *
 * - **The quoted version itself.** The monitor recorded a discrepancy for it
 *   (bytes other than the approved ones, publication without or despite a
 *   decision). A green "3.0.0 approved" beside that is vouching for bytes the
 *   review did not see. A `blocked` pick is left red: it already warns, and a
 *   discrepancy does not make it less true.
 * - **A newer version on the line.** npm published a release the organization
 *   never approved — typically one that never went through staging at all, so
 *   no scan exists for `findNewerPublishedRelease` to find. Observations carry
 *   no dist-tag, so a version joins the pick's line by shape: a stable pick is
 *   superseded by newer stable versions, a prerelease pick by newer
 *   prereleases.
 *
 * Only the pick's own organization's evidence counts, for the same reason the
 * staleness probe is organization-scoped: another account's watch must not be
 * a lever on someone else's README. The alert ledger is read alongside the
 * observations because it outlives the watch: stopping a watch must not turn a
 * recorded discrepancy back into a green badge. No watch and no alerts means
 * no evidence, and the badge falls back to what the scans say. npm only — the
 * monitor watches nothing else.
 */
async function findPublicationDiscrepancy(db: AppDb, pick: SharedScanRow): Promise<string | null> {
  if (!pick.organizationId) return null;
  if (scanEcosystem(pick.source, pick.summaryJson) !== "npm") return null;
  const packageName = scanPublicPackageName(pick);
  const pickVersion = pick.registryVersion ?? pick.stagedVersion;
  if (!packageName || !pickVersion) return null;

  const [observed, alerted] = await Promise.all([
    db
      .select({ version: publicationObservations.version })
      .from(publicationObservations)
      .innerJoin(publicationWatches, eq(publicationWatches.id, publicationObservations.watchId))
      .where(
        and(
          eq(publicationWatches.organizationId, pick.organizationId),
          eq(publicationWatches.packageName, packageName),
          eq(publicationObservations.organizationId, pick.organizationId),
          inArray(publicationObservations.status, [...DISCREPANCY_STATUSES]),
        ),
      )
      .orderBy(desc(publicationObservations.firstSeenAt))
      .limit(DISCREPANCY_WINDOW),
    db
      .select({ version: publicationAlerts.version })
      .from(publicationAlerts)
      .where(
        and(
          eq(publicationAlerts.organizationId, pick.organizationId),
          eq(publicationAlerts.packageName, packageName),
          inArray(publicationAlerts.status, [...DISCREPANCY_STATUSES]),
        ),
      )
      .orderBy(desc(publicationAlerts.createdAt))
      .limit(DISCREPANCY_WINDOW),
  ]);

  let newest: string | null = null;
  let pickDisqualified = false;
  for (const { version } of [...observed, ...alerted]) {
    if (version === pickVersion) {
      pickDisqualified = true;
      continue;
    }
    if (!SEMVER_RE.test(version) || isPrerelease(version) !== isPrerelease(pickVersion)) continue;
    if (compareSemver(version, pickVersion) <= 0) continue;
    if (!newest || compareSemver(version, newest) > 0) newest = version;
  }
  if (newest) return newest;
  return pickDisqualified && pick.decision !== "no_publish" ? pickVersion : null;
}

/**
 * The version the badge reports instead of its pick, or null when the pick
 * still speaks for the line: the newest of a newer release this organization
 * reviewed but did not put on the badge (`findNewerPublishedRelease`) and what
 * its publication monitor recorded (`findPublicationDiscrepancy`).
 */
export async function findBadgeSupersession(
  db: AppDb,
  pick: SharedScanRow,
): Promise<string | null> {
  const [newerRelease, discrepancy] = await Promise.all([
    findNewerPublishedRelease(db, pick),
    findPublicationDiscrepancy(db, pick),
  ]);
  if (!newerRelease || !discrepancy) return newerRelease ?? discrepancy;
  return compareSemver(newerRelease, discrepancy) >= 0 ? newerRelease : discrepancy;
}
