import { and, desc, eq, isNotNull, isNull, ne, not, notInArray, or, sql } from "drizzle-orm";
import { base64UrlEncode } from "../lib/platform/crypto-utils";
import { compareSemver } from "../lib/ecosystems/npm/registry";
import {
  BADGE_INELIGIBLE_SOURCES,
  DEFAULT_BADGE_TAG,
  badgeLookupKey,
  publicPackageLookupKey,
  scanDistTag,
  type SharedScanRow,
} from "../lib/public-feed";

export type { SharedScanRow };
import type { AppDb } from "./client";
import { recordScanEvent } from "./events";
import { scans } from "./schema";

// 256 bits of entropy, base64url (43 chars). The token is the whole capability
// for the public report route, so it must be unguessable; lookups go through
// the unique index, not string comparison in application code.
function generatePublicShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface PublicShareState {
  publicShareToken: string;
  publicSharedAt: Date;
  publicFeedListedAt: Date | null;
  publicShareIncludesFiles: boolean;
  /**
   * Canonical badge key this scan occupies, so a caller can purge the colo-
   * cached badge after a listing change. Present whether or not the scan is
   * currently listed — an *un*listing is exactly when the cached body goes
   * stale.
   */
  publicPackageKey?: string | null;
  /**
   * The dist-tag this scan's badge lives under, so the purge addresses the
   * entry the badge write created rather than the default one. Null when the
   * scan was never staged under a tag — that scan only ever answered the
   * default badge.
   */
  publicBadgeTag?: string | null;
}

/**
 * Read the current share state without creating one. Callers acting on an
 * *existing* share — notably unlisting from the threat feed — must go through
 * this rather than `enablePublicShare`, or a withdrawal turns into a
 * publication when the link was revoked in the meantime.
 */
export async function readPublicShare(
  db: AppDb,
  input: { scanId: string; organizationId: string },
): Promise<PublicShareState | null> {
  const [row] = await db
    .select({
      publicShareToken: scans.publicShareToken,
      publicSharedAt: scans.publicSharedAt,
      publicFeedListedAt: scans.publicFeedListedAt,
      publicShareIncludesFiles: scans.publicShareIncludesFiles,
      publicPackageKey: scans.publicPackageKey,
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        isNull(scans.registryStatusSupersededAt),
      ),
    )
    .limit(1);
  if (!row?.publicShareToken || !row.publicSharedAt) return null;
  return {
    publicShareToken: row.publicShareToken,
    publicSharedAt: row.publicSharedAt,
    publicFeedListedAt: row.publicFeedListedAt,
    publicShareIncludesFiles: row.publicShareIncludesFiles,
    publicPackageKey: row.publicPackageKey,
    publicBadgeTag: scanDistTag(row.summaryJson),
  };
}

/**
 * Enable (or return the existing) public share link for an active completed scan.
 * Idempotent: re-sharing an already-shared scan returns the current token so
 * the UI never rotates a link that may already be distributed.
 */
