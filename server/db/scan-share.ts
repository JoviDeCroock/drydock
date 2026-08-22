import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { base64UrlEncode } from "../lib/platform/crypto-utils";
import {
  DEFAULT_BADGE_TAG,
  publicPackageLookupKey,
  scanDistTag,
  scanEcosystem,
} from "../lib/public-feed";
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
        retentionClaimToken: scans.retentionClaimToken,
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
    return {
      publicShareToken: existing.publicShareToken,
      publicSharedAt: existing.publicSharedAt,
      publicFeedListedAt: existing.publicFeedListedAt,
    };
  }
  if (existing.retentionClaimToken) return null;

  const now = new Date();
  const token = generatePublicShareToken();
  const updated = await db
    .update(scans)
    .set({
      publicShareToken: token,
      publicSharedAt: now,
      publicSharedByUserId: input.actorUserId,
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
        // Retention claims before leaving D1 for the destructive R2 sweep. Once
        // that claim exists, minting a share would return a capability whose
        // evidence and row are already being torn down.
        isNull(scans.retentionClaimToken),
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
  return { publicShareToken: token, publicSharedAt: now, publicFeedListedAt: null };
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
      // just went stale is recomputed from the (untouched) source + snapshot.
      source: scans.source,
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
 * The badge cache key a row occupies, or null when it can never occupy one —
 * no package name, or a gate scan whose provenance never established an
 * ecosystem. Same rule as the key written on listing, so a purge always
 * addresses the entry the write created. Exported for the decision routes,
 * which purge a listed scan's badge when the recorded decision changes what
 * the cached payload asserts.
 */
export function badgeLookupKey(row: {
  source: string;
  packageName: string | null;
  summaryJson: unknown;
}): string | null {
  if (!row.packageName) return null;
  const ecosystem = scanEcosystem(row.source, row.summaryJson);
  return ecosystem ? publicPackageLookupKey(ecosystem, row.packageName) : null;
}

/**
 * Toggle the threat-feed listing for an already-shared scan. Listing requires
 * an active share link (the feed entry links to the public report); unlisting
 * keeps the link itself intact. Returns the new state, or null when the scan
 * is missing, not complete, superseded, or (for listing) not currently shared.
 */
export async function setThreatFeedListing(
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string; listed: boolean },
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
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(scoped)
    .limit(1);
  if (!candidate) return null;
  // Null here means "listed in the feed but not badge-discoverable" — the scan
  // has no name, or is a gate scan whose ecosystem was never established.
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
  };
}

export const THREAT_FEED_MAX_ENTRIES = 100;

export interface SharedScanRow {
  scanId: string;
  source: string;
  packageName: string | null;
  stagedVersion: string | null;
  previousVersion: string | null;
  risk: string;
  decision: string | null;
  findingCount: number | null;
  riskSummaryJson: unknown;
  summaryJson: unknown;
  publicShareToken: string | null;
  publicFeedListedAt: Date | null;
  completedAt: Date | null;
}

const SHARED_SCAN_COLUMNS = {
  scanId: scans.id,
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

/**
 * Recent badge-eligible reviews for one package name. The badge is a
 * discoverable index keyed by package name, so — exactly like the threat
 * feed — it only ever reflects scans whose org explicitly opted into feed
 * listing; a privately shared link never becomes name-queryable.
 *
 * Ecosystem is filtered in SQL over the persisted provenance snapshot
 * (staged-publish scans carry no snapshot and are npm by construction), so a
 * package that is busy in one ecosystem can never crowd another ecosystem's
 * review out of the bounded page. The dist-tag is filtered the same way and for
 * the same reason; `badgeTagMatches` documents why an untagged scan answers only
 * the default (`latest`) badge.
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
  // Filtered in SQL for the same reason as the ecosystem: an active prerelease
  // line publishes far more often than the stable one, so a bounded page taken
  // before the tag filter would be all `rc` rows and the `latest` badge would
  // read "not reviewed" while a listed stable review sat just past the limit.
  const distTag = sql`json_extract(${scans.summaryJson}, '$.stagedPublish.tag')`;
  const tagMatches =
    tag === DEFAULT_BADGE_TAG
      ? or(sql`${distTag} = ${tag}`, sql`${distTag} IS NULL`)
      : sql`${distTag} = ${tag}`;
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
        tagMatches,
      ),
    )
    .orderBy(packageIdentityPriority, desc(scans.completedAt), desc(scans.id))
    .limit(limit);
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
): Promise<{ scanId: string; organizationId: string } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ scanId: scans.id, organizationId: scans.organizationId, status: scans.status })
    .from(scans)
    .where(and(eq(scans.publicShareToken, token), isNull(scans.registryStatusSupersededAt)))
    .limit(1);
  if (!row || row.status !== "complete" || !row.organizationId) return null;
  return { scanId: row.scanId, organizationId: row.organizationId };
}
