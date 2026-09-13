import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { isValidNpmPackageName } from "../lib/ecosystems/npm/registry";
import { publicationObservations, publicationWatchCandidates, publicationWatches } from "./schema";

export type PublicationWatch = typeof publicationWatches.$inferSelect;
export type PublicationObservation = typeof publicationObservations.$inferSelect;
export class PublicationWatchLimitError extends Error {}
class PublicationWatchNameError extends Error {}

export function listPublicationWatches(db: AppDb, organizationId: string) {
  return db
    .select()
    .from(publicationWatches)
    .where(eq(publicationWatches.organizationId, organizationId))
    .orderBy(asc(publicationWatches.createdAt));
}
export async function getPublicationWatch(db: AppDb, organizationId: string, id: string) {
  const [watch] = await db
    .select()
    .from(publicationWatches)
    .where(
      and(eq(publicationWatches.organizationId, organizationId), eq(publicationWatches.id, id)),
    )
    .limit(1);
  return watch ?? null;
}
export async function createPublicationWatch(
  db: AppDb,
  organizationId: string,
  packageName: string,
) {
  if (!isValidNpmPackageName(packageName))
    throw new PublicationWatchNameError("Invalid npm package name");
  const id = crypto.randomUUID();
  const now = new Date();
  // Clear stop intent only when the cap allows a watch (or one already exists).
  await db.batch([
    db
      .insert(publicationWatches)
      .select(
        sql`select ${id}, ${organizationId}, ${packageName}, 'manual', ${now.getTime()}, null, null where (select count(*) from publication_watches where organization_id = ${organizationId}) < 20`,
      )
      .onConflictDoNothing({
        target: [publicationWatches.organizationId, publicationWatches.packageName],
      }),
    db
      .insert(publicationWatchCandidates)
      .select(
        sql`select ${crypto.randomUUID()}, ${organizationId}, ${packageName}, 'manual', ${now.getTime()}, null where exists(select 1 from publication_watches where organization_id = ${organizationId} and package_name = ${packageName})`,
      )
      .onConflictDoUpdate({
        target: [publicationWatchCandidates.organizationId, publicationWatchCandidates.packageName],
        set: { stoppedAt: null },
      }),
  ]);
  const [watch] = await db
    .select()
    .from(publicationWatches)
    .where(
      and(
        eq(publicationWatches.organizationId, organizationId),
        eq(publicationWatches.packageName, packageName),
      ),
    )
    .limit(1);
  if (!watch)
    throw new PublicationWatchLimitError("At most 20 packages can be monitored per organization");
  return watch;
}
export async function deletePublicationWatch(db: AppDb, organizationId: string, id: string) {
  const now = new Date();
  // Suppression and deletion commit together; a stale discovery cannot recreate
  // a removed watch, and explicit re-enrollment gets a fresh identity.
  const [, rows] = await db.batch([
    db
      .insert(publicationWatchCandidates)
      .select(
        sql`select ${crypto.randomUUID()}, organization_id, package_name, 'manual', ${now.getTime()}, ${now.getTime()} from publication_watches where organization_id = ${organizationId} and id = ${id}`,
      )
      .onConflictDoUpdate({
        target: [publicationWatchCandidates.organizationId, publicationWatchCandidates.packageName],
        set: { stoppedAt: now },
      }),
    db
      .delete(publicationWatches)
      .where(
        and(eq(publicationWatches.organizationId, organizationId), eq(publicationWatches.id, id)),
      )
      .returning({ id: publicationWatches.id }),
  ]);
  return rows.length > 0;
}
export function listPublicationObservations(db: AppDb, organizationId: string, watchId: string) {
  return db
    .select()
    .from(publicationObservations)
    .where(
      and(
        eq(publicationObservations.organizationId, organizationId),
        eq(publicationObservations.watchId, watchId),
      ),
    )
    .orderBy(desc(publicationObservations.firstSeenAt), desc(publicationObservations.id))
    .limit(100);
}
