import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { compareSemver } from "../lib/ecosystems/semver";
import {
  DEFAULT_BADGE_TAG,
  PUBLIC_NPM_REGISTRY_URLS,
  badgePickName,
  badgeReviewedDigest,
  badgeRowTag,
  postReleaseAnswersTag,
  scanEcosystem,
  type BadgeSupersession,
} from "../lib/public-feed";
import type { AppDb } from "./client";
import {
  badgePackage,
  isRegistryVerifiedPublisher,
  registryVerifiedPublisherSql,
  type BadgePackage,
} from "./package-badge";
import { findNewerPublishedRelease, SHARED_SCAN_COLUMNS, type SharedScanRow } from "./scan-share";
import { publicationAlerts, publicationObservations, publicationWatches, scans } from "./schema";

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
// cache miss for a package that has a review to quote (at most once per colo,
// tag and cache lifetime). Sized so that pushing a superseding release out of
// it takes hundreds of further publications, each one raising its own alert.
export const OBSERVATION_WINDOW = 500;

const SEMVER_RE = /^(\d+)\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/;

/**
 * Whether an observed version belongs to the release line the badge quotes,
 * inferred from the pick's tag and version shape. It always applies;
 * recorded dist-tags can only add to it (see `supersedesQuote`):
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

// Unapproved versions recorded holding the badge's tag. A tag has one holder
// per check, but each observation keeps the tags of its own latest check, so
// earlier holders can linger; newest first, bounded like the window above.
const TAGGED_WINDOW = 100;

/**
 * Whether an observed release, other than the quoted one, now stands where the
 * quote does.
 *
 * Two sources, and either is enough. Recorded dist-tags only ever *add* a
 * supersession: a version npm points the badge's tag at (`tagHolders`) stands
 * where the quote did, whatever its version's shape or order, because
 * installing that tag fetches it — so a prerelease that took `latest` (npm
 * moves `latest` on a plain publish) supersedes a stable quote. They never
 * take one away. The version-shape inference stays as a floor, because a
 * recorded tag is only a snapshot of the last check that could read the
 * packument: whoever can publish can also move a tag back, or keep the
 * monitor from refreshing it, and neither may turn a grey badge green again
 * while a newer unapproved release on the quoted line is still published.
 * The cost is conservative: an unapproved stable release under `next` greys
 * the `latest` badge.
 */
function supersedesQuote(
  version: string,
  tagHolders: ReadonlySet<string>,
  pickVersion: string,
  tag: string,
): boolean {
  if (tagHolders.has(version)) return true;
  return onQuotedLine(version, pickVersion, tag) && compareSemver(version, pickVersion) > 0;
}

// Newest decisions first; bounded because it runs on every badge cache miss.
// Post-release decisions are made by people, one per alerted release.
const POST_RELEASE_WINDOW = OBSERVATION_WINDOW;

/**
 * Post-release decisions that may speak on the public badge: a published-pair
 * review that resolved one of its organization's publication alerts, whose
 * guard recorded `applied` when it was decided — the organization was a
 * registry-verified publisher of the name, the review read the release from
 * public npm, and the reviewed tarball's digest equals the one the monitor
 * recorded for it.
 *
 * The parts that can change are enforced again here, so a row that outlived
 * its evidence never answers: the organization must still be a
 * registry-verified publisher (the same rule the off switch holds opt-outs
 * to), the review must still be a completed published-pair review of exactly
 * the alerted release from public npm, and its current decision must be the
 * one the resolution recorded. `organizationId` narrows to one organization's
 * decisions, for the monitor evidence; without it, every publisher's count.
 */
function listPostReleaseDecisions(db: AppDb, target: BadgePackage, organizationId: string | null) {
  const reviewedRegistry = sql`json_extract(${scans.summaryJson}, '$.stagedPublish.registryUrl')`;
  return db
    .select({
      ...SHARED_SCAN_COLUMNS,
      organizationId: publicationAlerts.organizationId,
      version: publicationAlerts.version,
      resolution: publicationAlerts.resolution,
      resolvedAt: publicationAlerts.resolvedAt,
      // Qualified by hand: see `listUnnotifiedPublicationAlerts`.
      distTags: sql<
        string | null
      >`(select o.dist_tags from publication_observations o join publication_watches w on w.id = o.watch_id where w.organization_id = publication_alerts.organization_id and w.package_name = publication_alerts.package_name and o.organization_id = publication_alerts.organization_id and o.version = publication_alerts.version)`,
    })
    .from(publicationAlerts)
    .innerJoin(
      scans,
      and(
        eq(scans.id, publicationAlerts.reviewScanId),
        eq(scans.organizationId, publicationAlerts.organizationId),
      ),
    )
    .where(
      and(
        eq(publicationAlerts.packageName, target.packageName),
        organizationId ? eq(publicationAlerts.organizationId, organizationId) : undefined,
        eq(publicationAlerts.resolutionBadge, "applied"),
        eq(scans.source, "published"),
        eq(scans.status, "complete"),
        // The registry-resolved pair the review was started for, by its
        // unredacted stage id — never the reviewed manifest's name and version,
        // nor the summary's redacted copy (see `resolvePostReleaseReview`).
        sql`${scans.stageId} = 'published:npm:' || ${publicationAlerts.packageName} || '@' || ${publicationAlerts.version}`,
        sql`json_extract(${scans.summaryJson}, '$.stagedPublish.mode') = 'published_pair'`,
        inArray(reviewedRegistry, [...PUBLIC_NPM_REGISTRY_URLS]),
        sql`${scans.decision} = case ${publicationAlerts.resolution} when 'approved_after_release' then 'publish' when 'declined_after_release' then 'no_publish' end`,
        registryVerifiedPublisherSql(sql`${publicationAlerts.organizationId}`, target),
      ),
    )
    .orderBy(desc(publicationAlerts.resolvedAt), desc(publicationAlerts.id))
    .limit(POST_RELEASE_WINDOW);
}

function parseDistTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The third way into the badge: a publisher's decision on a release after npm
 * published it, which answers exactly like a decision before publication —
 * `<version> approved`, or `<version> blocked` for a decline, since the
 * version is already public and the decline is the warning. Each row carries
 * the alert's own coordinates, which the guard bound to the reviewed bytes.
 * npm only: the monitor watches nothing else.
 */
export async function listPostReleaseBadgeCandidates(
  db: AppDb,
  target: BadgePackage,
  tag: string,
): Promise<SharedScanRow[]> {
  if (target.ecosystem !== "npm") return [];
  const rows = await listPostReleaseDecisions(db, target, null);
  return rows.flatMap(
    ({ version, resolution: _resolution, resolvedAt, distTags, ...row }): SharedScanRow[] =>
      postReleaseAnswersTag(version, parseDistTags(distTags), tag)
        ? [
            {
              ...row,
              registryVersion: version,
              stagedVersion: version,
              packageName: target.packageName,
              registryPackageName: target.packageName,
              registryUrl: PUBLIC_NPM_REGISTRY_URLS[0],
              // Answers by the guard, never through a share or a listing.
              publicShareToken: null,
              publicFeedListedAt: null,
              completedAt: resolvedAt,
              postRelease: { tag },
            },
          ]
        : [],
  );
}

/**
 * The version the badge must report as `not reviewed` (or `blocked`) because
 * the answering organization's own publication monitor saw npm serve
 * something its reviews do not vouch for — or null when the monitor has
 * nothing to say.
 *
 * Two cases, mirroring the two ways the pick can be wrong:
 *
 * - **Another version where the quote stood** (`supersedesQuote`: npm points
 *   the badge's tag at it, or it is a newer version on the inferred line),
 *   observed with anything but an
 *   approved match — a discrepancy, or `unknown` evidence. The observation
 *   alone proves npm published it, and nothing proves this organization
 *   approved it, so the badge must not keep vouching for the quoted version
 *   beside an install command that fetches another one. This is how a
 *   release published straight to npm, which has no scan for
 *   `findNewerPublishedRelease` to find, still takes the badge off. An
 *   approved match is left to the scan-based path, which knows whether that
 *   release answers the badge itself.
 * - **The quoted version itself**, with a discrepancy (bytes other than the
 *   approved ones, publication without or despite a decision), or with
 *   published bytes whose digest differs from the digest the pick verified —
 *   whatever status the monitor gave the observation. The monitor can settle
 *   on `unknown` before it compares bytes (a decision recorded after npm's
 *   publication time, for one), and a green "3.0.0 approved" must not survive
 *   over bytes nobody compared. `unknown` with matching or absent digests
 *   leaves an approved quote alone, and a `blocked` pick stays red: it already
 *   warns.
 *
 * Either case is answered by the organization's own guarded decision after
 * release (`listPostReleaseDecisions`), made on the published bytes
 * themselves: an approval clears that version — it no longer supersedes the
 * quote, and the quote's own discrepancy or byte mismatch no longer greys it —
 * and a decline turns `not reviewed` into `blocked`. The observation's own
 * status is never rewritten; the decision is read beside it.
 *
 * Only the pick's own organization's evidence counts, for the same reason the
 * staleness probe is organization-scoped: another account's watch must not be
 * a lever on someone else's README. The alert ledger is read alongside the
 * observations because it outlives the watch: stopping a watch must not turn a
 * recorded discrepancy back into a green badge. No watch and no alerts means
 * no evidence, and the badge falls back to what the scans say. npm only — the
 * monitor watches nothing else.
 */
