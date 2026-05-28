import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { createDb, ensurePersonalOrganization, getNpmConnection } from "../../server/db";
import * as schema from "../../server/db/schema";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
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

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/npm-connection", npmConnectionRoutes);
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

const OWNER_TOKEN = "npm_owner_secret_token_AAAAAAA";
const INTRUDER_TOKEN = "npm_intruder_secret_token_ZZZZZZZ";

describe("npm-connection routes enforce organization boundaries", () => {
  test("GET /npm-connection only returns the caller's connection", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();

    const upsert = await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "owner registry",
    });
    expect(upsert.status).toBe(200);

    const intruderRes = await call(buildTestApp(intruder), "GET", "/api/v1/npm-connection");
    expect(intruderRes.status).toBe(200);
    const intruderBody = (await intruderRes.json()) as { connection: unknown };
    expect(intruderBody.connection).toBeNull();

    const ownerRes = await call(buildTestApp(owner), "GET", "/api/v1/npm-connection");
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as {
      connection: { organizationId: string; tokenLast4: string | null; label: string } | null;
    };
    expect(ownerBody.connection?.organizationId).toBe(owner.organizationId);
    expect(ownerBody.connection?.label).toBe("owner registry");
    expect(ownerBody.connection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
  });

  test("POST /npm-connection from a foreign session writes to that session's org, not the target's", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "owner registry",
    });

    const upsert = await call(buildTestApp(intruder), "POST", "/api/v1/npm-connection", {
      token: INTRUDER_TOKEN,
      label: "intruder registry",
    });
    expect(upsert.status).toBe(200);

    const ownerConnection = await getNpmConnection(db, owner.organizationId);
    const intruderConnection = await getNpmConnection(db, intruder.organizationId);
    expect(ownerConnection?.label).toBe("owner registry");
    expect(ownerConnection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
    expect(intruderConnection?.label).toBe("intruder registry");
    expect(intruderConnection?.tokenLast4).toBe(INTRUDER_TOKEN.slice(-4));
    expect(ownerConnection?.tokenCiphertext).not.toBe(intruderConnection?.tokenCiphertext);
  });

  test("POST /npm-connection enforces the save rate limit before storing credentials", async () => {
    const owner = await seedUser();
    await seedRateLimit(`npm-connection:save:${owner.organizationId}`, 20, 60 * 60 * 1000);

    const res = await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "blocked registry",
    });

    expect(res.status).toBe(429);
    expect(await getNpmConnection(createDb(env.DB), owner.organizationId)).toBeNull();
  });

  test("POST /npm-connection accepts custom registries for organization connections", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    const res = await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "custom registry",
      registryUrl: "https://registry.example.com",
    });

    expect(res.status).toBe(200);
    const connection = await getNpmConnection(db, owner.organizationId);
    expect(connection?.registryUrl).toBe("https://registry.example.com");
  });

  test("DELETE /npm-connection only removes the caller's connection", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "owner registry",
    });

    const deleteRes = await call(buildTestApp(intruder), "DELETE", "/api/v1/npm-connection");
    expect(deleteRes.status).toBe(200);

    const ownerConnection = await getNpmConnection(db, owner.organizationId);
    expect(ownerConnection).not.toBeNull();
    expect(ownerConnection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
  });

  test("POST /npm-connection/validate without a connection returns 404 and never touches the network", async () => {
    const intruder = await seedUser();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call(buildTestApp(intruder), "POST", "/api/v1/npm-connection/validate", {});
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("POST /npm-connection/validate against another org's connection still returns 404 for the foreign caller", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "owner registry",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call(buildTestApp(intruder), "POST", "/api/v1/npm-connection/validate", {});
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
