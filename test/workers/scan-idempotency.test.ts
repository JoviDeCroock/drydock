import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  claimScanForRun,
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  markScanFailed,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";

async function seedUserAndOrg() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { db, userId, organizationId };
}

async function readStatus(db: ReturnType<typeof createDb>, scanId: string) {
  const [row] = await db
    .select({ status: schema.scans.status, reportDigest: schema.scans.reportDigest })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId))
    .limit(1);
  return row;
}

const baseScan = {
  packageJson: { name: "demo", version: "1.0.0" },
  diff: [],
  files: [],
  findings: [],
  ai: null,
  summary: { ok: true },
  report: { version: 1, digest: "digest-1" },
};

describe("scan persistence idempotency", () => {
  test("claimScanForRun transitions pending → running once and refuses terminal rows", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-aaaa",
      organizationId,
      ownerUserId: userId,
    });

    expect(await claimScanForRun(db, scanId, organizationId)).toBe(true);
    expect((await readStatus(db, scanId))?.status).toBe("running");

    // Re-claiming a running scan still succeeds (same in-flight execution).
    expect(await claimScanForRun(db, scanId, organizationId)).toBe(true);

    // Complete the scan, then a redelivery must not roll it back to running.
    await persistScan(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-aaaa",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
    });
    expect((await readStatus(db, scanId))?.status).toBe("complete");

    expect(await claimScanForRun(db, scanId, organizationId)).toBe(false);
    expect((await readStatus(db, scanId))?.status).toBe("complete");
  });

  test("markScanFailed refuses to overwrite a completed scan", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-bbbb",
      organizationId,
      ownerUserId: userId,
    });
    await claimScanForRun(db, scanId, organizationId);
    await persistScan(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-bbbb",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
    });

    await markScanFailed(db, scanId, organizationId, {
      code: "scan_failed",
      message: "should be ignored",
    });

    const after = await readStatus(db, scanId);
    expect(after?.status).toBe("complete");
  });

  test("persistScan is a no-op when the scan is already terminal", async () => {
    const { db, organizationId, userId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
    });
    await claimScanForRun(db, scanId, organizationId);
    await persistScan(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
      risk: "low",
      status: "complete",
      report: { version: 1, digest: "first" },
    });

    const second = await persistScan(db, {
      ...baseScan,
      id: scanId,
      stageId: "stage-cccc",
      organizationId,
      ownerUserId: userId,
      risk: "high",
      status: "complete",
      report: { version: 1, digest: "second" },
    });

    expect(second.persisted).toBe(false);
    const final = await readStatus(db, scanId);
    expect(final?.reportDigest).toBe("first");
  });

  test("cross-organization claims and mutations are rejected", async () => {
    const ownerA = await seedUserAndOrg();
    const ownerB = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(ownerA.db, {
      id: scanId,
      stageId: "stage-dddd",
      organizationId: ownerA.organizationId,
      ownerUserId: ownerA.userId,
    });

    expect(await claimScanForRun(ownerA.db, scanId, ownerB.organizationId)).toBe(false);
    const [scanRow] = await ownerA.db
      .select()
      .from(schema.scans)
      .where(
        and(eq(schema.scans.id, scanId), eq(schema.scans.organizationId, ownerA.organizationId)),
      )
      .limit(1);
    expect(scanRow.status).toBe("pending");
  });
});
