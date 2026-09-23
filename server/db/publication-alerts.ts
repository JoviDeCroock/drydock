import { and, asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  publicationAlerts,
  publicationObservations,
  publicationWatches,
  scanEvents,
} from "./schema";

export type PublicationAlertStatus = typeof publicationAlerts.$inferSelect.status;
export type PublicationAlertResolution = NonNullable<
  typeof publicationAlerts.$inferSelect.resolution
>;
export type PublicationAlertResolutionBadge = NonNullable<
  typeof publicationAlerts.$inferSelect.resolutionBadge
>;

// An alert the organization approved after release needs no further notice:
// it is resolved. A decline leaves it open.
const notApprovedAfterRelease = or(
  isNull(publicationAlerts.resolution),
  ne(publicationAlerts.resolution, "approved_after_release"),
);

export function isPublicationAlert(status: string): status is PublicationAlertStatus {
  return (
    status === "published_without_approval" ||
    status === "published_despite_rejection" ||
    status === "artifact_mismatch"
  );
}

// The ledger survives stopping a watch. A release must not notify again merely
// because its observation window was removed and later recreated.
export async function savePublicationObservation(
  db: AppDb,
  observation: typeof publicationObservations.$inferInsert,
  packageName: string,
) {
  const writeObservation = db
    .insert(publicationObservations)
    .values(observation)
    .onConflictDoUpdate({
      target: [publicationObservations.watchId, publicationObservations.version],
      set: {
        publishedAt: observation.publishedAt,
        checkedAt: observation.checkedAt,
        status: observation.status,
        reason: observation.reason,
        scanId: observation.scanId,
        sha1: observation.sha1,
        sha256: observation.sha256,
        previousVersion: observation.previousVersion,
        distTags: observation.distTags,
      },
      setWhere: eq(publicationObservations.status, "unknown"),
    });
  if (!isPublicationAlert(observation.status)) {
    await writeObservation;
    return false;
  }
  const id = crypto.randomUUID();
  const now = new Date();
  const [, created] = await db.batch([
    writeObservation,
    db
      .insert(publicationAlerts)
      .select(
        // The creating check holds the delivery claim: it delivers right after.
        // Positional over every column, so the trailing nulls are the review
        // and resolution columns (migration 0035), in declaration order.
        sql`select ${id}, ${observation.organizationId}, ${packageName}, ${observation.version}, ${observation.status}, ${now.getTime()}, null, null, null, ${now.getTime()}, null, null, null, null, null, null, null where exists(select 1 from publication_observations where watch_id = ${observation.watchId} and organization_id = ${observation.organizationId} and version = ${observation.version} and status = ${observation.status})`,
      )
      .onConflictDoNothing({
        target: [
          publicationAlerts.organizationId,
          publicationAlerts.packageName,
          publicationAlerts.version,
        ],
      })
      .returning({ id: publicationAlerts.id }),
    db
      .insert(scanEvents)
      .select(
        sql`select ${crypto.randomUUID()}, ${observation.organizationId}, null, null, 'publication.discrepancy', ${JSON.stringify({ packageName, stagedVersion: observation.version, status: observation.status })}, ${now.getTime()} where exists(select 1 from publication_alerts where id = ${id})`,
      ),
  ]);
  return created.length > 0;
}

/**
 * Alerts in this watch's current observation window that nobody has been told
 * about yet, oldest first, with the reason recorded on their observation.
 *
 * The alert row is committed before delivery is attempted, so a transport that
 * was down at the moment of detection would otherwise lose the notification
 * permanently: the observation is settled, so the version is never re-examined.
 * The ledger outlives a stopped watch, so an alert from an earlier window is
 * excluded: the dashboard cannot show or acknowledge it, and it must not email.
 */
