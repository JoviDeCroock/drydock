import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { getScanOverview, type ScanSource } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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
    name: "Overview Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

interface SeedScan {
  source?: ScanSource;
  status?: "pending" | "running" | "complete" | "failed";
  decision?: "publish" | "no_publish" | null;
  decidedAt?: Date | null;
  completedAt?: Date | null;
  createdAt?: Date;
  registryVersionStatus?: string | null;
  registryStatusSupersededAt?: Date | null;
  errorJson?: unknown;
}

async function seedScan(owner: SeededUser, input: SeedScan = {}) {
  const db = createDb(env.DB);
  const id = `scan_${crypto.randomUUID()}`;
  const createdAt = input.createdAt ?? new Date(NOW.getTime() - HOUR_MS);
  const status = input.status ?? "complete";
  await db.insert(schema.scans).values({
    id,
    stageId: `stage-${id.slice(-12)}`,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageName: "@drydock/overview",
    stagedVersion: "1.0.0",
    risk: "low",
    status,
    source: input.source ?? "manual",
    decision: input.decision ?? null,
    decidedAt: input.decidedAt ?? null,
    decidedByUserId: input.decision ? owner.userId : null,
    errorJson: input.errorJson ?? null,
    registryVersionStatus: input.registryVersionStatus ?? null,
    registryVersionStatusAt: input.registryVersionStatus ? createdAt : null,
    registryStatusSupersededAt: input.registryStatusSupersededAt ?? null,
    completedAt:
      input.completedAt === undefined
        ? status === "complete"
          ? createdAt
          : null
        : input.completedAt,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

function overview(owner: SeededUser) {
  return getScanOverview(createDb(env.DB), owner.organizationId, { now: NOW });
}

describe("getScanOverview", () => {
  test("reports an empty organization without inventing figures", async () => {
    const owner = await seedUser();
    expect(await overview(owner)).toEqual({
      totalScans: 0,
      windowDays: 30,
      waiting: { count: 0, oldestCompletedAt: null },
      validating: { count: 0, reviewReady: 0 },
      publishedWithoutDecision: { count: 0 },
      decided: { count: 0, approved: 0, rejected: 0, medianDecisionMs: null },
    });
  });

  test("counts only the organization's own scans", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    await seedScan(owner, { registryVersionStatus: "staged" });
    await seedScan(other, { registryVersionStatus: "staged" });
    await seedScan(other, { registryVersionStatus: "validating" });
    await seedScan(other, { registryVersionStatus: "published" });
    await seedScan(other, { decision: "publish", decidedAt: NOW });

    const result = await overview(owner);
    expect(result.totalScans).toBe(1);
    expect(result.waiting.count).toBe(1);
    expect(result.validating.count).toBe(0);
    expect(result.publishedWithoutDecision.count).toBe(0);
    expect(result.decided.count).toBe(0);
  });

  test("waiting counts completed undecided npm reviews whose stage has not settled", async () => {
    const owner = await seedUser();
    const oldest = new Date(NOW.getTime() - 3 * DAY_MS);
    await seedScan(owner, { registryVersionStatus: null, completedAt: oldest, createdAt: oldest });
    await seedScan(owner, { registryVersionStatus: "staged" });
    await seedScan(owner, { registryVersionStatus: "validating" });
    // None of these are waiting on a reviewer.
    await seedScan(owner, { registryVersionStatus: "published" });
    await seedScan(owner, { registryVersionStatus: "blocked" });
    await seedScan(owner, { registryVersionStatus: "staged", decision: "publish", decidedAt: NOW });
    await seedScan(owner, { registryVersionStatus: "staged", status: "running" });
    await seedScan(owner, { registryVersionStatus: "staged", status: "failed" });
    await seedScan(owner, { registryVersionStatus: "staged", registryStatusSupersededAt: NOW });
    await seedScan(owner, { source: "workflow_gate" });
    await seedScan(owner, { source: "published" });

    const result = await overview(owner);
    expect(result.totalScans).toBe(11);
    expect(result.waiting).toEqual({ count: 3, oldestCompletedAt: oldest.toISOString() });
  });

  test("validating counts npm reviews still under npm's scan and how many Drydock has finished", async () => {
    const owner = await seedUser();
    await seedScan(owner, { registryVersionStatus: "validating" });
    await seedScan(owner, { registryVersionStatus: "validating", status: "running" });
    await seedScan(owner, {
      registryVersionStatus: "validating",
      decision: "publish",
      decidedAt: NOW,
    });
    await seedScan(owner, { registryVersionStatus: "validating", registryStatusSupersededAt: NOW });
    await seedScan(owner, { registryVersionStatus: "validating", source: "workflow_gate" });
    await seedScan(owner, { registryVersionStatus: "staged" });

    const result = await overview(owner);
    expect(result.validating).toEqual({ count: 3, reviewReady: 2 });
  });

  test("published without decision mirrors the list filter inside the window", async () => {
    const owner = await seedUser();
    const insideWindow = new Date(NOW.getTime() - 29 * DAY_MS - 23 * HOUR_MS);
    const outsideWindow = new Date(NOW.getTime() - 30 * DAY_MS - HOUR_MS);
    await seedScan(owner, { registryVersionStatus: "published", createdAt: insideWindow });
    await seedScan(owner, { registryVersionStatus: "deleted" });
    await seedScan(owner, {
      status: "failed",
      errorJson: { code: "staged_release_published" },
    });
    // Excluded: decided, blocked, outside the window, superseded, non-npm sources.
    await seedScan(owner, {
      registryVersionStatus: "published",
      decision: "publish",
      decidedAt: NOW,
    });
    await seedScan(owner, { registryVersionStatus: "blocked" });
    await seedScan(owner, { registryVersionStatus: "published", createdAt: outsideWindow });
    await seedScan(owner, { registryVersionStatus: "published", registryStatusSupersededAt: NOW });
    await seedScan(owner, { registryVersionStatus: "published", source: "workflow_gate" });
    await seedScan(owner, { registryVersionStatus: "published", source: "published" });

    const result = await overview(owner);
    expect(result.publishedWithoutDecision.count).toBe(3);
  });

  test("decided splits the window by verdict and reports the median decision time", async () => {
    const owner = await seedUser();
    const completed = new Date(NOW.getTime() - 5 * DAY_MS);
    const decide = (decision: "publish" | "no_publish", afterMs: number) =>
      seedScan(owner, {
        decision,
        completedAt: completed,
        decidedAt: new Date(completed.getTime() + afterMs),
      });
    await decide("publish", 10 * 60 * 1000);
    await decide("publish", 30 * 60 * 1000);
    await decide("no_publish", 4 * HOUR_MS);
    // Just inside the window.
    await seedScan(owner, {
      decision: "publish",
      completedAt: new Date(NOW.getTime() - 31 * DAY_MS),
      decidedAt: new Date(NOW.getTime() - 30 * DAY_MS + HOUR_MS),
    });
    // Just outside the window.
    await seedScan(owner, {
      decision: "no_publish",
      completedAt: new Date(NOW.getTime() - 31 * DAY_MS),
      decidedAt: new Date(NOW.getTime() - 30 * DAY_MS - HOUR_MS),
    });
    await seedScan(owner, { registryVersionStatus: "staged" });

    const result = await overview(owner);
    expect(result.decided.count).toBe(4);
    expect(result.decided.approved).toBe(3);
    expect(result.decided.rejected).toBe(1);
    // Deltas: 10m, 30m, 4h, 1d1h → median of the middle pair (30m, 4h).
    expect(result.decided.medianDecisionMs).toBe((30 * 60 * 1000 + 4 * HOUR_MS) / 2);
  });

  test("median over an odd number of decisions is the middle value", async () => {
    const owner = await seedUser();
    const completed = new Date(NOW.getTime() - DAY_MS);
    for (const afterMs of [HOUR_MS, 3 * HOUR_MS, 9 * HOUR_MS]) {
      await seedScan(owner, {
        decision: "publish",
        completedAt: completed,
        decidedAt: new Date(completed.getTime() + afterMs),
      });
    }
    // A decision on a row with no completion timestamp counts but cannot time.
    await seedScan(owner, { decision: "no_publish", decidedAt: NOW, completedAt: null });

    const result = await overview(owner);
    expect(result.decided.count).toBe(4);
    expect(result.decided.medianDecisionMs).toBe(3 * HOUR_MS);
  });
});

describe("GET /api/v1/scans/overview", () => {
  function buildTestApp(session: { userId: string }) {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/scans", scansRoutes);
    return app;
  }

  test("returns the active organization's overview", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    await seedScan(owner, { registryVersionStatus: "validating" });
    await seedScan(other, { registryVersionStatus: "validating" });

    const ctx = createExecutionContext();
    const res = await buildTestApp(owner).fetch(
      new Request("http://test.local/api/v1/scans/overview"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalScans: number; validating: { count: number } };
    expect(body.totalScans).toBe(1);
    expect(body.validating.count).toBe(1);
  });
});
