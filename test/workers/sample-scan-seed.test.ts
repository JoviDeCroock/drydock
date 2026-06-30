import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  getScan,
  listScans,
  recordScanDecision,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { personalOrganizationId } from "../../server/lib/ownership";
import { resolvePersonalOrganization } from "../../server/lib/personal-organization";
import { sampleScanId } from "../../server/lib/sample-scan";

async function seedUser(userId: string) {
  const db = createDb(env.DB);
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return db;
}

describe("sample scan seeding", () => {
  test("seeds one realistic scan when the personal org is first resolved", async () => {
    const userId = `user_${crypto.randomUUID()}`;
    const db = await seedUser(userId);

    const organizationId = await resolvePersonalOrganization(db, { userId }, env);
    expect(organizationId).toBe(personalOrganizationId(userId));

    const scans = await listScans(db, organizationId, { decisionFilter: "all" });
    expect(scans.scans).toHaveLength(1);

    const scanId = sampleScanId(organizationId);
    const scanDetail = await getScan(db, scanId, organizationId, env.ARTIFACTS);
    expect(scanDetail).not.toBeNull();
    expect(scanDetail?.scan.status).toBe("complete");
    expect(scanDetail?.scan.source).toBe("manual");
    expect(scanDetail?.scan.decision).toBeNull();
    expect(scanDetail?.scan.findingCount).toBeGreaterThan(0);
    expect(scanDetail?.scan.risk).not.toBe("unknown");
    expect(scanDetail?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["package.json", "lib/collect.js"]),
    );
    expect(scanDetail?.findings.length).toBeGreaterThan(0);
  });

  test("records and preserves a normal publish decision", async () => {
    const userId = `user_${crypto.randomUUID()}`;
    const db = await seedUser(userId);

    const organizationId = await resolvePersonalOrganization(db, { userId }, env);
    const scanId = sampleScanId(organizationId);

    const result = await recordScanDecision(
      db,
      {
        scanId,
        organizationId,
        actorUserId: userId,
        decision: "publish",
        reason: "looks good",
      },
      env.ARTIFACTS,
    );

    expect(result?.scan.decision).toBe("publish");
    expect(result?.scan.decisionReason).toBe("looks good");

    const scanDetail = await getScan(db, scanId, organizationId, env.ARTIFACTS);
    expect(scanDetail?.scan.decision).toBe("publish");
    expect(scanDetail?.scan.decisionReason).toBe("looks good");
  });

  test("is idempotent across repeated personal-org resolution", async () => {
    const userId = `user_${crypto.randomUUID()}`;
    const db = await seedUser(userId);

    const firstOrganizationId = await resolvePersonalOrganization(db, { userId }, env);
    const secondOrganizationId = await resolvePersonalOrganization(db, { userId }, env);

    expect(secondOrganizationId).toBe(firstOrganizationId);
    const scans = await listScans(db, firstOrganizationId, { decisionFilter: "all" });
    expect(scans.scans).toHaveLength(1);
  });

  test("plain personal-org creation still stays unseeded", async () => {
    const userId = `user_${crypto.randomUUID()}`;
    const db = await seedUser(userId);

    const organizationId = await ensurePersonalOrganization(db, { userId });
    expect(organizationId).toBe(personalOrganizationId(userId));

    const scans = await listScans(db, organizationId, { decisionFilter: "all" });
    expect(scans.scans).toHaveLength(0);
  });
});
