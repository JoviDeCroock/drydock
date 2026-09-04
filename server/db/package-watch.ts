import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { chunkForD1 } from "./d1-chunk";
import { outOfBandPublishes, packageWatches, scans } from "./schema";

export interface PackageWatchRow {
  id: string;
  organizationId: string;
  registryUrl: string;
  packageName: string;
  versions: string[];
  lastCheckedAt: Date | null;
}

export interface OutOfBandPublishRow {
  id: string;
  registryUrl: string;
  packageName: string;
  version: string;
  statusConfirmed: boolean;
  detectedAt: Date;
}

function normalizeVersions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Package names this organization has reviewed before, most recently active
 * first. Only the immutable registry coordinates select targets:
 * `scans.packageName` is rewritten from the inspected tarball manifest, and
 * hostile bytes must never aim a credentialed registry lookup — so gate scans'
 * manifest-claimed names never become watch targets (they still suppress
 * candidates in `hasScanForRelease`).
 */
export async function listWatchTargets(
  db: AppDb,
  organizationId: string,
  registryUrl: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ name: scans.registryPackageName })
    .from(scans)
    .where(and(eq(scans.organizationId, organizationId), eq(scans.registryUrl, registryUrl)))
    .groupBy(scans.registryPackageName)
    .orderBy(sql`max(${scans.createdAt}) desc`)
    .limit(limit);
  return rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export async function listPackageWatches(
  db: AppDb,
  organizationId: string,
  registryUrl: string,
  packageNames: string[],
): Promise<PackageWatchRow[]> {
  const rows: PackageWatchRow[] = [];
  for (const chunk of chunkForD1(packageNames, 1, 2)) {
    if (!chunk.length) continue;
    const found = await db
      .select()
      .from(packageWatches)
      .where(
        and(
          eq(packageWatches.organizationId, organizationId),
          eq(packageWatches.registryUrl, registryUrl),
          inArray(packageWatches.packageName, chunk),
        ),
      );
    for (const row of found) {
      rows.push({
        id: row.id,
        organizationId: row.organizationId,
        registryUrl: row.registryUrl,
        packageName: row.packageName,
        versions: normalizeVersions(row.versionsJson),
        lastCheckedAt: row.lastCheckedAt,
      });
    }
  }
  return rows;
}

export async function createPackageWatch(
  db: AppDb,
  input: {
    organizationId: string;
    registryUrl: string;
    packageName: string;
    versions: string[];
    checkedAt: Date;
  },
): Promise<void> {
  await db
    .insert(packageWatches)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      registryUrl: input.registryUrl,
      packageName: input.packageName,
      versionsJson: input.versions,
      lastCheckedAt: input.checkedAt,
      createdAt: input.checkedAt,
      updatedAt: input.checkedAt,
    })
    .onConflictDoNothing();
}

export async function updatePackageWatchVersions(
  db: AppDb,
  input: { id: string; versions: string[]; checkedAt: Date },
): Promise<void> {
  await db
    .update(packageWatches)
    .set({
      versionsJson: input.versions,
      lastCheckedAt: input.checkedAt,
      updatedAt: input.checkedAt,
    })
    .where(eq(packageWatches.id, input.id));
}

/**
 * Whether any review exists for this release, in either identity shape: the
 * immutable registry coordinates (manual and auto-discovery scans) or the
 * display identity (workflow-gate scans, whose registry coordinates are null).
 */
export async function hasScanForRelease(
  db: AppDb,
  organizationId: string,
  registryUrl: string,
  packageName: string,
  version: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, organizationId),
        or(
          and(
            eq(scans.registryUrl, registryUrl),
            eq(scans.registryPackageName, packageName),
            eq(scans.registryVersion, version),
          ),
          and(eq(scans.packageName, packageName), eq(scans.stagedVersion, version)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Insert-or-ignore on the unique release index; true means this call created the alarm. */
export async function recordOutOfBandPublish(
  db: AppDb,
  input: {
    organizationId: string;
    registryUrl: string;
    packageName: string;
    version: string;
    statusConfirmed: boolean;
    detectedAt: Date;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(outOfBandPublishes)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      registryUrl: input.registryUrl,
      packageName: input.packageName,
      version: input.version,
      statusConfirmed: input.statusConfirmed,
      detectedAt: input.detectedAt,
    })
    .onConflictDoNothing()
    .returning({ id: outOfBandPublishes.id });
  return inserted.length > 0;
}

export async function listOpenOutOfBandPublishes(
  db: AppDb,
  organizationId: string,
  limit = 50,
): Promise<OutOfBandPublishRow[]> {
  const rows = await db
    .select()
    .from(outOfBandPublishes)
    .where(
      and(
        eq(outOfBandPublishes.organizationId, organizationId),
        isNull(outOfBandPublishes.acknowledgedAt),
      ),
    )
    .orderBy(sql`${outOfBandPublishes.detectedAt} desc`)
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    registryUrl: row.registryUrl,
    packageName: row.packageName,
    version: row.version,
    statusConfirmed: row.statusConfirmed,
    detectedAt: row.detectedAt,
  }));
}

export async function acknowledgeOutOfBandPublish(
  db: AppDb,
  input: { organizationId: string; alarmId: string; userId: string; at: Date },
): Promise<OutOfBandPublishRow | null> {
  const updated = await db
    .update(outOfBandPublishes)
    .set({ acknowledgedAt: input.at, acknowledgedByUserId: input.userId })
    .where(
      and(
        eq(outOfBandPublishes.id, input.alarmId),
        eq(outOfBandPublishes.organizationId, input.organizationId),
        isNull(outOfBandPublishes.acknowledgedAt),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) return null;
  return {
    id: row.id,
    registryUrl: row.registryUrl,
    packageName: row.packageName,
    version: row.version,
    statusConfirmed: row.statusConfirmed,
    detectedAt: row.detectedAt,
  };
}
