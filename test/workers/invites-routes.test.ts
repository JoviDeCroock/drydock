import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, ensurePersonalOrganization, getOrganizationMembership } from "../../server/db";
import * as schema from "../../server/db/schema";
import { ACTIVE_ORG_HEADER } from "../../server/lib/active-organization";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { invitesRoutes, organizationsRoutes } from "../../server/routes/organizations";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  personalOrganizationId: string;
  email: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const personalOrganizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, personalOrganizationId, email };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/organizations", organizationsRoutes);
  app.route("/api/v1/invites", invitesRoutes);
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

async function createSharedOrg(owner: SeededUser, name = "shared") {
  const res = await call(buildTestApp(owner), "POST", "/api/v1/organizations", {
    body: { name },
  });
  const body = (await res.json()) as { organization: { id: string; name: string } };
  return body.organization;
}

describe("invites routes", () => {
  test("owner creates a one-time invite link visible only to owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member", email: "teammate@example.com" } },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      invite: { id: string; status: string; role: string; email: string | null };
      token: string;
      url: string;
    };
    expect(created.invite.status).toBe("pending");
    expect(created.invite.role).toBe("member");
    expect(created.invite.email).toBe("teammate@example.com");
    expect(created.token).toMatch(/^inv_/);
    expect(created.url).toContain(encodeURIComponent(created.token));

    const ownerList = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/organizations/${org.id}/invites`,
    );
    expect(ownerList.status).toBe(200);
    const ownerBody = (await ownerList.json()) as { invites: Array<{ id: string }> };
    expect(ownerBody.invites.map((i) => i.id)).toContain(created.invite.id);

    const strangerList = await call(
      buildTestApp(stranger),
      "GET",
      `/api/v1/organizations/${org.id}/invites`,
    );
    expect(strangerList.status).toBe(404);
  });

  test("invitee preview + accept adds them as a member with the invited role", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner, "shared-team");

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string; invite: { id: string } };

    const preview = await call(
      buildTestApp(invitee),
      "GET",
      `/api/v1/invites/${encodeURIComponent(created.token)}`,
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      invite: { organizationName: string; role: string; status: string };
      viewer: { alreadyMember: boolean };
    };
    expect(previewBody.invite.organizationName).toBe("shared-team");
    expect(previewBody.invite.role).toBe("member");
    expect(previewBody.invite.status).toBe("pending");
    expect(previewBody.viewer.alreadyMember).toBe(false);

    const accept = await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );
    expect(accept.status).toBe(200);
    const acceptBody = (await accept.json()) as {
      organization: { id: string };
      role: string;
    };
    expect(acceptBody.organization.id).toBe(org.id);
    expect(acceptBody.role).toBe("member");

    const db = createDb(env.DB);
    const membership = await getOrganizationMembership(db, org.id, invitee.userId);
    expect(membership?.role).toBe("member");

    // second accept on the same token is a no-op
    const repeat = await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );
    expect(repeat.status).toBe(409);
  });

  test("revoked invites cannot be accepted", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string; invite: { id: string } };

    const revoke = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/organizations/${org.id}/invites/${created.invite.id}`,
    );
    expect(revoke.status).toBe(200);

    const accept = await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );
    expect(accept.status).toBe(409);
  });

  test("existing members cannot consume pending invite links", async () => {
    const owner = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string; invite: { id: string } };

    const preview = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/invites/${encodeURIComponent(created.token)}`,
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { viewer: { alreadyMember: boolean } };
    expect(previewBody.viewer.alreadyMember).toBe(true);

    const accept = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );
    expect(accept.status).toBe(409);

    const db = createDb(env.DB);
    const [row] = await db
      .select({ status: schema.organizationInvites.status })
      .from(schema.organizationInvites)
      .where(eq(schema.organizationInvites.id, created.invite.id))
      .limit(1);
    expect(row?.status).toBe("pending");
  });

  test("expired invites are not accepted and reported as expired in preview", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string; invite: { id: string } };

    const db = createDb(env.DB);
    await db
      .update(schema.organizationInvites)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(schema.organizationInvites.id, created.invite.id));

    const preview = await call(
      buildTestApp(invitee),
      "GET",
      `/api/v1/invites/${encodeURIComponent(created.token)}`,
    );
    const previewBody = (await preview.json()) as { invite: { status: string } };
    expect(previewBody.invite.status).toBe("expired");

    const list = await call(buildTestApp(owner), "GET", `/api/v1/organizations/${org.id}/invites`);
    const listBody = (await list.json()) as { invites: Array<{ id: string; status: string }> };
    expect(listBody.invites.find((invite) => invite.id === created.invite.id)?.status).toBe(
      "expired",
    );

    const accept = await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );
    expect(accept.status).toBe(410);
  });

  test("personal organizations cannot send invites", async () => {
    const owner = await seedUser();
    const res = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${owner.personalOrganizationId}/invites`,
      { body: { role: "member" } },
    );
    expect(res.status).toBe(400);
  });

  test("owners can remove members but cannot remove themselves", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string };
    await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );

    const membersBefore = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/organizations/${org.id}/members`,
    );
    const beforeBody = (await membersBefore.json()) as {
      members: Array<{ userId: string; role: string }>;
    };
    expect(beforeBody.members.map((m) => m.userId)).toContain(invitee.userId);

    const removeSelf = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/organizations/${org.id}/members/${owner.userId}`,
    );
    expect(removeSelf.status).toBe(400);

    const remove = await call(
      buildTestApp(owner),
      "DELETE",
      `/api/v1/organizations/${org.id}/members/${invitee.userId}`,
    );
    expect(remove.status).toBe(200);

    const db = createDb(env.DB);
    const membership = await getOrganizationMembership(db, org.id, invitee.userId);
    expect(membership).toBeNull();
  });

  test("members cannot write the npm connection but can read it", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner);

    await call(buildTestApp(owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_owner_token_AAAAAAAA", label: "owner" },
      activeOrganizationId: org.id,
    });

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string };
    await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );

    const memberRead = await call(buildTestApp(invitee), "GET", "/api/v1/npm-connection", {
      activeOrganizationId: org.id,
    });
    expect(memberRead.status).toBe(200);

    const memberWrite = await call(buildTestApp(invitee), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_member_token_BBBBBBBB", label: "intruder" },
      activeOrganizationId: org.id,
    });
    expect(memberWrite.status).toBe(403);

    const memberDelete = await call(buildTestApp(invitee), "DELETE", "/api/v1/npm-connection", {
      activeOrganizationId: org.id,
    });
    expect(memberDelete.status).toBe(403);
  });

  test("invited owners can manage organization membership and invites", async () => {
    const primaryOwner = await seedUser();
    const invitedOwner = await seedUser();
    const member = await seedUser();
    const org = await createSharedOrg(primaryOwner);

    const ownerInvite = await call(
      buildTestApp(primaryOwner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "owner" } },
    );
    const ownerInviteBody = (await ownerInvite.json()) as { token: string };
    await call(
      buildTestApp(invitedOwner),
      "POST",
      `/api/v1/invites/${encodeURIComponent(ownerInviteBody.token)}/accept`,
    );

    const createdByInvitedOwner = await call(
      buildTestApp(invitedOwner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    expect(createdByInvitedOwner.status).toBe(201);
    const memberInviteBody = (await createdByInvitedOwner.json()) as { token: string };
    await call(
      buildTestApp(member),
      "POST",
      `/api/v1/invites/${encodeURIComponent(memberInviteBody.token)}/accept`,
    );

    const invites = await call(
      buildTestApp(invitedOwner),
      "GET",
      `/api/v1/organizations/${org.id}/invites`,
    );
    expect(invites.status).toBe(200);

    const removeMember = await call(
      buildTestApp(invitedOwner),
      "DELETE",
      `/api/v1/organizations/${org.id}/members/${member.userId}`,
    );
    expect(removeMember.status).toBe(200);

    const db = createDb(env.DB);
    const removedMembership = await getOrganizationMembership(db, org.id, member.userId);
    expect(removedMembership).toBeNull();
  });

  test("invite token hash is single-use even if the row remains", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const org = await createSharedOrg(owner);

    const create = await call(
      buildTestApp(owner),
      "POST",
      `/api/v1/organizations/${org.id}/invites`,
      { body: { role: "member" } },
    );
    const created = (await create.json()) as { token: string; invite: { id: string } };

    await call(
      buildTestApp(invitee),
      "POST",
      `/api/v1/invites/${encodeURIComponent(created.token)}/accept`,
    );

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(schema.organizationInvites)
      .where(
        and(
          eq(schema.organizationInvites.id, created.invite.id),
          eq(schema.organizationInvites.acceptedByUserId, invitee.userId),
        ),
      )
      .limit(1);
    expect(row?.status).toBe("accepted");
  });
});