export async function listUnnotifiedPublicationAlerts(
  db: AppDb,
  input: { organizationId: string; packageName: string; watchId: string },
) {
  return db
    .select({
      id: publicationAlerts.id,
      version: publicationAlerts.version,
      status: publicationAlerts.status,
      // Select-list column references render unqualified, which inside a
      // correlated subquery would bind to `o`: name the outer table explicitly.
      reason: sql<
        string | null
      >`(select o.reason from publication_observations o where o.watch_id = ${input.watchId} and o.organization_id = publication_alerts.organization_id and o.version = publication_alerts.version)`,
    })
    .from(publicationAlerts)
    .where(
      and(
        eq(publicationAlerts.organizationId, input.organizationId),
        eq(publicationAlerts.packageName, input.packageName),
        isNull(publicationAlerts.notifiedAt),
        isNull(publicationAlerts.acknowledgedAt),
        notApprovedAfterRelease,
        sql`exists(select 1 from publication_observations o where o.watch_id = ${input.watchId} and o.organization_id = ${publicationAlerts.organizationId} and o.version = ${publicationAlerts.version})`,
      ),
    )
    .orderBy(asc(publicationAlerts.createdAt), asc(publicationAlerts.id))
    .limit(20);
}

type AlertKey = { organizationId: string; packageName: string; version: string };

function alertKey(input: AlertKey) {
  return and(
    eq(publicationAlerts.organizationId, input.organizationId),
    eq(publicationAlerts.packageName, input.packageName),
    eq(publicationAlerts.version, input.version),
  );
}

/**
 * Take the right to deliver one pending alert. Overlapping checks (a long
 * scheduled check and a manual one) both see it pending; only the one whose
 * claim lands sends it. A failed delivery releases its claim for the next
 * check; a claim older than `leaseMs` belongs to a delivery that died and may
 * be taken over.
 */
export async function claimPublicationAlertDelivery(
  db: AppDb,
  input: AlertKey,
  now: Date,
  leaseMs: number,
) {
  const claimed = await db
    .update(publicationAlerts)
    .set({ deliveryClaimedAt: now })
    .where(
      and(
        alertKey(input),
        isNull(publicationAlerts.notifiedAt),
        isNull(publicationAlerts.acknowledgedAt),
        notApprovedAfterRelease,
        or(
          isNull(publicationAlerts.deliveryClaimedAt),
          lt(publicationAlerts.deliveryClaimedAt, new Date(now.getTime() - leaseMs)),
        ),
      ),
    )
    .returning({ id: publicationAlerts.id });
  return claimed.length > 0;
}

export async function releasePublicationAlertClaim(db: AppDb, input: AlertKey) {
  await db
    .update(publicationAlerts)
    .set({ deliveryClaimedAt: null })
    .where(and(alertKey(input), isNull(publicationAlerts.notifiedAt)));
}

const PACKAGE_ALERT_PAGE = 50;

/**
 * The organization's alert ledger for one package, across every watch window,
 * newest first. Stopping a watch removes its observations, but not what was
 * alerted and acknowledged, so the package page can keep showing that history.
 * Each alert says whether it belongs to the current watch's window, and
 * `more` says the ledger holds older alerts than the page lists.
 */
export async function listPublicationAlertsForPackage(
  db: AppDb,
  organizationId: string,
  packageName: string,
  currentWatchId: string | null,
) {
  const rows = await db
    .select({
      version: publicationAlerts.version,
      status: publicationAlerts.status,
      createdAt: publicationAlerts.createdAt,
      acknowledgedAt: publicationAlerts.acknowledgedAt,
      reviewScanId: publicationAlerts.reviewScanId,
      resolution: publicationAlerts.resolution,
      resolvedAt: publicationAlerts.resolvedAt,
      inCurrentWatch: currentWatchId
        ? // Qualified by hand: see listUnnotifiedPublicationAlerts.
          sql<boolean>`exists(select 1 from publication_observations o where o.watch_id = ${currentWatchId} and o.organization_id = publication_alerts.organization_id and o.version = publication_alerts.version)`.mapWith(
            Boolean,
          )
        : sql<boolean>`0`.mapWith(Boolean),
    })
    .from(publicationAlerts)
    .where(
      and(
        eq(publicationAlerts.organizationId, organizationId),
        eq(publicationAlerts.packageName, packageName),
      ),
    )
    .orderBy(desc(publicationAlerts.createdAt), desc(publicationAlerts.id))
    .limit(PACKAGE_ALERT_PAGE + 1);
  return { alerts: rows.slice(0, PACKAGE_ALERT_PAGE), more: rows.length > PACKAGE_ALERT_PAGE };
}

