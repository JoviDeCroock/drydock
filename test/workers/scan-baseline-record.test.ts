import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { markScanFailed, recordScanBaseline } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { seedLegacyScanJob } from "./helpers/seed-scan-job";
import { seedCompletedScan, seedUser } from "./helpers/seed";

async function readPreviousVersion(scanId: string) {
  const [row] = await createDb(env.DB)
    .select({ previousVersion: schema.scans.previousVersion })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId))
    .limit(1);
  return row?.previousVersion;
}

async function seedInProgressScan() {
  const owner = await seedUser();
  const scanId = `scan_${crypto.randomUUID()}`;
  await seedLegacyScanJob(owner.db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  return { owner, scanId };
}

describe("recording a scan's baseline mid-run", () => {
  test("names the version in the baseline manifest on a scan still in progress", async () => {
    const { owner, scanId } = await seedInProgressScan();

    await recordScanBaseline(owner.db, {
      scanId,
      organizationId: owner.organizationId,
      previousPackageJson: { name: "@org/pkg", version: "1.0.0" },
    });

    expect(await readPreviousVersion(scanId)).toBe("1.0.0");
  });

  test("a later attempt that kept no baseline clears the earlier one", async () => {
    const { owner, scanId } = await seedInProgressScan();
    const record = (previousPackageJson: { name: string; version: string } | null) =>
      recordScanBaseline(owner.db, {
        scanId,
        organizationId: owner.organizationId,
        previousPackageJson,
      });

    await record({ name: "@org/pkg", version: "1.0.0" });
    await record(null);

    expect(await readPreviousVersion(scanId)).toBeNull();
  });

  test("never rewrites a completed scan", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, {
      persist: { previousPackageJson: { name: "@org/pkg", version: "1.0.0" } },
    });

    await recordScanBaseline(owner.db, {
      scanId,
      organizationId: owner.organizationId,
      previousPackageJson: { name: "@org/pkg", version: "0.9.0" },
    });

    expect(await readPreviousVersion(scanId)).toBe("1.0.0");
  });

  test("is scoped to the scan's organization", async () => {
    const { scanId } = await seedInProgressScan();
    const other = await seedUser();

    await recordScanBaseline(other.db, {
      scanId,
      organizationId: other.organizationId,
      previousPackageJson: { name: "@org/pkg", version: "1.0.0" },
    });

    expect(await readPreviousVersion(scanId)).toBeNull();
  });

  test("a scan that fails names no baseline", async () => {
    const { owner, scanId } = await seedInProgressScan();
    await recordScanBaseline(owner.db, {
      scanId,
      organizationId: owner.organizationId,
      previousPackageJson: { name: "@org/pkg", version: "1.0.0" },
    });

    await markScanFailed(owner.db, scanId, owner.organizationId, { message: "sandbox failed" });

    expect(await readPreviousVersion(scanId)).toBeNull();
  });
});
