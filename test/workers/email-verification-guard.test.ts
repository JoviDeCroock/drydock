import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { EMAIL_VERIFICATION_REQUIRED_CODE } from "../../server/lib/auth/email-verification";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

// The guard is inert on deployments that cannot send mail, so these tests must
// supply both halves of `emailVerificationAvailable`. The pool reuses one env
// across test files, so the transport is removed again afterwards — the shared
// `BETTER_AUTH_URL` is already non-local and is left alone.
beforeEach(() => {
  (env as { SEND_EMAIL?: unknown }).SEND_EMAIL = { send: vi.fn(async () => undefined) };
});

afterEach(() => {
  delete (env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
  vi.unstubAllGlobals();
});

async function seedUser() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Unverified",
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  await ensurePersonalOrganization(db, { userId });
  return userId;
}

function buildApp(userId: string, emailVerified: boolean) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId, emailVerified });
    await next();
  });
  app.route("/api/v1/npm-connection", npmConnectionRoutes);
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
  overrides: Record<string, unknown> = {},
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("email verification guard", () => {
  test("blocks connecting an npm token until the address is verified", async () => {
    const userId = await seedUser();

    const blocked = await post(buildApp(userId, false), "/api/v1/npm-connection", {
      token: "npm_guard_token_0123456789",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: EMAIL_VERIFICATION_REQUIRED_CODE });

    // Same request, verified session: the guard is out of the way and the route
    // proceeds to its own validation instead.
    const allowed = await post(buildApp(userId, true), "/api/v1/npm-connection", { token: "" });
    expect(allowed.status).toBe(400);
  });

  test("lets an unverified account run a published-pair review", async () => {
    const userId = await seedUser();
    const packageName = `pkg-${crypto.randomUUID()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === `https://registry.npmjs.org/${packageName}`) {
          return new Response(
            JSON.stringify({
              "dist-tags": { latest: "1.1.0" },
              versions: {
                "1.0.0": { dist: { tarball: `https://registry.npmjs.org/a/-/a-1.0.0.tgz` } },
                "1.1.0": { dist: { tarball: `https://registry.npmjs.org/a/-/a-1.1.0.tgz` } },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );

    const res = await post(
      buildApp(userId, false),
      "/api/v1/scans",
      { ecosystem: "npm", packageName, version: "1.1.0" },
      { SCAN_QUEUE: { send: vi.fn(async () => undefined) } },
    );

    expect(res.status).toBe(202);
  });
});
