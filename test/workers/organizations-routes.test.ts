import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addOrganizationMember,
  createDb,
  ensurePersonalOrganization,
  getNpmConnection,
  getOrganizationRole,
  listNotificationRecipients,
  resolveNotificationEmails,
} from "../../server/db";
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

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

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

describe("organization notification recipients", () => {
  test("lists, adds (lowercased), and the list is scoped to the owner", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const orgId = owner.personalOrganizationId;

    const empty = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { recipients: unknown[] }).recipients).toHaveLength(0);

    const add = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "Security@Example.com" } },
    );
    expect(add.status).toBe(201);
    const added = (await add.json()) as { recipient: { id: string; email: string } };
    expect(added.recipient.email).toBe("security@example.com");

    const listed = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    const listedBody = (await listed.json()) as { recipients: Array<{ email: string }> };
    expect(listedBody.recipients.map((r) => r.email)).toEqual(["security@example.com"]);

    const intruder = await call(
      buildTestApp(stranger),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(intruder.status).toBe(404);
  });

  test("rejects invalid emails and is idempotent on duplicates", async () => {
    const owner = await seedUser();
    const orgId = owner.personalOrganizationId;

    const bad = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "not-an-email" } },
    );
    expect(bad.status).toBe(400);

    const first = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "dupe@example.com" } },
    );
    expect(first.status).toBe(201);

    const second = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "dupe@example.com" } },
    );
    expect(second.status).toBe(200);

    const db = createDb(env.DB);
    expect(await listNotificationRecipients(db, orgId)).toHaveLength(1);
  });

  test("admins can manage recipients while members can only read them", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    const orgId = owner.personalOrganizationId;

    await addOrganizationMember(db, {
      organizationId: orgId,
      userId: admin.userId,
      role: "admin",
    });
    await addOrganizationMember(db, {
      organizationId: orgId,
      userId: member.userId,
      role: "member",
    });

    const add = await call(
      buildTestApp(admin),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "reviewers@example.com" } },
    );
    expect(add.status).toBe(201);
    const recipientId = ((await add.json()) as { recipient: { id: string } }).recipient.id;

    const listed = await call(
      buildTestApp(member),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { recipients: Array<{ email: string }> };
    expect(listedBody.recipients.map((r) => r.email)).toEqual(["reviewers@example.com"]);

    const memberAdd = await call(
      buildTestApp(member),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "member-write@example.com" } },
    );
    expect(memberAdd.status).toBe(403);

    const memberRemove = await call(
      buildTestApp(member),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(memberRemove.status).toBe(403);
  });

  test("DELETE removes an owned recipient and rejects non-owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const orgId = owner.personalOrganizationId;

    const add = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "drop@example.com" } },
    );
    const recipientId = ((await add.json()) as { recipient: { id: string } }).recipient.id;

    const intruder = await call(
      buildTestApp(stranger),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(intruder.status).toBe(404);

    const removed = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(removed.status).toBe(200);

    const db = createDb(env.DB);
    expect(await listNotificationRecipients(db, orgId)).toHaveLength(0);
  });

  test("limits notification recipients to five addresses", async () => {
    const owner = await seedUser();
    const orgId = owner.personalOrganizationId;

    for (let i = 0; i < 5; i++) {
      const add = await call(
        buildTestApp(owner),
        "POST",
        `/api/v1/organizations/${orgId}/notification-recipients`,
        { body: { email: `recipient-${i}@example.com` } },
      );
      expect(add.status).toBe(201);
    }

    const duplicate = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "recipient-4@example.com" } },
    );
    expect(duplicate.status).toBe(200);
    expect(await listNotificationRecipients(createDb(env.DB), orgId)).toHaveLength(5);

    const overflow = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "recipient-5@example.com" } },
    );
    expect(overflow.status).toBe(400);
    const body = (await overflow.json()) as { error: string };
    expect(body.error).toBe("at most 5 notification recipients are allowed");
  });

  test("resolveNotificationEmails falls back to the owner only when no recipients exist", async () => {
    const owner = await seedUser();
    const orgId = owner.personalOrganizationId;
    const db = createDb(env.DB);

    expect(await resolveNotificationEmails(db, orgId, owner.userId)).toEqual([
      `${owner.userId}@example.com`,
    ]);

    await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      {
        body: { email: "team@example.com" },
      },
    );

    expect(await resolveNotificationEmails(db, orgId, owner.userId)).toEqual(["team@example.com"]);
  });
});

