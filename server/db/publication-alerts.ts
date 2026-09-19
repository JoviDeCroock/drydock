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
        sql`select ${id}, ${observation.organizationId}, ${packageName}, ${observation.version}, ${observation.status}, ${now.getTime()}, null, null where exists(select 1 from publication_observations where watch_id = ${observation.watchId} and organization_id = ${observation.organizationId} and version = ${observation.version} and status = ${observation.status})`,
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