/** Record that delivery succeeded, so the alert stops being re-driven. */
export async function markPublicationAlertNotified(db: AppDb, input: AlertKey) {
  await db
    .update(publicationAlerts)
    .set({ notifiedAt: new Date() })
    .where(and(alertKey(input), isNull(publicationAlerts.notifiedAt)));
}

export async function acknowledgePublicationAlert(
  db: AppDb,
  input: {
    organizationId: string;
    watchId: string;
    observationId: string;
    actorUserId: string;
  },
) {
  const [alert] = await db
    .select({
      id: publicationAlerts.id,
      packageName: publicationAlerts.packageName,
      version: publicationAlerts.version,
    })
    .from(publicationAlerts)
    .innerJoin(
      publicationWatches,
      and(
        eq(publicationWatches.organizationId, publicationAlerts.organizationId),
        eq(publicationWatches.packageName, publicationAlerts.packageName),
      ),
    )
    .innerJoin(
      publicationObservations,
      and(
        eq(publicationObservations.watchId, publicationWatches.id),
        eq(publicationObservations.version, publicationAlerts.version),
        eq(publicationObservations.organizationId, publicationAlerts.organizationId),
      ),
    )
    .where(
      and(
        eq(publicationAlerts.organizationId, input.organizationId),
        eq(publicationWatches.id, input.watchId),
        eq(publicationObservations.id, input.observationId),
      ),
    )
    .limit(1);
  if (!alert) return false;
  const now = new Date();
  await db.batch([
    db
      .update(publicationAlerts)
      .set({ acknowledgedAt: now, acknowledgedBy: input.actorUserId })
      .where(and(eq(publicationAlerts.id, alert.id), isNull(publicationAlerts.acknowledgedAt))),
    db
      .insert(scanEvents)
      .values({
        id: `publication-ack:${alert.id}`,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        type: "publication.acknowledged",
        metadataJson: { packageName: alert.packageName, stagedVersion: alert.version },
        createdAt: now,
      })
      .onConflictDoNothing(),
  ]);
  return true;
}

/**
 * The alert behind one observed release of a watch, with what a post-release
 * review of it needs: the release's coordinates, the published version it
 * follows, and the review already linked to it. Organization-scoped through
 * every join; null unless the observation carries an alert.
 */
export async function findObservationAlert(
  db: AppDb,
  input: { organizationId: string; watchId: string; observationId: string },
) {
  const [alert] = await db
    .select({
      id: publicationAlerts.id,
      packageName: publicationAlerts.packageName,
      version: publicationAlerts.version,
      reviewScanId: publicationAlerts.reviewScanId,
      previousVersion: publicationObservations.previousVersion,
    })
    .from(publicationAlerts)
    .innerJoin(
      publicationWatches,
      and(
        eq(publicationWatches.organizationId, publicationAlerts.organizationId),
        eq(publicationWatches.packageName, publicationAlerts.packageName),
      ),
    )
    .innerJoin(
      publicationObservations,
      and(
        eq(publicationObservations.watchId, publicationWatches.id),
        eq(publicationObservations.version, publicationAlerts.version),
        eq(publicationObservations.organizationId, publicationAlerts.organizationId),
      ),
    )
    .where(
      and(
        eq(publicationAlerts.organizationId, input.organizationId),
        eq(publicationWatches.id, input.watchId),
        eq(publicationObservations.id, input.observationId),
      ),
    )
    .limit(1);
  return alert ?? null;
}

/**
 * Link a freshly created review to the alert, unless another request linked
 * one first: at most one post-release review per alert. The link and its
 * audit event commit together. Returns whether this call linked it.
 */
