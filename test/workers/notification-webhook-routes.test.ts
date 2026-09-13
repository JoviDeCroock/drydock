import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember } from "../../server/db/invitations";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { getWebhookConnectionSecret } from "../../server/db/webhook-connection";
import { ACTIVE_ORG_HEADER } from "../../server/lib/auth/active-organization";
import { decryptWebhookCredentials } from "../../server/lib/notify/webhook-credentials";
import { notificationWebhookRoutes } from "../../server/routes/notification-webhook";
import type { Bindings, Variables } from "../../server/types";

const PATH = "/api/v1/notification-webhook";
const CONFIG = { url: "https://hooks.example.com/secret-path?key=hidden", secret: "a".repeat(40) };
afterEach(() => vi.restoreAllMocks());
interface SeededUser {
  userId: string;
  personalOrganizationId: string;
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
  const personalOrganizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, personalOrganizationId };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/notification-webhook", notificationWebhookRoutes);
  return app;
}

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  options: { body?: unknown; activeOrganizationId?: string; envOverride?: Partial<Bindings> } = {},
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  if (options.activeOrganizationId) {
    headers[ACTIVE_ORG_HEADER] = options.activeOrganizationId;
  }
  init.headers = headers;
  const routeEnv: Bindings = { ...(env as unknown as Bindings), ...options.envOverride };
  const res = await app.fetch(new Request(`http://test.local${path}`, init), routeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

test("stores encrypted credentials, exposes only public status, and replaces atomically", async () => {
  const owner = await seedUser();
  const app = buildTestApp(owner);
  expect(await (await call(app, "GET", PATH)).json()).toEqual({ connection: null });
  const result = await call(app, "PUT", PATH, { body: CONFIG });
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toEqual({
    connection: { hostname: "hooks.example.com", enabled: true, createdAt: expect.any(String) },
  });
  const stored = await getWebhookConnectionSecret(createDb(env.DB), owner.personalOrganizationId);
  expect(JSON.stringify(stored)).not.toContain(CONFIG.secret);
  expect(JSON.stringify(stored)).not.toContain("secret-path");
  expect(
    await decryptWebhookCredentials(env, {
      ciphertext: stored!.credentialsCiphertext,
      nonce: stored!.credentialsNonce,
    }),
  ).toEqual(CONFIG);
  await call(app, "PATCH", PATH, { body: { enabled: false } });
  const replacement = { url: "https://replacement.example.com/hook", secret: "b".repeat(40) };
  expect((await call(app, "PUT", PATH, { body: replacement })).status).toBe(200);
  expect(await (await call(app, "GET", PATH)).json()).toEqual({
    connection: {
      hostname: "replacement.example.com",
      enabled: true,
      createdAt: expect.any(String),
    },
  });
  expect((await call(app, "DELETE", PATH)).status).toBe(200);
  expect(await (await call(app, "GET", PATH)).json()).toEqual({ connection: null });
});

test("organization members can read but cannot manage or test; outsider selectors fall back to their own org", async () => {
  const owner = await seedUser();
  const member = await seedUser();
  const outsider = await seedUser();
  await call(buildTestApp(owner), "PUT", PATH, { body: CONFIG });
  await addOrganizationMember(createDb(env.DB), {
    organizationId: owner.personalOrganizationId,
    userId: member.userId,
    role: "member",
  });
  const options = { activeOrganizationId: owner.personalOrganizationId, body: CONFIG };
  expect(
    (
      await call(buildTestApp(member), "GET", PATH, {
        activeOrganizationId: owner.personalOrganizationId,
      })
    ).status,
  ).toBe(200);
  for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
    expect(
      (await call(buildTestApp(member), method, method === "POST" ? `${PATH}/test` : PATH, options))
        .status,
    ).toBe(403);
  }
  expect(
    await (
      await call(buildTestApp(outsider), "GET", PATH, {
        activeOrganizationId: owner.personalOrganizationId,
      })
    ).json(),
  ).toEqual({ connection: null });
  await call(buildTestApp(outsider), "PUT", PATH, {
    activeOrganizationId: owner.personalOrganizationId,
    body: { ...CONFIG, url: "https://outsider.example.com/hook" },
  });
  expect(await (await call(buildTestApp(owner), "GET", PATH)).json()).toEqual({
    connection: { hostname: "hooks.example.com", enabled: true, createdAt: expect.any(String) },
  });
  expect(await (await call(buildTestApp(outsider), "GET", PATH)).json()).toEqual({
    connection: { hostname: "outsider.example.com", enabled: true, createdAt: expect.any(String) },
  });
});

test("validates malformed configuration and missing connections", async () => {
  const app = buildTestApp(await seedUser());
  for (const body of [
    null,
    [],
    {},
    { ...CONFIG, secret: "short" },
    { ...CONFIG, url: "http://example.com" },
    { ...CONFIG, url: "https://127.0.0.1" },
  ]) {
    expect((await call(app, "PUT", PATH, { body })).status).toBe(400);
  }
  expect((await call(app, "PATCH", PATH, { body: null })).status).toBe(400);
  expect((await call(app, "PATCH", PATH, { body: { enabled: true } })).status).toBe(404);
  expect((await call(app, "DELETE", PATH)).status).toBe(404);
  expect((await call(app, "POST", `${PATH}/test`)).status).toBe(404);
});

test("sends a signed test even while paused and hides upstream failure details", async () => {
  const app = buildTestApp(await seedUser());
  await call(app, "PUT", PATH, { body: CONFIG });
  await call(app, "PATCH", PATH, { body: { enabled: false } });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  expect(await (await call(app, "POST", `${PATH}/test`)).json()).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledOnce();
  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toMatchObject({ version: 1, type: "notification.test" });
  expect(init?.redirect).toBe("error");
  fetchMock.mockRejectedValue(new Error(CONFIG.url + CONFIG.secret));
  const failed = await call(app, "POST", `${PATH}/test`);
  expect(await failed.json()).toEqual({ ok: false, reason: "delivery_failed" });
});

test("rate limits test delivery before contacting the endpoint", async () => {
  const owner = await seedUser();
  const app = buildTestApp(owner);
  await call(app, "PUT", PATH, { body: CONFIG });
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  await createDb(env.DB)
    .insert(schema.rateLimits)
    .values({
      key: `webhook:test:${owner.personalOrganizationId}:${bucket}`,
      count: 10,
      expiresAt: new Date((bucket + 1) * windowMs),
      updatedAt: new Date(now),
    });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  expect((await call(app, "POST", `${PATH}/test`)).status).toBe(429);
  expect(fetchMock).not.toHaveBeenCalled();
});
