import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("POST /scans enqueues a token-free scan message and persists the scan", async () => {
    const owner = await seedUser();
    const token = "npm_route_queue_secret_0123456789";
    await connectValidNpmToken(owner, token);
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === "https://registry.npmjs.org/-/stage/stage-route-queue-000001/tarball") {
          expect((init?.headers as Record<string, string>)?.authorization).toBe(`Bearer ${token}`);
          expect((init?.headers as Record<string, string>)?.range).toBe("bytes=0-0");
          return new Response("", { status: 206 });
        }
        expect(String(url)).toBe("https://registry.npmjs.org/-/stage/stage-route-queue-000001");
        expect((init?.headers as Record<string, string>)?.authorization).toBe(`Bearer ${token}`);
        return Response.json({
          id: "stage-route-queue-000001",
          packageName: "@org/queued",
          version: "2.0.0",
        });
      }),
    );

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
    const body = (await res.json()) as {
      scan: {
        id: string;
        stageId: string;
        packageName: string | null;
        stagedVersion: string | null;
      };
      queued: boolean;
    };
    expect(body.queued).toBe(true);
    expect(body.scan.stageId).toBe("stage-route-queue-000001");
    expect(body.scan).toMatchObject({ packageName: "@org/queued", stagedVersion: "2.0.0" });

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
    const scans = await db.select().from(schema.scans).where(eq(schema.scans.id, body.scan.id));
    expect(scans).toHaveLength(1);
    expect(scans[0]?.organizationId).toBe(owner.organizationId);
  });

  test("POST /scans rejects stage ids the organization token cannot access before persisting", async () => {
    const owner = await seedUser();
    await connectValidNpmToken(owner, "npm_route_denied_secret_0123456789");
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );

    const res = await app.fetch(
      new Request("http://test.local/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-route-denied-000001" }),
      }),
      { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(403);
    expect(queue.send).not.toHaveBeenCalled();
    const db = createDb(env.DB);
    const scans = await db
      .select()
      .from(schema.scans)
      .where(eq(schema.scans.organizationId, owner.organizationId));
    expect(scans).toHaveLength(0);
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