export async function enablePublicShare(
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string },
): Promise<PublicShareState | null> {
  const readShareState = () =>
    db
      .select({
        status: scans.status,
        publicShareToken: scans.publicShareToken,
        publicSharedAt: scans.publicSharedAt,
        publicFeedListedAt: scans.publicFeedListedAt,
        publicShareIncludesFiles: scans.publicShareIncludesFiles,
        packageName: scans.packageName,
        stagedVersion: scans.stagedVersion,
      })
      .from(scans)
      .where(
        and(
          eq(scans.id, input.scanId),
          eq(scans.organizationId, input.organizationId),
          isNull(scans.registryStatusSupersededAt),
        ),
      )
      .limit(1);

  const [existing] = await readShareState();
  if (!existing) return null;
  if (existing.status !== "complete") return null;
  if (existing.publicShareToken && existing.publicSharedAt) {
    if (!existing.publicShareIncludesFiles) {
      const [upgraded] = await db
        .update(scans)
        .set({ publicShareIncludesFiles: true, updatedAt: new Date() })
        .where(
          and(
            eq(scans.id, input.scanId),
            eq(scans.organizationId, input.organizationId),
            eq(scans.status, "complete"),
            eq(scans.publicShareToken, existing.publicShareToken),
            isNull(scans.registryStatusSupersededAt),
          ),
        )
        .returning({ publicShareIncludesFiles: scans.publicShareIncludesFiles });
      if (!upgraded?.publicShareIncludesFiles) return null;
      await recordScanEvent(db, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        scanId: input.scanId,
        type: "scan.share_enabled",
        metadata: {
          packageName: existing.packageName,
          stagedVersion: existing.stagedVersion,
          includesFiles: true,
        },
      });
    }
    return {
      publicShareToken: existing.publicShareToken,
      publicSharedAt: existing.publicSharedAt,
      publicFeedListedAt: existing.publicFeedListedAt,
      publicShareIncludesFiles: true,
    };
  }

  const now = new Date();
  const token = generatePublicShareToken();
  const updated = await db
    .update(scans)
    .set({
      publicShareToken: token,
      publicSharedAt: now,
      publicSharedByUserId: input.actorUserId,
      publicShareIncludesFiles: true,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        // Guards the idempotency promise under concurrency: two racing enables
        // must never rotate a token one of them already returned.
        isNull(scans.publicShareToken),
      ),
    )
    .returning({ id: scans.id });
  if (updated.length === 0) {
    // Lost the race to a concurrent enable — return the winner's token.
    const [current] = await readShareState();
    if (current?.publicShareToken && current.publicSharedAt) {
      return {
        publicShareToken: current.publicShareToken,
        publicSharedAt: current.publicSharedAt,
        publicFeedListedAt: current.publicFeedListedAt,
        publicShareIncludesFiles: current.publicShareIncludesFiles,
      };
    }
    return null;
  }

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.share_enabled",
    metadata: { packageName: existing.packageName, stagedVersion: existing.stagedVersion },
  });
  return {
    publicShareToken: token,
    publicSharedAt: now,
    publicFeedListedAt: null,
    publicShareIncludesFiles: true,
  };
}

/**
 * Revoke the public share link. Returns false when the scan was not shared.
 * Also drops any threat-feed listing — an unreachable report must never stay
 * indexed in the public feed.
 */
export async function revokePublicShare(
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string },
): Promise<{ revoked: boolean; publicPackageKey: string | null; publicBadgeTag: string | null }> {
  const now = new Date();
  const updated = await db
    .update(scans)
    .set({
      publicShareToken: null,
      publicSharedAt: null,
      publicSharedByUserId: null,
      publicShareIncludesFiles: false,
      publicFeedListedAt: null,
      publicPackageKey: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        isNotNull(scans.publicShareToken),
      ),
    )
    .returning({
      id: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      // `public_package_key` is nulled by this same UPDATE, so the key that
      // just went stale is recomputed from the (untouched) identity columns.
      source: scans.source,
      registryPackageName: scans.registryPackageName,
      summaryJson: scans.summaryJson,
    });
  if (updated.length === 0) return { revoked: false, publicPackageKey: null, publicBadgeTag: null };

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.share_revoked",
    metadata: { packageName: updated[0].packageName, stagedVersion: updated[0].stagedVersion },
  });
  return {
    revoked: true,
    publicPackageKey: badgeLookupKey(updated[0]),
    publicBadgeTag: scanDistTag(updated[0].summaryJson),
  };
}

/**
 * Toggle the threat-feed listing for an already-shared scan. Listing requires
 * an active share link (the feed entry links to the public report); unlisting
 * keeps the link itself intact. Returns the new state, or null when the scan
 * is missing, not complete, superseded, or (for listing) not currently shared.
 */
