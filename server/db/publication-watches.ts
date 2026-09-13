import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { isValidNpmPackageName } from "../lib/ecosystems/npm/registry";
import { publicationObservations, publicationWatches } from "./schema";

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
  // Keep the enrollment cap atomic even when several members enroll together.
  await db.run(
    sql`insert into publication_watches (id, organization_id, package_name, created_at) select ${id}, ${organizationId}, ${packageName}, ${now.getTime()} where (select count(*) from publication_watches where organization_id = ${organizationId}) < 20 on conflict(organization_id, package_name) do nothing`,
  );
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
  const rows = await db
    .delete(publicationWatches)
    .where(
      and(eq(publicationWatches.organizationId, organizationId), eq(publicationWatches.id, id)),
    )
    .returning({ id: publicationWatches.id });
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
