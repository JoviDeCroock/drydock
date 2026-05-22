import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb, ensurePersonalOrganization, getNpmConnection } from "../../server/db";
import * as schema from "../../server/db/schema";
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

describe("organizations routes", () => {
  test("GET / lists the personal organization on first call and auto-activates it", async () => {
    const owner = await seedUser();

    const res = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeOrganizationId: string;
      organizations: Array<{ id: string; isPersonal: boolean; isActive: boolean }>;
    };
    expect(body.activeOrganizationId).toBe(owner.personalOrganizationId);
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.isPersonal).toBe(true);
    expect(body.organizations[0]?.isActive).toBe(true);
  });

  test("POST / creates an org and lists it for the caller only", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "acme-frontend",
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

    const blank = await call(buildTestApp(owner), "POST", "/api/v1/organizations", { name: "  " });
    expect(blank.status).toBe(400);

    const garbage = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "$bad name!",
    });
    expect(garbage.status).toBe(400);
  });

  test("POST /:id/activate sets active org for the caller", async () => {
    const owner = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "second-org",
    });
    const created = (await create.json()) as { organization: { id: string } };

    const activate = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${created.organization.id}/activate`,
    );
    expect(activate.status).toBe(200);
    const activated = (await activate.json()) as { activeOrganizationId: string };
    expect(activated.activeOrganizationId).toBe(created.organization.id);

    const list = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    const body = (await list.json()) as {
      activeOrganizationId: string;
      organizations: Array<{ id: string; isActive: boolean }>;
    };
    expect(body.activeOrganizationId).toBe(created.organization.id);
    expect(body.organizations.find((o) => o.id === created.organization.id)?.isActive).toBe(true);
  });

  test("POST /:id/activate against another user's org returns 404", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "owner-only",
    });
    const created = (await create.json()) as { organization: { id: string } };

    const activate = await call(
      buildTestApp(stranger),
      "POST",
      `/api/v1/organizations/${created.organization.id}/activate`,
    );
    expect(activate.status).toBe(404);
  });

  test("PATCH /:id renames an owned org and rejects non-owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "old-name",
    });
    const created = (await create.json()) as { organization: { id: string } };

    const rename = await call(
      buildTestApp(owner),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { name: "new-name" },
    );
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { organization: { name: string } };
    expect(renamed.organization.name).toBe("new-name");

    const intruder = await call(
      buildTestApp(stranger),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { name: "hijack" },
    );
    expect(intruder.status).toBe(404);
  });

  test("npm-connection follows the active org after switching", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: "npm_personal_token_AAAAAAAA",
      label: "personal",
    });

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      name: "client-work",
    });
    const created = (await create.json()) as { organization: { id: string } };

    await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${created.organization.id}/activate`,
    );

    const beforeWrite = await call(buildTestApp(owner), "GET", "/api/v1/npm-connection");
    const beforeBody = (await beforeWrite.json()) as { connection: { label: string } | null };
    expect(beforeBody.connection).toBeNull();

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      token: "npm_client_token_BBBBBBBB",
      label: "client",
    });

    const personalConnection = await getNpmConnection(db, owner.personalOrganizationId);
    const clientConnection = await getNpmConnection(db, created.organization.id);
    expect(personalConnection?.label).toBe("personal");
    expect(clientConnection?.label).toBe("client");
    expect(personalConnection?.tokenCiphertext).not.toBe(clientConnection?.tokenCiphertext);
  });

  test("requireActiveOrganization falls back to personal when the active id is stale", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    await db
      .update(schema.user)
      .set({ activeOrganizationId: "org-that-does-not-exist", updatedAt: new Date() })
      .where(eq(schema.user.id, owner.userId));

    const list = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { activeOrganizationId: string };
    expect(body.activeOrganizationId).toBe(owner.personalOrganizationId);
  });
});