export async function linkPublicationAlertReview(
  db: AppDb,
  input: {
    alertId: string;
    organizationId: string;
    scanId: string;
    actorUserId: string;
    packageName: string;
    version: string;
  },
) {
  const now = new Date();
  const [linked] = await db.batch([
    db
      .update(publicationAlerts)
      .set({
        reviewScanId: input.scanId,
        reviewRequestedAt: now,
        reviewRequestedBy: input.actorUserId,
      })
      .where(
        and(
          eq(publicationAlerts.id, input.alertId),
          eq(publicationAlerts.organizationId, input.organizationId),
          isNull(publicationAlerts.reviewScanId),
        ),
      )
      .returning({ id: publicationAlerts.id }),
    // No scan_id: the event must outlive the review if it fails and is
    // deleted (scan events cascade with their scan); metadata names it.
    db
      .insert(scanEvents)
      .select(
        sql`select ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorUserId}, null, 'publication.review_started', ${JSON.stringify({ packageName: input.packageName, stagedVersion: input.version, scanId: input.scanId })}, ${now.getTime()} where exists(select 1 from publication_alerts where id = ${input.alertId} and review_scan_id = ${input.scanId})`,
      ),
  ]);
  return linked.length > 0;
}

/** The alert a post-release review answers, or null when the scan is linked to none. */
export async function getPublicationAlertReview(db: AppDb, organizationId: string, scanId: string) {
  const [alert] = await db
    .select({
      id: publicationAlerts.id,
      packageName: publicationAlerts.packageName,
      version: publicationAlerts.version,
      resolution: publicationAlerts.resolution,
      resolvedAt: publicationAlerts.resolvedAt,
      resolutionBadge: publicationAlerts.resolutionBadge,
    })
    .from(publicationAlerts)
    .where(
      and(
        eq(publicationAlerts.organizationId, organizationId),
        eq(publicationAlerts.reviewScanId, scanId),
      ),
    )
    .limit(1);
  return alert ?? null;
}

/**
 * Record the organization's decision on the release after it was published,
 * beside the observation's verdict, never over it. Re-deciding the review
 * updates it; the audit event records each resolution.
 */
export async function resolvePublicationAlertReview(
  db: AppDb,
  input: {
    alertId: string;
    organizationId: string;
    scanId: string;
    actorUserId: string;
    packageName: string;
    version: string;
    resolution: PublicationAlertResolution;
    resolutionBadge: PublicationAlertResolutionBadge;
  },
) {
  const now = new Date();
  const [resolved] = await db.batch([
    db
      .update(publicationAlerts)
      .set({
        resolution: input.resolution,
        resolvedAt: now,
        resolvedBy: input.actorUserId,
        resolutionBadge: input.resolutionBadge,
      })
      .where(
        and(
          eq(publicationAlerts.id, input.alertId),
          eq(publicationAlerts.organizationId, input.organizationId),
          eq(publicationAlerts.reviewScanId, input.scanId),
        ),
      )
      .returning({ id: publicationAlerts.id }),
    db
      .insert(scanEvents)
      .select(
        sql`select ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorUserId}, ${input.scanId}, 'publication.review_resolved', ${JSON.stringify({ packageName: input.packageName, stagedVersion: input.version, resolution: input.resolution, badge: input.resolutionBadge })}, ${now.getTime()} where exists(select 1 from publication_alerts where id = ${input.alertId} and review_scan_id = ${input.scanId})`,
      ),
  ]);
  return resolved.length > 0;
}

/**
 * The publication alert a post-release review answers, as the review page
 * shows it, or null. Only a published-pair review can be linked to one.
 */
export async function postReleaseLink(
  db: AppDb,
  organizationId: string,
  scanId: string,
  source: string | null | undefined,
) {
  if (source !== "published") return null;
  const alert = await getPublicationAlertReview(db, organizationId, scanId);
  if (!alert) return null;
  return {
    packageName: alert.packageName,
    version: alert.version,
    resolution: alert.resolution,
    resolvedAt: alert.resolvedAt,
    resolutionBadge: alert.resolutionBadge,
  };
}
