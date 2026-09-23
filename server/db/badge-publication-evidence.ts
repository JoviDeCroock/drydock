import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { compareSemver } from "../lib/ecosystems/npm/registry";
import {
  DEFAULT_BADGE_TAG,
  scanDistTag,
  scanEcosystem,
  scanPublicPackageName,
} from "../lib/public-feed";
import type { AppDb } from "./client";
import { findNewerPublishedRelease, type SharedScanRow } from "./scan-share";
import { publicationAlerts, publicationObservations, publicationWatches } from "./schema";

/**
 * What the publication monitor records when npm served something the
 * organization's reviews do not vouch for. These disqualify the version the
 * badge quotes. `unknown` does not: it means the evidence could not be
 * established, and must not turn an approved quote grey.
 */
const DISCREPANCY_STATUSES = [
  "published_without_approval",
  "published_despite_rejection",
  "artifact_mismatch",
] as const;

// Newest observations first; newer releases are observed later, so this is
// the window a newer release lives in. Bounded because it runs on every badge
// cache miss for a package that has a review to quote.
const OBSERVATION_WINDOW = 50;

const SEMVER_RE = /^(\d+)\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/;

/**
 * Whether an observed version belongs to the release line the badge quotes.
 * Observations carry no dist-tag, so the line is inferred from the pick's tag
 * and version shape:
 *
 * - `latest` moves to stable releases, so every newer stable version is on it,
 *   and newer prereleases too when the pick itself is a prerelease.
 * - Any other tag with a stable pick is a maintenance line (`v1`), which
 *   stays within its major.
 * - Any other tag with a prerelease pick is that prerelease channel: a newer
 *   version with the same leading identifier (`canary`, `next`).
 */
function onQuotedLine(version: string, pickVersion: string, tag: string): boolean {
  const observed = SEMVER_RE.exec(version);
  const pick = SEMVER_RE.exec(pickVersion);
  if (!observed || !pick) return false;
  const [, observedMajor, observedPre] = observed;
  const [, pickMajor, pickPre] = pick;
  if (tag === DEFAULT_BADGE_TAG) return !observedPre || Boolean(pickPre);
  if (!pickPre) return !observedPre && observedMajor === pickMajor;
  if (!observedPre) return false;
  const channel = (pre: string) => pre.split(".")[0]?.replace(/\d+$/, "") ?? "";
  return channel(observedPre) === channel(pickPre);
}

/**
 * The version the badge must report as `not reviewed` because the answering
 * organization's own publication monitor saw npm serve something its reviews
 * do not vouch for — or null when the monitor has nothing to say.
 *
 * Two cases, mirroring the two ways the pick can be wrong:
 *
 * - **A newer version on the quoted line**, observed with anything but an
 *   approved match — a discrepancy, or `unknown` evidence. The observation
 *   alone proves npm published it, and nothing proves this organization
 *   approved it, so the badge must not keep vouching for the older version
 *   beside an install command that fetches the newer one. This is how a
 *   release published straight to npm, which has no scan for
 *   `findNewerPublishedRelease` to find, still takes the badge off. An
 *   approved match is left to the scan-based path, which knows whether that
 *   release answers the badge itself.
 * - **The quoted version itself**, with a discrepancy (bytes other than the
 *   approved ones, publication without or despite a decision). A green "3.0.0
 *   approved" beside that vouches for bytes the review did not see. `unknown`
 *   leaves it alone, and a `blocked` pick stays red: it already warns.
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
  const tag = scanDistTag(pick.summaryJson) ?? DEFAULT_BADGE_TAG;

  const [observed, alerted] = await Promise.all([
    db
      .select({ version: publicationObservations.version, status: publicationObservations.status })
      .from(publicationObservations)
      .innerJoin(publicationWatches, eq(publicationWatches.id, publicationObservations.watchId))
      .where(
        and(
          eq(publicationWatches.organizationId, pick.organizationId),
          eq(publicationWatches.packageName, packageName),
          eq(publicationObservations.organizationId, pick.organizationId),
          ne(publicationObservations.status, "approved_match"),
        ),
      )
      .orderBy(desc(publicationObservations.firstSeenAt))
      .limit(OBSERVATION_WINDOW),
    db
      .select({ version: publicationAlerts.version, status: publicationAlerts.status })
      .from(publicationAlerts)
      .where(
        and(
          eq(publicationAlerts.organizationId, pick.organizationId),
          eq(publicationAlerts.packageName, packageName),
          inArray(publicationAlerts.status, [...DISCREPANCY_STATUSES]),
        ),
      )
      .orderBy(desc(publicationAlerts.createdAt))
      .limit(OBSERVATION_WINDOW),
  ]);

  const discrepancies: ReadonlySet<string> = new Set(DISCREPANCY_STATUSES);
  let newest: string | null = null;
  let pickDisqualified = false;
  for (const { version, status } of [...observed, ...alerted]) {
    if (version === pickVersion) {
      if (discrepancies.has(status)) pickDisqualified = true;
      continue;
    }
    if (!onQuotedLine(version, pickVersion, tag)) continue;
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
