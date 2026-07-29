import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { base64UrlEncode } from "../lib/platform/crypto-utils";
import { publicPackageLookupKey, scanEcosystem } from "../lib/public-feed";
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
    })
    .from(scans)
    .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  if (!row?.publicShareToken || !row.publicSharedAt) return null;
  return {
    publicShareToken: row.publicShareToken,
    publicSharedAt: row.publicSharedAt,
    publicFeedListedAt: row.publicFeedListedAt,
    publicPackageKey: row.publicPackageKey,
  };
}

/**
 * Enable (or return the existing) public share link for a completed scan.
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
        packageName: scans.packageName,
        stagedVersion: scans.stagedVersion,
      })
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
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
): Promise<{ revoked: boolean; publicPackageKey: string | null }> {
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
      // just went stale is recomputed from the (untouched) package name.
      summaryJson: scans.summaryJson,
    });
  if (updated.length === 0) return { revoked: false, publicPackageKey: null };

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.share_revoked",
    metadata: { packageName: updated[0].packageName, stagedVersion: updated[0].stagedVersion },
  });
  return {
    revoked: true,
    publicPackageKey: updated[0].packageName
      ? publicPackageLookupKey(scanEcosystem(updated[0].summaryJson), updated[0].packageName)
      : null,
  };
}

/**
 * Toggle the threat-feed listing for an already-shared scan. Listing requires
 * an active share link (the feed entry links to the public report); unlisting
 * keeps the link itself intact. Returns the new state, or null when the scan
 * is missing, not complete, or (for listing) not currently shared.
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
    isNotNull(scans.publicShareToken),
  );
  const [candidate] = await db
    .select({ packageName: scans.packageName, summaryJson: scans.summaryJson })
    .from(scans)
    .where(scoped)
    .limit(1);
  if (!candidate) return null;
  const publicPackageKey =
    input.listed && candidate.packageName
      ? publicPackageLookupKey(scanEcosystem(candidate.summaryJson), candidate.packageName)
      : null;
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
    publicPackageKey:
      publicPackageKey ??
      (row.packageName
        ? publicPackageLookupKey(scanEcosystem(candidate.summaryJson), row.packageName)
        : null),
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
 * review out of the bounded page.
 */
export async function listBadgeCandidateScans(
  db: AppDb,
  packageName: string,
  ecosystem: "npm" | "pypi" | "vscode",
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
        ecosystemMatches,
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
    .where(eq(scans.publicShareToken, token))
    .limit(1);
  if (!row || row.status !== "complete" || !row.organizationId) return null;
  return { scanId: row.scanId, organizationId: row.organizationId };
}
