import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
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

async function eventsFor(organizationId: string) {
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
  return rows.map((row) => ({
    type: row.type,
    metadata: row.metadataJson as Record<string, unknown> | null,
  }));
}

const OWNER_TOKEN_A = "npm_audit_token_AAAAAAAAAAAAAAAA";
const OWNER_TOKEN_B = "npm_audit_token_BBBBBBBBBBBBBBBB";

describe("npm-connection audit events", () => {
  test("first save emits npm_connection.created with the new token fingerprint", async () => {
    const owner = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
    });

    const events = await eventsFor(owner.organizationId);
    const created = events.find((e) => e.type === "npm_connection.created");
    expect(created).toBeTruthy();
    expect(created?.metadata).toMatchObject({ label: "primary" });
    expect(events.find((e) => e.type === "npm_connection.rotated")).toBeUndefined();
  });

  test("second save emits npm_connection.rotated with previous fingerprint", async () => {
    const owner = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
    });
    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_B,
      label: "primary",
    });

    const events = await eventsFor(owner.organizationId);
    const rotated = events.find((e) => e.type === "npm_connection.rotated");
    expect(rotated).toBeTruthy();
    expect(rotated?.metadata).toMatchObject({
      previousValidationStatus: "unvalidated",
    });
    expect(typeof rotated?.metadata?.previousTokenFingerprint).toBe("string");
  });

  test("changing registryUrl on rotate emits npm_connection.registry_changed", async () => {
    const owner = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
      registryUrl: "https://registry.npmjs.org",
    });
    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_B,
      label: "primary",
      registryUrl: "https://custom.registry.example.com",
    });

    const events = await eventsFor(owner.organizationId);
    const changed = events.find((e) => e.type === "npm_connection.registry_changed");
    expect(changed).toBeTruthy();
    expect(changed?.metadata).toMatchObject({
      previousRegistryUrl: "https://registry.npmjs.org",
      registryUrl: "https://custom.registry.example.com",
    });
  });

  test("validation failure emits validation_failed with reasons, not validated", async () => {
    const owner = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/-/whoami")) return Response.json({ username: "user" });
        if (String(url).endsWith("/-/stage?perPage=1"))
          return new Response("denied", { status: 403 });
        return new Response("unexpected", { status: 500 });
      }),
    );
    try {
      await call(buildTestApp(owner), "POST", "/api/v1/npm-connection/validate", {});
    } finally {
      vi.unstubAllGlobals();
    }

    const events = await eventsFor(owner.organizationId);
    const failure = events.find((e) => e.type === "npm_connection.validation_failed");
    expect(failure).toBeTruthy();
    expect(failure?.metadata).toMatchObject({
      ok: false,
      status: "invalid",
    });
    const reasons = (failure?.metadata?.reasons ?? []) as string[];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons.includes("staged_list_denied")).toBe(true);
  });

  test("validation downgrade from valid emits validation_downgraded", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
    });
    await updateNpmConnectionValidation(db, {
      organizationId: owner.organizationId,
      validationStatus: "valid",
      validatedAt: new Date(),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/-/whoami")) return Response.json({ username: "user" });
        if (String(url).endsWith("/-/stage?perPage=1"))
          return new Response("denied", { status: 403 });
        return new Response("unexpected", { status: 500 });
      }),
    );
    try {
      await call(buildTestApp(owner), "POST", "/api/v1/npm-connection/validate", {});
    } finally {
      vi.unstubAllGlobals();
    }

    const events = await eventsFor(owner.organizationId);
    const downgrade = events.find((e) => e.type === "npm_connection.validation_downgraded");
    expect(downgrade).toBeTruthy();
    expect(downgrade?.metadata).toMatchObject({
      previousStatus: "valid",
      status: "invalid",
    });
  });

  test("audit metadata never contains tokenCiphertext, tokenNonce, or raw token", async () => {
    const owner = await seedUser();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_A,
      label: "primary",
    });
    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: OWNER_TOKEN_B,
      label: "primary",
    });

    const events = await eventsFor(owner.organizationId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("tokenCiphertext");
    expect(serialized).not.toContain("tokenNonce");
    expect(serialized).not.toContain(OWNER_TOKEN_A);
    expect(serialized).not.toContain(OWNER_TOKEN_B);
  });
});
