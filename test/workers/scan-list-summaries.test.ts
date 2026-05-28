import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  backfillScanListSummaries,
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
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
  return { userId, organizationId };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function fetchScans(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://test.local/api/v1/scans?filter=all", { method: "GET" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@org/denormalized", version: "1.2.3" },
    risk: "high",
    status: "complete",
    summary: {
      diff: [
        { path: "package.json", status: "modified" },
        { path: "README.md", status: "unchanged" },
        { path: "OLD.md", status: "removed" },
      ],
    },
    ai: null,
    files: [
      { path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" },
      { path: "README.md", size: 20, sha256: "b", flags: [], textSample: "docs" },
    ],
    diff: [
      { path: "package.json", status: "modified", flags: [] },
      { path: "README.md", status: "unchanged", flags: [] },
      { path: "OLD.md", status: "removed", flags: [] },
    ],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall",
        reason: "install lifecycle hook changed",
      },
    ],
    report: { version: 1, digest: "digest" },
  });
  return scanId;
}

describe("denormalized scan list summaries", () => {
  test("persistScan writes changed_file_count, finding_count, and risk_summary_json", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const db = createDb(env.DB);

    const [row] = await db
      .select({
        changedFileCount: schema.scans.changedFileCount,
        findingCount: schema.scans.findingCount,
        riskSummaryJson: schema.scans.riskSummaryJson,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    expect(row?.changedFileCount).toBe(2);
    expect(row?.findingCount).toBe(1);
    expect(row?.riskSummaryJson).toMatchObject({
      artifactRisk: "high",
      releaseFindingCount: expect.any(Number),
      contextFindingCount: expect.any(Number),
      unknownFindingCount: expect.any(Number),
    });
  });

  test("listScans renders counts and risk summary even when scan_files and scan_findings are deleted", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const db = createDb(env.DB);

    // Wipe the child evidence — the dashboard list must not depend on it.
    await db.delete(schema.scanFiles).where(eq(schema.scanFiles.scanId, scanId));
    await db.delete(schema.scanFindings).where(eq(schema.scanFindings.scanId, scanId));

    const res = await fetchScans(buildTestApp(owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scans: Array<{
        id: string;
        changedFileCount: number;
        findingCount: number;
        riskSummary: { artifactRisk: string } | null;
      }>;
    };
    const row = body.scans.find((scan) => scan.id === scanId);
    expect(row).toBeTruthy();
    expect(row?.changedFileCount).toBe(2);
    expect(row?.findingCount).toBe(1);
    expect(row?.riskSummary?.artifactRisk).toBe("high");
  });

  test("backfillScanListSummaries fills missing fields and is idempotent", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const db = createDb(env.DB);

    // Clear the denormalized fields to simulate pre-migration state.
    await db
      .update(schema.scans)
      .set({ changedFileCount: null, findingCount: null, riskSummaryJson: null })
      .where(eq(schema.scans.id, scanId));

    const first = await backfillScanListSummaries(db, {
      organizationId: owner.organizationId,
    });
    expect(first.updated).toBeGreaterThanOrEqual(1);

    const [filled] = await db
      .select({
        changedFileCount: schema.scans.changedFileCount,
        findingCount: schema.scans.findingCount,
        riskSummaryJson: schema.scans.riskSummaryJson,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);
    expect(filled?.changedFileCount).toBe(2);
    expect(filled?.findingCount).toBe(1);
    expect(filled?.riskSummaryJson).toMatchObject({ artifactRisk: "high" });

    // Re-running should be a no-op because all selected rows already have values.
    const second = await backfillScanListSummaries(db, {
      organizationId: owner.organizationId,
    });
    expect(second.scanned).toBe(0);
    expect(second.updated).toBe(0);
  });

  test("backfillScanListSummaries leaves already-completed rows unchanged", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const db = createDb(env.DB);

    const [before] = await db
      .select({
        changedFileCount: schema.scans.changedFileCount,
        findingCount: schema.scans.findingCount,
        riskSummaryJson: schema.scans.riskSummaryJson,
        updatedAt: schema.scans.updatedAt,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    const result = await backfillScanListSummaries(db, {
      organizationId: owner.organizationId,
    });
    expect(result.scanned).toBe(0);

    const [after] = await db
      .select({
        changedFileCount: schema.scans.changedFileCount,
        findingCount: schema.scans.findingCount,
        riskSummaryJson: schema.scans.riskSummaryJson,
        updatedAt: schema.scans.updatedAt,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    expect(after).toEqual(before);
  });
});
