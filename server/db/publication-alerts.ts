import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  publicationAlerts,
  publicationObservations,
  publicationWatches,
  scanEvents,
} from "./schema";

export type PublicationAlertStatus = typeof publicationAlerts.$inferSelect.status;

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
        sql`select ${id}, ${observation.organizationId}, ${packageName}, ${observation.version}, ${observation.status}, ${now.getTime()}, null, null, null where exists(select 1 from publication_observations where watch_id = ${observation.watchId} and organization_id = ${observation.organizationId} and version = ${observation.version} and status = ${observation.status})`,
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
 * about yet.
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
    })
    .from(publicationAlerts)
    .where(
      and(
        eq(publicationAlerts.organizationId, input.organizationId),
        eq(publicationAlerts.packageName, input.packageName),
        isNull(publicationAlerts.notifiedAt),
        isNull(publicationAlerts.acknowledgedAt),
        sql`exists(select 1 from publication_observations o where o.watch_id = ${input.watchId} and o.organization_id = ${publicationAlerts.organizationId} and o.version = ${publicationAlerts.version})`,
      ),
    )
    .limit(20);
}

/** Record that delivery succeeded, so the alert stops being re-driven. */
export async function markPublicationAlertNotified(
  db: AppDb,
  input: { organizationId: string; packageName: string; version: string },
) {
  await db
    .update(publicationAlerts)
    .set({ notifiedAt: new Date() })
    .where(
      and(
        eq(publicationAlerts.organizationId, input.organizationId),
        eq(publicationAlerts.packageName, input.packageName),
        eq(publicationAlerts.version, input.version),
        isNull(publicationAlerts.notifiedAt),
      ),
    );
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
