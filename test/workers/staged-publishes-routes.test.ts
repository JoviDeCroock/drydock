import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  getNpmConnection,
  listScans,
  markNpmConnectionInvalid,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import { stagedPublishesRoutes } from "../../server/routes/staged-publishes";
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
  app.route("/api/v1/staged-publishes", stagedPublishesRoutes);
  return app;
}

describe("staged publishes route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("POST /scan creates scans only for newly discovered stage ids", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
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
    await createScanJob(db, {
      id: `scan_${crypto.randomUUID()}`,
      stageId: "stage-existing-123",
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://registry.npmjs.org/-/stage?perPage=50");
        return Response.json({
          items: [
            { id: "stage-existing-123", packageName: "@org/existing", version: "1.0.0" },
            {
              id: "stage-new-123",
              packageName: "@org/new",
              version: "1.1.0",
              tag: "latest",
              actor: "maintainer",
              createdAt: "2026-05-22T12:00:00.000Z",
            },
          ],
          total: 2,
          perPage: 50,
          page: 1,
        });
      }),
    );
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://test.local/api/v1/staged-publishes/scan", { method: "POST" }),
      { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      found: number;
      created: number;
      skipped: number;
      scans: Array<{
        id: string;
        stageId: string;
        packageName: string | null;
        version: string | null;
      }>;
    };
    expect(body).toMatchObject({
      found: 2,
      created: 1,
      skipped: 1,
      scans: [{ stageId: "stage-new-123", packageName: "@org/new", version: "1.1.0" }],
    });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0]?.[0]).toMatchObject({ stageId: "stage-new-123" });
    const { scans } = await listScans(db, owner.organizationId);
    expect(scans.map((scan) => scan.stageId)).toContain("stage-new-123");
  });

  test("POST /scan invalidates the npm connection when the registry rejects the token", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://test.local/api/v1/staged-publishes/scan", { method: "POST" }),
      { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.status).toBe(401);
    expect(body.error).toContain("rotate");
    expect(queue.send).not.toHaveBeenCalled();

    const connection = await getNpmConnection(db, owner.organizationId);
    expect(connection?.validationStatus).toBe("invalid");
    expect(connection?.lastFailureReason).toContain("rejected by the registry");
    expect(connection?.invalidatedAt).toBeTruthy();
  });

  test("token-specific invalidation does not poison a rotated npm connection", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const oldEncrypted = await encryptNpmToken(env, "npm_old_token_0123456789");
    await upsertNpmConnection(db, {
      organizationId: owner.organizationId,
      registryUrl: "https://registry.npmjs.org",
      label: "old npm registry",
      createdByUserId: owner.userId,
      ...oldEncrypted,
    });
    const oldConnection = await getNpmConnection(db, owner.organizationId);
    expect(oldConnection?.tokenFingerprint).toBeTruthy();

    const newEncrypted = await encryptNpmToken(env, "npm_new_token_0123456789");
    await upsertNpmConnection(db, {
      organizationId: owner.organizationId,
      registryUrl: "https://registry.npmjs.org",
      label: "new npm registry",
      createdByUserId: owner.userId,
      ...newEncrypted,
    });
    await updateNpmConnectionValidation(db, {
      organizationId: owner.organizationId,
      validationStatus: "valid",
      validatedAt: new Date(),
    });

    const invalidated = await markNpmConnectionInvalid(db, {
      organizationId: owner.organizationId,
      tokenFingerprint: oldConnection!.tokenFingerprint,
      reason: "The organization's npm token was rejected by the registry.",
    });

    expect(invalidated).toBe(false);
    const current = await getNpmConnection(db, owner.organizationId);
    expect(current?.tokenFingerprint).toBe(newEncrypted.tokenFingerprint);
    expect(current?.validationStatus).toBe("valid");
    expect(current?.lastFailureReason).toBeNull();
    expect(current?.invalidatedAt).toBeNull();
  });
});