export async function setThreatFeedListing(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    actorUserId: string;
    listed: boolean;
  },
): Promise<PublicShareState | null> {
  const now = new Date();
  const scoped = and(
    eq(scans.id, input.scanId),
    eq(scans.organizationId, input.organizationId),
    eq(scans.status, "complete"),
    isNull(scans.registryStatusSupersededAt),
    isNotNull(scans.publicShareToken),
  );
  const [candidate] = await db
    .select({
      source: scans.source,
      packageName: scans.packageName,
      registryPackageName: scans.registryPackageName,
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(scoped)
    .limit(1);
  if (!candidate) return null;
  // Null here means "listed in the feed but not badge-discoverable" — the scan
  // has no public name (a staged scan whose manifest disagrees with npm's name
  // for the stage, or no name at all), or is a gate scan whose ecosystem was
  // never established.
  const badgeKey = badgeLookupKey(candidate);
  const publicPackageKey = input.listed ? badgeKey : null;
  const updated = await db
    .update(scans)
    .set({
      publicFeedListedAt: input.listed ? now : null,
      publicPackageKey,
      updatedAt: now,
    })
    .where(scoped)
    .returning({
      publicShareToken: scans.publicShareToken,
      publicSharedAt: scans.publicSharedAt,
      publicFeedListedAt: scans.publicFeedListedAt,
      publicShareIncludesFiles: scans.publicShareIncludesFiles,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
    });
  const row = updated[0];
  if (!row?.publicShareToken || !row.publicSharedAt) return null;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: input.listed ? "scan.feed_listed" : "scan.feed_unlisted",
    metadata: { packageName: row.packageName, stagedVersion: row.stagedVersion },
  });
  return {
    // Always the key, listing or unlisting: an *un*listing is exactly when the
    // cached badge body goes stale, so the caller needs the entry to purge.
    publicPackageKey: badgeKey,
    publicBadgeTag: scanDistTag(candidate.summaryJson),
    publicShareToken: row.publicShareToken,
    publicSharedAt: row.publicSharedAt,
    publicFeedListedAt: row.publicFeedListedAt,
    publicShareIncludesFiles: row.publicShareIncludesFiles,
  };
}

export const THREAT_FEED_MAX_ENTRIES = 100;

const SHARED_SCAN_COLUMNS = {
  scanId: scans.id,
  // The registry's own version string for this release, as opposed to
  // `stagedVersion`, which the scan replaces with the inspected tarball's
  // manifest. Internal only, for ordering releases against each other.
  registryVersion: scans.registryVersion,
  // Internal only. The public feed and badge serializers build explicit
  // objects and a test pins that neither ever grows an organization field;
  // this is here so the badge's staleness probe can scope itself to the
  // organization whose review it is about, in the same read.
  organizationId: scans.organizationId,
  registryPackageName: scans.registryPackageName,
  source: scans.source,
  packageName: scans.packageName,
  stagedVersion: scans.stagedVersion,
  previousVersion: scans.previousVersion,
  risk: scans.risk,
  decision: scans.decision,
  findingCount: scans.findingCount,
  riskSummaryJson: scans.riskSummaryJson,
  summaryJson: scans.summaryJson,
  publicShareToken: scans.publicShareToken,
  publicFeedListedAt: scans.publicFeedListedAt,
  completedAt: scans.completedAt,
} as const;

export interface ThreatFeedCursor {
  listedAtMs: number;
  scanId: string;
}

/** `<listedAtMs>:<scanId>` — the same shape as the scan list cursor. */
export function parseThreatFeedCursor(raw: string | undefined): ThreatFeedCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const listedAtMs = Number(raw.slice(0, sep));
  const scanId = raw.slice(sep + 1);
  if (!Number.isFinite(listedAtMs) || !scanId) return null;
  return { listedAtMs, scanId };
}

export function encodeThreatFeedCursor(cursor: ThreatFeedCursor | null): string | null {
  return cursor ? `${cursor.listedAtMs}:${cursor.scanId}` : null;
}

/**
 * Feed-listed shared scans, newest listing first, keyset-paginated.
 *
 * The page is bounded, and without a cursor the bound is the whole story a
 * consumer can see: one organization listing a batch of its own scans pushes
 * everything older — including other organizations' `no_publish` releases —
 * off the end, and a poller that only ever reads page one silently misses
 * them. `(publicFeedListedAt, id)` is a total order over the listed set, so
 * `after` walks backwards through it and nothing is ever unreachable.
 */
