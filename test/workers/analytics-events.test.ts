import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { ACTIVE_ORG_HEADER } from "../../server/lib/auth/active-organization";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { organizationsRoutes } from "../../server/routes/organizations";
import type { Bindings, Variables } from "../../server/types";

// End-to-end check that the funnel is actually wired: the encoder is unit-tested
// in test/analytics.test.mjs, but an event nobody emits measures nothing. These
// drive real routes with a stub dataset bound and assert both that the event
// lands and — for the surfaces that handle customer text — that the text does
// not.

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";
const WORKER_AUTH_TIMEOUT_MS = 15_000;

// Positional blob layout from lib/platform/analytics.ts. blob5 onwards are
// event-specific dimensions in declaration order.
const BLOB = { schema: 0, name: 1, organizationId: 2, ecosystem: 3, dim1: 4, dim2: 5 } as const;

interface CapturedPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

function withAnalytics(): CapturedPoint[] {
  const written: CapturedPoint[] = [];
  (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS = {
    writeDataPoint: (point: CapturedPoint) => written.push(point),
  };
  return written;
}

function eventsNamed(written: CapturedPoint[], name: string): CapturedPoint[] {
  return written.filter((point) => point.blobs[BLOB.name] === name);
}

afterEach(() => {
  delete (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS;
  vi.restoreAllMocks();
});

async function seedUser(): Promise<{ userId: string; personalOrganizationId: string }> {
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
  app.route("/api/v1/organizations", organizationsRoutes);
  app.route("/api/v1/npm-connection", npmConnectionRoutes);
  return app;
}

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  options: { body?: unknown; activeOrganizationId?: string } = {},
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.activeOrganizationId) headers[ACTIVE_ORG_HEADER] = options.activeOrganizationId;
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("product analytics wiring", () => {
  test(
    "sign-up emits user.signed_up carrying neither the email nor the user id",
    async () => {
      const written = withAnalytics();
      const email = `analytics-${crypto.randomUUID()}@example.test`;

      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${ORIGIN}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ name: "Analytics Tester", email, password: PASSWORD }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);

      const signups = eventsNamed(written, "user.signed_up");
      expect(signups).toHaveLength(1);
      expect(signups[0].blobs[BLOB.dim1]).toBe("email_password");
      // No organization exists yet (the personal workspace is created lazily),
      // and the account holder is never identified — the whole point of this
      // event is a count.
      expect(signups[0].blobs[BLOB.organizationId]).toBe("");
      expect(JSON.stringify(signups[0])).not.toContain(email);
      expect(JSON.stringify(signups[0])).not.toContain("Analytics Tester");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test("organization create emits the event and keeps the name out of it", async () => {
    const written = withAnalytics();
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const res = await call(app, "POST", "/api/v1/organizations", {
      body: { name: "Acme Confidential" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { organization: { id: string } };

    const created = eventsNamed(written, "organization.created");
    expect(created).toHaveLength(1);
    expect(created[0].blobs[BLOB.organizationId]).toBe(body.organization.id);
    expect(JSON.stringify(created[0])).not.toContain("Acme Confidential");
    expect(JSON.stringify(created[0])).not.toContain(userId);
  });

  test("npm activation emits once, on the validation that first succeeds", async () => {
    const written = withAnalytics();
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const saved = await call(app, "POST", "/api/v1/npm-connection", {
      body: { token: "npm_analytics_token_AAAAAAAA" },
    });
    expect(saved.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url.endsWith("/-/whoami")) {
        return Response.json({ username: "analytics-tester" });
      }
      return Response.json({ objects: [] });
    });

    const validated = await call(app, "POST", "/api/v1/npm-connection/validate", { body: {} });
    expect(validated.status).toBe(200);
    const revalidated = await call(app, "POST", "/api/v1/npm-connection/validate", { body: {} });
    expect(revalidated.status).toBe(200);

    // Activation fires once; health keeps firing. Conflating them would make
    // the signup -> connected step of the funnel grow every time a token is
    // rechecked.
    const connected = eventsNamed(written, "integration.connected");
    expect(connected).toHaveLength(1);
    expect(connected[0].blobs[BLOB.ecosystem]).toBe("npm");
    expect(connected[0].blobs[BLOB.dim1]).toBe("ok");
    expect(eventsNamed(written, "npm_connection.validated")).toHaveLength(2);
  });

  test("invalid npm credentials do not emit integration.connected", async () => {
    const written = withAnalytics();
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const saved = await call(app, "POST", "/api/v1/npm-connection", {
      body: { token: "npm_invalid_token_BBBBBBBB" },
    });
    expect(saved.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "invalid token" }, { status: 401 }),
    );

    const validated = await call(app, "POST", "/api/v1/npm-connection/validate", { body: {} });
    expect(validated.status).toBe(200);
    expect(eventsNamed(written, "integration.connected")).toHaveLength(0);
    expect(eventsNamed(written, "npm_connection.validated")).toHaveLength(1);
  });

  test("a rejected request emits nothing", async () => {
    const written = withAnalytics();
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const res = await call(app, "POST", "/api/v1/organizations", { body: { name: "" } });
    expect(res.status).toBe(400);
    expect(written).toHaveLength(0);
  });

  test("a failing dataset does not fail the request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS = {
      writeDataPoint: () => {
        throw new Error("dataset unavailable");
      },
    };
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const res = await call(app, "POST", "/api/v1/organizations", { body: { name: "Still Works" } });
    expect(res.status).toBe(201);
  });

  test("an unbound dataset leaves every route working", async () => {
    delete (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS;
    const { userId } = await seedUser();
    const app = buildTestApp({ userId });

    const res = await call(app, "POST", "/api/v1/organizations", {
      body: { name: "No Telemetry" },
    });
    expect(res.status).toBe(201);
  });
});