async function findPublicationDiscrepancy(
  db: AppDb,
  pick: SharedScanRow,
): Promise<BadgeSupersession | null> {
  if (!pick.organizationId) return null;
  if (scanEcosystem(pick.source, pick.summaryJson) !== "npm") return null;
  const packageName = badgePickName(pick);
  const pickVersion = pick.registryVersion ?? pick.stagedVersion;
  if (!packageName || !pickVersion) return null;
  const tag = badgeRowTag(pick) ?? DEFAULT_BADGE_TAG;

  const reviewedDigest = badgeReviewedDigest(pick);
  const [observed, alerted, quoted, tagged, decided] = await Promise.all([
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
    // The quoted version's own observation, whatever its status, for its bytes.
    db
      .select({ sha1: publicationObservations.sha1 })
      .from(publicationObservations)
      .innerJoin(publicationWatches, eq(publicationWatches.id, publicationObservations.watchId))
      .where(
        and(
          eq(publicationWatches.organizationId, pick.organizationId),
          eq(publicationWatches.packageName, packageName),
          eq(publicationObservations.organizationId, pick.organizationId),
          eq(publicationObservations.version, pickVersion),
        ),
      )
      .limit(1),
    // Unapproved observed versions npm points the badge's tag at, however long
    // ago they were first seen: each one supersedes the quote.
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
          sql`exists (select 1 from json_each(${publicationObservations.distTags}) where json_each.value = ${tag})`,
        ),
      )
      .orderBy(desc(publicationObservations.firstSeenAt))
      .limit(TAGGED_WINDOW),
    // This organization's guarded decisions after release. The observations
    // keep their historical verdicts; these say what the organization decided
    // about the published bytes since.
    listPostReleaseDecisions(db, badgePackage("npm", packageName), pick.organizationId),
  ]);

  const discrepancies: ReadonlySet<string> = new Set(DISCREPANCY_STATUSES);
  const tagHolders: ReadonlySet<string> = new Set(tagged.map((row) => row.version));
  const decisions = new Map<string, "approved" | "declined">();
  // Newest decision first, so the first one seen for a version is current.
  for (const row of decided) {
    if (decisions.has(row.version)) continue;
    decisions.set(
      row.version,
      row.resolution === "approved_after_release" ? "approved" : "declined",
    );
  }
  let newest: string | null = null;
  // Versions the monitor recorded a discrepancy for: published without this
  // organization's approval, despite its rejection, or with other bytes.
  // `unknown` is not among them — the evidence could not be established.
  const alertedVersions = new Set<string>();
  const publishedSha1 = quoted[0]?.sha1?.toLowerCase() ?? null;
  let pickDisqualified =
    reviewedDigest !== null && publishedSha1 !== null && publishedSha1 !== reviewedDigest;
  // A holder is evidence however long ago it was first seen, so it is read
  // whether or not it falls inside the observation window.
  for (const { version, status } of [...observed, ...alerted, ...tagged]) {
    if (discrepancies.has(status)) alertedVersions.add(version);
    if (version === pickVersion) {
      if (discrepancies.has(status)) pickDisqualified = true;
      continue;
    }
    if (!supersedesQuote(version, tagHolders, pickVersion, tag)) continue;
    // Approved after release: the organization vouched for the published
    // bytes since, so the release no longer stands against the quote.
    if (decisions.get(version) === "approved") continue;
    if (!newest || compareSemver(version, newest) > 0) newest = version;
  }
  const answer = (version: string, blocked: boolean): BadgeSupersession => ({
    version,
    blocked,
    unapproved: !blocked && alertedVersions.has(version),
  });
  let result: BadgeSupersession | null;
  if (newest) {
    result = answer(newest, decisions.get(newest) === "declined");
  } else {
    // The quoted version itself, decided after release: an approval vouches
    // for the published bytes, whatever the monitor recorded before it; a
    // decline is the badge's own warning.
    const pickDecision = decisions.get(pickVersion);
    if (pickDecision === "declined") {
      result = pick.decision === "no_publish" ? null : answer(pickVersion, true);
    } else if (pickDecision === "approved") {
      result = null;
    } else {
      result =
        pickDisqualified && pick.decision !== "no_publish" ? answer(pickVersion, false) : null;
    }
  }
  // The flag says the maintainer's own monitor saw npm publish this without
  // the maintainer's approval. Only a registry-verified publisher's record may
  // say that on a README: another organization that listed a review of the
  // package has no tie to its releases, and its alert would read as an
  // accusation against the real maintainer. Everyone else keeps `not reviewed`.
  if (
    result?.unapproved &&
    !(await isRegistryVerifiedPublisher(db, pick.organizationId, badgePackage("npm", packageName)))
  ) {
    result = { ...result, unapproved: false };
  }
  return result;
}

/**
 * The version the badge reports instead of its pick, or null when the pick
 * still speaks for the line: the newest of a newer release this organization
 * reviewed but did not put on the badge (`findNewerPublishedRelease`) and what
 * its publication monitor recorded (`findPublicationDiscrepancy`), `blocked`
 * when the organization declined that release after it was published.
 */
export async function findBadgeSupersession(
  db: AppDb,
  pick: SharedScanRow,
): Promise<BadgeSupersession | null> {
  const [newerRelease, discrepancy] = await Promise.all([
    findNewerPublishedRelease(db, pick),
    findPublicationDiscrepancy(db, pick),
  ]);
  if (!newerRelease) return discrepancy;
  const reviewed: BadgeSupersession = { version: newerRelease, blocked: false, unapproved: false };
  if (!discrepancy) return reviewed;
  const order = compareSemver(newerRelease, discrepancy.version);
  // The same release both ways: a guarded decline after release, or the
  // monitor's alert on it, is the more specific answer about the bytes
  // consumers install.
  if (order === 0) return discrepancy;
  return order > 0 ? reviewed : discrepancy;
}
