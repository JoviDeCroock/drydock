import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
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

async function seedRateLimit(keyPrefix: string, count: number, windowMs: number) {
  const db = createDb(env.DB);
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / windowMs);
  await db.insert(schema.rateLimits).values({
    key: `${keyPrefix}:${bucket}`,
    count,
    expiresAt: new Date((bucket + 1) * windowMs),
    updatedAt: new Date(nowMs),
  });
}

async function seedCompletedPackageScan(owner: SeededUser) {
  const db = createDb(env.DB);
  const now = new Date();
  const scanId = `scan_${crypto.randomUUID()}`;
  await db.insert(schema.scans).values({
    id: scanId,
    stageId: "stage-route-versions-000001",
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageName: "@drydock/test-package",
    stagedVersion: "2.0.0",
    previousVersion: "1.0.0",
    risk: "low",
    status: "complete",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
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

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createExecutionContext();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await app.fetch(new Request(`http://test.local${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function connectValidNpmToken(owner: SeededUser, token: string) {
  const db = createDb(env.DB);
  const encrypted = await encryptNpmToken(env, token);
  await upsertNpmConnection(db, {
    organizationId: owner.organizationId,
    registryUrl: "https://registry.npmjs.org",
    label: "npm registry",
    createdByUserId: owner.userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId: owner.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
}

describe("scans route queue behavior", () => {
  test("POST /scans enqueues a token-free scan message and records the queue event", async () => {
    const owner = await seedUser();
    const token = "npm_route_queue_secret_0123456789";
    await connectValidNpmToken(owner, token);
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();

    const res = await app.fetch(
      new Request("http://test.local/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-route-queue-000001" }),
      }),
      { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { scan: { id: string; stageId: string }; queued: boolean };
    expect(body.queued).toBe(true);
    expect(body.scan.stageId).toBe("stage-route-queue-000001");

    expect(queue.send).toHaveBeenCalledTimes(1);
    const message = queue.send.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      scanId: body.scan.id,
      stageId: "stage-route-queue-000001",
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
    });
    expect(JSON.stringify(message)).not.toContain(token);
    expect(JSON.stringify(message)).not.toContain("token");
    expect(JSON.stringify(message)).not.toContain("authorization");

    const db = createDb(env.DB);
    const events = await db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.scanId, body.scan.id));
    expect(events.map((event) => event.type)).toContain("scan.queued");
  });

  test("GET /scans/:id/versions enforces rate limit before marking npm token used", async () => {
    const owner = await seedUser();
    await connectValidNpmToken(owner, "npm_versions_secret_0123456789");
    const scanId = await seedCompletedPackageScan(owner);
    await seedRateLimit(`compare-versions:${owner.userId}`, 60, 60 * 1000);

    const res = await call(buildTestApp(owner), "GET", `/api/v1/scans/${scanId}/versions`);

    expect(res.status).toBe(429);
    const [connection] = await createDb(env.DB)
      .select({ lastUsedAt: schema.npmConnections.lastUsedAt })
      .from(schema.npmConnections)
      .where(eq(schema.npmConnections.organizationId, owner.organizationId))
      .limit(1);
    expect(connection?.lastUsedAt).toBeNull();
  });

  test("POST /scans rejects client-controlled scan limits before queueing", async () => {
    const owner = await seedUser();
    await connectValidNpmToken(owner, "npm_route_limit_secret_0123456789");
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();

    const res = await app.fetch(
      new Request("http://test.local/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-route-queue-000002", maxFiles: 10 }),
      }),
      { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
