import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb, ensurePersonalOrganization, getNpmConnection } from "../../server/db";
import * as schema from "../../server/db/schema";
import { ACTIVE_ORG_HEADER } from "../../server/lib/active-organization";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { organizationsRoutes } from "../../server/routes/organizations";
import type { Bindings, Variables } from "../../server/types";

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
  const res = await app.fetch(new Request(`http://test.local${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("organizations routes", () => {
  test("GET / returns the caller's organizations with the personal one first", async () => {
    const owner = await seedUser();
    await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "secondary" },
    });

    const res = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<{ id: string; name: string; isPersonal: boolean }>;
    };
    expect(body.organizations).toHaveLength(2);
    expect(body.organizations[0]?.isPersonal).toBe(true);
    expect(body.organizations[0]?.id).toBe(owner.personalOrganizationId);
    expect(body.organizations[1]?.name).toBe("secondary");
  });

  test("POST / creates an org visible to the caller but not to others", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "acme-frontend" },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { organization: { id: string; name: string } };
    expect(created.organization.name).toBe("acme-frontend");

    const ownerList = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    const ownerBody = (await ownerList.json()) as {
      organizations: Array<{ id: string; name: string }>;
    };
    expect(ownerBody.organizations.map((o) => o.name)).toContain("acme-frontend");

    const strangerList = await call(buildTestApp(stranger), "GET", "/api/v1/organizations");
    const strangerBody = (await strangerList.json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(strangerBody.organizations.map((o) => o.id)).not.toContain(created.organization.id);
  });

  test("POST / rejects invalid names", async () => {
    const owner = await seedUser();

    const blank = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "  " },
    });
    expect(blank.status).toBe(400);

    const garbage = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "$bad name!" },
    });
    expect(garbage.status).toBe(400);
  });

  test("PATCH /:id renames an owned org and rejects non-owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "old-name" },
    });
    const created = (await create.json()) as { organization: { id: string } };

    const rename = await call(
      buildTestApp(owner),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { body: { name: "new-name" } },
    );
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { organization: { name: string } };
    expect(renamed.organization.name).toBe("new-name");

    const intruder = await call(
      buildTestApp(stranger),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { body: { name: "hijack" } },
    );
    expect(intruder.status).toBe(404);
  });

  test("x-organization-id header scopes npm-connection writes to that org", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_personal_token_AAAAAAAA", label: "personal" },
    });

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "client-work" },
    });
    const created = (await create.json()) as { organization: { id: string } };

    const beforeWrite = await call(buildTestApp(owner), "GET", "/api/v1/npm-connection", {
      activeOrganizationId: created.organization.id,
    });
    const beforeBody = (await beforeWrite.json()) as { connection: { label: string } | null };
    expect(beforeBody.connection).toBeNull();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_client_token_BBBBBBBB", label: "client" },
      activeOrganizationId: created.organization.id,
    });

    const personalConnection = await getNpmConnection(db, owner.personalOrganizationId);
    const clientConnection = await getNpmConnection(db, created.organization.id);
    expect(personalConnection?.label).toBe("personal");
    expect(clientConnection?.label).toBe("client");
    expect(personalConnection?.tokenCiphertext).not.toBe(clientConnection?.tokenCiphertext);
  });

  test("x-organization-id pointing at a non-member org silently falls back to personal", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "owner-private" },
    });
    const created = (await create.json()) as { organization: { id: string } };

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_personal_token_CCCCCCCC", label: "owner personal" },
    });

    const res = await call(buildTestApp(stranger), "GET", "/api/v1/npm-connection", {
      activeOrganizationId: created.organization.id,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: unknown };
    expect(body.connection).toBeNull();
  });
});
