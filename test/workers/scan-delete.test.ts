import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, markScanFailed } from "../../server/db/scans";
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
    name: "Delete Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function seedScan(owner: SeededUser, status: "pending" | "running" | "complete" | "failed") {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageName: "@org/delete-test",
    stagedVersion: "1.0.0",
  });
  if (status === "failed") {
    await markScanFailed(db, scanId, owner.organizationId, {
      code: "test_failure",
      message: "configured test failure",
    });
  } else if (status !== "pending") {
    await db
      .update(schema.scans)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.scans.id, scanId));
  }
  return scanId;
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

async function deleteScan(owner: SeededUser, scanId: string) {
  const ctx = createExecutionContext();
  const res = await buildTestApp(owner).fetch(
    new Request(`http://test.local/api/v1/scans/${scanId}`, { method: "DELETE" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

describe("DELETE /scans/:id", () => {
  test("deletes a failed scan, its dependent rows, and its R2 artifacts", async () => {
    const owner = await seedUser();
    const scanId = await seedScan(owner, "failed");
    const db = createDb(env.DB);
    const eventId = crypto.randomUUID();

    await db.insert(schema.scanFiles).values({
      id: crypto.randomUUID(),
      scanId,
      path: "index.js",
      status: "added",
      flagsJson: [],
    });
    await db.insert(schema.scanFindings).values({
      id: crypto.randomUUID(),
      scanId,
      severity: "high",
      file: "index.js",
      evidence: "test evidence",
      reason: "test reason",
    });
    await db.insert(schema.scanEvents).values({
      id: eventId,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      scanId,
      type: "scan.failed",
      metadataJson: { code: "test_failure" },
      createdAt: new Date(),
    });

    const artifactKey = `orgs/${safeSegment(owner.organizationId)}/scans/${safeSegment(scanId)}/v1/report.json`;
    await env.ARTIFACTS.put(artifactKey, "{}");

    const res = await deleteScan(owner, scanId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: scanId });

    expect(await db.select().from(schema.scans).where(eq(schema.scans.id, scanId))).toEqual([]);
    expect(
      await db.select().from(schema.scanFiles).where(eq(schema.scanFiles.scanId, scanId)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.scanFindings).where(eq(schema.scanFindings.scanId, scanId)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.scanEvents).where(eq(schema.scanEvents.id, eventId)),
    ).toEqual([]);
    expect(await env.ARTIFACTS.get(artifactKey)).toBeNull();

    const [audit] = await db
      .select()
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "scan.deleted"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: owner.userId,
      scanId: null,
      metadataJson: { scanId, status: "failed", source: "manual" },
    });
  });

  test.each(["pending", "running", "complete"] as const)(
    "rejects a %s scan and leaves it intact",
    async (status) => {
      const owner = await seedUser();
      const scanId = await seedScan(owner, status);

      const res = await deleteScan(owner, scanId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "only failed scans can be deleted" });

      const [scan] = await createDb(env.DB)
        .select({ status: schema.scans.status })
        .from(schema.scans)
        .where(eq(schema.scans.id, scanId));
      expect(scan?.status).toBe(status);
    },
  );

  test("returns not found for a failed scan in another organization", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedScan(owner, "failed");

    const res = await deleteScan(intruder, scanId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });

    const [scan] = await createDb(env.DB)
      .select({ status: schema.scans.status })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId));
    expect(scan?.status).toBe("failed");
  });
});
