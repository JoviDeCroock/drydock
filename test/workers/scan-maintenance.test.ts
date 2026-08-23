import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  claimScanForArtifactBackfill,
  claimScanForRetention,
  completeScanArtifactBackfill,
  markScanRetentionArtifactsRemoved,
  releaseScanMaintenanceClaim,
  SCAN_MAINTENANCE_KINDS,
  SCAN_MAINTENANCE_LEASE_MS,
} from "../../server/db/scan-maintenance";
import { createScanJob } from "../../server/db/scans";
import { scans, user } from "../../server/db/schema";

async function seedCompleteScan() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(user).values({
    id: userId,
    name: "Maintenance Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId,
    ownerUserId: userId,
  });
  await db.update(scans).set({ status: "complete" }).where(eq(scans.id, scanId));
  return { db, organizationId, scanId };
}

function claimInput(scan: { organizationId: string; scanId: string }, token: string, now: Date) {
  return {
    ...scan,
    token,
    claimedAt: now,
    staleBefore: new Date(now.getTime() - SCAN_MAINTENANCE_LEASE_MS),
  };
}

describe("scan maintenance claims", () => {
  test("serializes backfills and releases only the current owner", async () => {
    const scan = await seedCompleteScan();
    const now = new Date();

    await expect(
      claimScanForArtifactBackfill(scan.db, claimInput(scan, "backfill-one", now)),
    ).resolves.toMatchObject({
      kind: SCAN_MAINTENANCE_KINDS.artifactBackfill,
      token: "backfill-one",
    });
    await expect(
      claimScanForArtifactBackfill(scan.db, claimInput(scan, "backfill-two", now)),
    ).resolves.toBeNull();
    await expect(
      releaseScanMaintenanceClaim(scan.db, { ...scan, token: "backfill-two" }),
    ).resolves.toBe(false);
    await expect(
      releaseScanMaintenanceClaim(scan.db, { ...scan, token: "backfill-one" }),
    ).resolves.toBe(true);
  });

  test("keeps the artifacts-removed state across retention ownership rotation", async () => {
    const scan = await seedCompleteScan();
    const firstNow = new Date();
    const first = await claimScanForRetention(scan.db, claimInput(scan, "retention-one", firstNow));
    expect(first?.kind).toBe(SCAN_MAINTENANCE_KINDS.retention);
    await expect(
      markScanRetentionArtifactsRemoved(scan.db, { ...scan, token: "retention-one" }),
    ).resolves.toBe(true);

    const retryNow = new Date(firstNow.getTime() + 1);
    await expect(
      claimScanForRetention(scan.db, claimInput(scan, "retention-two", retryNow)),
    ).resolves.toMatchObject({
      kind: SCAN_MAINTENANCE_KINDS.retentionArtifactsRemoved,
      token: "retention-two",
    });
    await expect(
      claimScanForArtifactBackfill(scan.db, claimInput(scan, "backfill", retryNow)),
    ).resolves.toBeNull();
  });

  test("installs backfill metadata and clears maintenance state atomically", async () => {
    const scan = await seedCompleteScan();
    const now = new Date();
    await claimScanForArtifactBackfill(scan.db, claimInput(scan, "backfill", now));

    await expect(
      completeScanArtifactBackfill(scan.db, {
        ...scan,
        token: "backfill",
        metadata: {
          artifactStorageVersion: 1,
          artifactManifestKey: "manifest",
          artifactManifestDigest: "a".repeat(64),
          artifactManifestSize: 100,
          reportArtifactKey: "report",
          fileSamplesArtifactKey: "files",
          diffArtifactKey: "diff",
        },
      }),
    ).resolves.toBe(true);

    const [row] = await scan.db
      .select({
        artifactStorageVersion: scans.artifactStorageVersion,
        maintenanceKind: scans.maintenanceKind,
        maintenanceToken: scans.maintenanceToken,
        maintenanceClaimedAt: scans.maintenanceClaimedAt,
      })
      .from(scans)
      .where(eq(scans.id, scan.scanId));
    expect(row).toEqual({
      artifactStorageVersion: 1,
      maintenanceKind: null,
      maintenanceToken: null,
      maintenanceClaimedAt: null,
    });
  });
});