export async function listThreatFeedScans(
  db: AppDb,
  options: { limit?: number; after?: ThreatFeedCursor | null } = {},
): Promise<SharedScanRow[]> {
  const limit = Math.min(options.limit ?? THREAT_FEED_MAX_ENTRIES, THREAT_FEED_MAX_ENTRIES);
  const after = options.after ?? null;
  return db
    .select(SHARED_SCAN_COLUMNS)
    .from(scans)
    .where(
      and(
        isNotNull(scans.publicFeedListedAt),
        isNotNull(scans.publicShareToken),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        after
          ? or(
              sql`${scans.publicFeedListedAt} < ${after.listedAtMs}`,
              and(
                sql`${scans.publicFeedListedAt} = ${after.listedAtMs}`,
                sql`${scans.id} < ${after.scanId}`,
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(scans.publicFeedListedAt), desc(scans.id))
    .limit(limit);
}

/** The cursor that continues a page, or null when the feed is exhausted. */
export function threatFeedNextCursor(
  rows: SharedScanRow[],
  limit: number,
): ThreatFeedCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last?.publicFeedListedAt) return null;
  return { listedAtMs: last.publicFeedListedAt.getTime(), scanId: last.scanId };
}

// Filtered in SQL for the same reason as the ecosystem: an active prerelease
// line publishes far more often than the stable one, so a bounded page taken
// before the tag filter would be all `rc` rows and the `latest` badge would
// read "not reviewed" while a listed stable review sat just past the limit.
// `badgeTagMatches` documents why an untagged scan answers only the default.
function badgeTagMatchesSql(tag: string) {
  const distTag = sql`json_extract(${scans.summaryJson}, '$.stagedPublish.tag')`;
  return tag === DEFAULT_BADGE_TAG
    ? or(sql`${distTag} = ${tag}`, sql`${distTag} IS NULL`)
    : sql`${distTag} = ${tag}`;
}

/**
 * The package-level off switch (`package_badge_opt_outs`): an organization can
 * stop its own reviews from answering the badge for a package at all.
 *
 * Matched on the badge key being asked for, which is the key every candidate
 * on either route was selected by, so the switch and the route cannot
 * normalize a name differently.
 *
 * It suppresses *both* badge routes, including a review that was deliberately
 * feed-listed: "public badge: off" has to mean the badge is off, or the
 * control does not mean what it says. The threat-feed entry is a different
 * surface and is unaffected; unlisting is still how that is withdrawn.
 */
function badgeNotOptedOut(packageKey: string) {
  return sql`not exists (
    select 1 from package_badge_opt_outs o
    where o.organization_id = ${scans.organizationId}
      and o.package_key = ${packageKey}
  )`;
}

// Badge-ineligible sources never get a badge key, so this excludes nothing the
// key filters admit today. It stays as the second lock: a row that acquired a
// key before its source was reclassified, or through a future write that
// forgets the rule, must still never speak for a badge.
const badgeEligibleSource = notInArray(scans.source, [...BADGE_INELIGIBLE_SOURCES]);

// The read-side lock for `scanPublicPackageName`: only a manifest-claimed gate
// review answers under its own manifest name; any other row answers only while
// that name is npm's name for the stage. A key written before the write-side
// rule existed — or by a future write that forgets it — must still never let a
// tarball's claimed name speak for a package the credential did not reach.
// SQLite compares text exactly, which is how npm resolves names. Coalesced so
// a missing name reads as "no", never as NULL, and the predicate can be negated.
const publicNameIsRegistryName = sql`coalesce(${scans.source} = 'workflow_gate' or ${scans.packageName} = ${scans.registryPackageName}, 0)`;

/**
 * Recent badge candidates for one package name that an organization
 * deliberately listed. The opt-in route: a privately shared link never becomes
 * name-queryable, and this is the only way an undecided or rejected review —
 * or a scoped, PyPI, VS Code, or manifest-claimed one — reaches the badge.
 * `listDefaultBadgeCandidateScans` is the other route, for OSS packages that
 * need no opt-in at all.
 *
 * Ecosystem is filtered in SQL over the persisted provenance snapshot
 * (staged-publish scans carry no snapshot and are npm by construction), so a
 * package that is busy in one ecosystem can never crowd another ecosystem's
 * review out of the bounded page.
 */
export async function listBadgeCandidateScans(
  db: AppDb,
  packageName: string,
  ecosystem: "npm" | "pypi" | "vscode",
  tag: string = DEFAULT_BADGE_TAG,
  limit = 20,
): Promise<SharedScanRow[]> {
  const packageKey = publicPackageLookupKey(ecosystem, packageName);
  const provenanceEcosystem = sql`json_extract(${scans.summaryJson}, '$.stagedPublish.provenance.ecosystem')`;
  const ecosystemMatches =
    ecosystem === "npm"
      ? or(sql`${provenanceEcosystem} = 'npm'`, sql`${provenanceEcosystem} IS NULL`)
      : sql`${provenanceEcosystem} = ${ecosystem}`;
  // Rank registry-backed scans before applying the bounded page. Otherwise a
  // burst of newer manifest-claimed gate scans could crowd the verified review
  // out of the result set before pickBadgeScan gets a chance to prefer it.
  const packageIdentityPriority = sql<number>`CASE WHEN ${scans.source} = 'workflow_gate' THEN 1 ELSE 0 END`;
  return db
    .select(SHARED_SCAN_COLUMNS)
    .from(scans)
    .where(
      and(
        eq(scans.publicPackageKey, packageKey),
        isNotNull(scans.publicShareToken),
        isNotNull(scans.publicFeedListedAt),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        ecosystemMatches,
        badgeTagMatchesSql(tag),
        badgeEligibleSource,
        publicNameIsRegistryName,
        badgeNotOptedOut(packageKey),
      ),
    )
    .orderBy(packageIdentityPriority, desc(scans.completedAt), desc(scans.id))
    .limit(limit);
}

/**
 * Order badge candidates newest **release** first, not newest scan.
 *
 * Scan completion order is not release order: two releases staged together
 * finish in whatever order their tarballs process, so ordering by
 * `completed_at` lets a 3.0.0 review that happened to finish last outrank the
 * 3.0.1 review beside it — and the badge then names a version nobody installs,
 * in green, with nothing to notice it. `findNewerPublishedRelease` cannot
 * catch that case either, because a newer release that *is* a candidate is
 * deliberately not "a release the badge cannot speak for".
 *
 * The registry's version is the one compared wherever it exists; a row without
 * one (a gate review) can only be placed by its manifest version. Completion
 * time stays as the tiebreak for two rows describing the same version.
 */
export function compareBadgeCandidates(a: SharedScanRow, b: SharedScanRow): number {
  const versionA = a.registryVersion ?? a.stagedVersion;
  const versionB = b.registryVersion ?? b.stagedVersion;
  if (versionA && versionB && versionA !== versionB) {
    const order = compareSemver(versionB, versionA);
    if (order !== 0) return order;
  }
  return (
    (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0) ||
    b.scanId.localeCompare(a.scanId)
  );
}

/**
 * Reviews that answer the badge for a package that needs no opt-in — one npm
 * reports as public, reviewed through a stage npm let the organization's token
 * read, under npm's own name for it (see `isDefaultBadgePublic`).
 *
 * Two extra conditions beyond that flag, both about the *release* rather than
 * the package:
 *
 * - **Approved only.** Without a deliberate listing there is no consent to
 *   publish a verdict the organization did not act on, so an undecided review
 *   and a rejection are both simply absent here — indistinguishable from a
 *   package nobody scanned. A maintainer who *wants* the badge to carry a
 *   rejection lists that review explicitly, and `listBadgeCandidateScans`
 *   picks it up with the full vocabulary.
 * - **Published by the registry.** A staged version is not public until npm
 *   publishes it. Without this the badge would announce a pending release —
 *   its number and its timing — to anyone watching the README.
 */
export async function listDefaultBadgeCandidateScans(
  db: AppDb,
  packageKey: string,
  tag: string = DEFAULT_BADGE_TAG,
  limit = 20,
): Promise<SharedScanRow[]> {
  return db
    .select(SHARED_SCAN_COLUMNS)
    .from(scans)
    .where(
      and(
        eq(scans.badgePackageKey, packageKey),
        eq(scans.badgePublic, true),
        eq(scans.decision, "publish"),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        eq(scans.registryVersionStatus, "published"),
        badgeEligibleSource,
        // `badge_public` already requires it; the key is a release line, not
        // an identity, so the name rule is enforced here as well.
        publicNameIsRegistryName,
        badgeTagMatchesSql(tag),
        badgeNotOptedOut(packageKey),
      ),
    )
    .orderBy(desc(scans.completedAt), desc(scans.id))
    .limit(limit);
}

/**
 * The version of a newer release on the same line that the badge is *not*
 * speaking for, or null when the quoted review is still the current one.
 *
 * A badge lives in a README forever while listing is per scan, so without this
 * a package that released again keeps a green "3.0.0 approved" badge next to
 * an install command that fetches 3.0.1. This is what lets the badge say so.
 *
 * Three deliberate bounds, because a badge is an anonymous surface:
 *
 * - **Same organization.** Another organization's review of the same package
 *   says nothing about this maintainer's release line, and letting it grey out
 *   a badge would hand any account a lever on someone else's README.
 * - **Only versions the registry itself published.** Both the gate
 *   (`registry_version_status`) and the version this returns come from npm's
 *   answer about `registry_version` — never from `staged_version`, which is
 *   replaced with the *inspected tarball's* manifest after a scan and is
 *   therefore reviewed package bytes. A badge must not render an attacker's
 *   string, and must not name a version npm has not announced.
 * - **Only unlisted releases.** A newer *listed* review is either the badge's
 *   own pick or a deliberate preference (a registry-verified review outranks a
 *   manifest-claimed one); neither is staleness.
 *
 * Recency is decided by **version order, not by scan time**: re-reviewing the
 * quoted release, or an older one, completes later than the pick but is not a
 * newer release, and must not take the badge off a valid review. The bounded
 * page is ordered by completion only to keep the window recent.
 *
 * The decision on the newer scan is not consulted and is never disclosed:
 * "not reviewed" here means what it already means elsewhere in the badge —
 * nothing is listed for it — not that no one looked.
 */
export async function findNewerPublishedRelease(
  db: AppDb,
  pick: SharedScanRow,
  limit = 20,
): Promise<string | null> {
  if (!pick.organizationId) return null;
  const packageKey = badgeLookupKey(pick);
  if (!packageKey) return null;
  // The pick's own place in the version order. Its registry version is the
  // trustworthy one for the comparison; a row without one (a gate review, or
  // one predating the column) can only be placed by its manifest version.
  const pickVersion = pick.registryVersion ?? pick.stagedVersion;
  if (!pickVersion) return null;
  const tag = scanDistTag(pick.summaryJson) ?? DEFAULT_BADGE_TAG;
  const rows = await db
    .select({ registryVersion: scans.registryVersion })
    .from(scans)
    .where(
      and(
        eq(scans.badgePackageKey, packageKey),
        eq(scans.organizationId, pick.organizationId),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        // Not a badge candidate by either route: neither listed under this
        // key, nor answering by default as an approved public release. A
        // release with no public name (its manifest disagrees with npm's) is
        // neither, however it was shared, so it still takes the badge off an
        // older version.
        not(
          and(
            isNotNull(scans.publicFeedListedAt),
            eq(scans.publicPackageKey, packageKey),
            publicNameIsRegistryName,
          )!,
        ),
        or(
          eq(scans.badgePublic, false),
          isNull(scans.decision),
          ne(scans.decision, "publish"),
          not(publicNameIsRegistryName),
        ),
        eq(scans.registryVersionStatus, "published"),
        isNotNull(scans.registryVersion),
        badgeEligibleSource,
        badgeTagMatchesSql(tag),
      ),
    )
    .orderBy(desc(scans.completedAt), desc(scans.id))
    .limit(limit);
  let newest: string | null = null;
  for (const row of rows) {
    const candidate = row.registryVersion;
    if (!candidate) continue;
    if (compareSemver(candidate, pickVersion) <= 0) continue;
    if (!newest || compareSemver(candidate, newest) > 0) newest = candidate;
  }
  return newest;
}

/**
 * Resolve a public share token to its scan's id + organization. The caller
 * re-reads the full detail through `getScan` with the resolved organization so
 * the public path shares the exact read pipeline (R2 artifacts, digest checks)
 * used by authenticated reads.
 */
export async function resolvePublicShareToken(
  db: AppDb,
  token: string,
): Promise<{ scanId: string; organizationId: string; includesFiles: boolean } | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      scanId: scans.id,
      organizationId: scans.organizationId,
      status: scans.status,
      includesFiles: scans.publicShareIncludesFiles,
    })
    .from(scans)
    .where(and(eq(scans.publicShareToken, token), isNull(scans.registryStatusSupersededAt)))
    .limit(1);
  if (!row || row.status !== "complete" || !row.organizationId) return null;
  return {
    scanId: row.scanId,
    organizationId: row.organizationId,
    includesFiles: row.includesFiles,
  };
}
