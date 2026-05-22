import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  getNpmConnection,
  listValidNpmConnections,
  updateNpmConnectionMonitoring,
  updateNpmConnectionValidation,
} from "../../server/db";
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

  test("PATCH /npm-connection monitoring only updates the caller's connection", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "owner registry",
    });
    await call(buildTestApp(intruder), "POST", "/api/v1/npm-connection", {
      token: INTRUDER_TOKEN,
      label: "intruder registry",
    });

    const res = await call(buildTestApp(intruder), "PATCH", "/api/v1/npm-connection", {
      stagedPublishesMonitorEnabled: true,
    });
    expect(res.status).toBe(200);

    const ownerConnection = await getNpmConnection(db, owner.organizationId);
    const intruderConnection = await getNpmConnection(db, intruder.organizationId);
    expect(ownerConnection?.stagedPublishesMonitorEnabled).toBe(false);
    expect(intruderConnection?.stagedPublishesMonitorEnabled).toBe(true);
  });

  test("scheduled discovery candidates require validation and explicit monitoring opt-in", async () => {
    const passive = await seedUser();
    const monitored = await seedUser();
    const invalid = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(passive), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN,
      label: "passive registry",
    });
    await call(buildTestApp(monitored), "POST", "/api/v1/npm-connection", {
      token: INTRUDER_TOKEN,
      label: "monitored registry",
    });
    await call(buildTestApp(invalid), "POST", "/api/v1/npm-connection", {
      token: "npm_invalid_secret_token_BBBBBBB",
      label: "invalid registry",
    });

    await Promise.all([
      updateNpmConnectionValidation(db, {
        organizationId: passive.organizationId,
        validationStatus: "valid",
      }),
      updateNpmConnectionValidation(db, {
        organizationId: monitored.organizationId,
        validationStatus: "valid",
      }),
      updateNpmConnectionValidation(db, {
        organizationId: invalid.organizationId,
        validationStatus: "invalid",
      }),
      updateNpmConnectionMonitoring(db, {
        organizationId: monitored.organizationId,
        stagedPublishesMonitorEnabled: true,
      }),
      updateNpmConnectionMonitoring(db, {
        organizationId: invalid.organizationId,
        stagedPublishesMonitorEnabled: true,
      }),
    ]);

    const candidates = await listValidNpmConnections(db);
    const candidateOrgIds = new Set(candidates.map((connection) => connection.organizationId));
    expect(candidateOrgIds.has(passive.organizationId)).toBe(false);
    expect(candidateOrgIds.has(monitored.organizationId)).toBe(true);
    expect(candidateOrgIds.has(invalid.organizationId)).toBe(false);
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