describe("organization deletion", () => {
  test("owner deletes an org and every row scoped to it is removed", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "doomed-org" },
    });
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    await addOrganizationMember(db, {
      organizationId: orgId,
      userId: member.userId,
      role: "admin",
    });
    await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      {
        body: { email: "alerts@example.com" },
      },
    );
    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_doomed_token_AAAAAAAA", label: "doomed" },
      activeOrganizationId: orgId,
    });

    const now = new Date();
    const scanId = `scan_${crypto.randomUUID()}`;
    await db.insert(schema.scans).values({
      id: scanId,
      stageId: "stage_doomed",
      organizationId: orgId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.scanFiles).values({
      id: `file_${crypto.randomUUID()}`,
      scanId,
      path: "index.js",
      status: "added",
      flagsJson: [],
    });
    await db.insert(schema.scanFindings).values({
      id: `finding_${crypto.randomUUID()}`,
      scanId,
      severity: "high",
      file: "index.js",
      evidence: "evil()",
      reason: "suspicious",
    });
    await db.insert(schema.scanEvents).values({
      id: `event_${crypto.randomUUID()}`,
      organizationId: orgId,
      scanId,
      type: "scan.completed",
      createdAt: now,
    });

    const res = await call(buildTestApp(owner), "DELETE", `/api/v1/organizations/${orgId}`);
    expect(res.status).toBe(200);

    const list = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    const listed = (await list.json()) as { organizations: Array<{ id: string }> };
    expect(listed.organizations.map((o) => o.id)).not.toContain(orgId);

    expect(await getOrganizationRole(db, orgId, owner.userId)).toBeNull();
    expect(await getOrganizationRole(db, orgId, member.userId)).toBeNull();
    expect(await getNpmConnection(db, orgId)).toBeNull();
    expect(await listNotificationRecipients(db, orgId)).toHaveLength(0);
    expect(
      await db.select().from(schema.scans).where(eq(schema.scans.organizationId, orgId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.scanFiles).where(eq(schema.scanFiles.scanId, scanId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.scanFindings).where(eq(schema.scanFindings.scanId, scanId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.scanEvents).where(eq(schema.scanEvents.organizationId, orgId)),
    ).toHaveLength(0);
  });

  test("non-owners cannot delete the org", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "owner-only" },
    });
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    const res = await call(buildTestApp(stranger), "DELETE", `/api/v1/organizations/${orgId}`);
    expect(res.status).toBe(404);

    const list = await call(buildTestApp(owner), "GET", "/api/v1/organizations");
    const listed = (await list.json()) as { organizations: Array<{ id: string }> };
    expect(listed.organizations.map((o) => o.id)).toContain(orgId);
  });

  test("admins cannot delete the org", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const db = createDb(env.DB);

    const create = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
      body: { name: "admin-managed" },
    });
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;
    await addOrganizationMember(db, { organizationId: orgId, userId: admin.userId, role: "admin" });

    const res = await call(buildTestApp(admin), "DELETE", `/api/v1/organizations/${orgId}`);
    expect(res.status).toBe(404);
  });

  test("the personal workspace cannot be deleted", async () => {
    const owner = await seedUser();

    const res = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/organizations/${owner.personalOrganizationId}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "personal workspaces cannot be deleted",
    });

    const db = createDb(env.DB);
    expect(await getOrganizationRole(db, owner.personalOrganizationId, owner.userId)).toBe("owner");
  });
});
