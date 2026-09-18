import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  addOrganizationMember,
  getOrganizationRole,
  listPendingInvitations,
  upsertInvitation,
} from "../../server/db/invitations";
import { generateInvitationToken } from "../../server/lib/auth/invitation-token";
import type { OrganizationRole } from "../../server/lib/auth/roles";
import { organizationMembersRoutes } from "../../server/routes/organization-members";
import { organizationsRoutes } from "../../server/routes/organizations";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { type SeededUser, seedUser } from "./helpers/seed";

const mountMembers = (app: TestApp) => {
  app.route("/api/v1/organizations", organizationsRoutes);
  app.route("/api/v1/organizations", organizationMembersRoutes);
};

async function createOrganization(owner: SeededUser, name: string): Promise<string> {
  const res = await call(buildTestApp(mountMembers, owner), "POST", "/api/v1/organizations", {
    body: { name },
  });
  const body = (await res.json()) as { organization: { id: string } };
  return body.organization.id;
}

async function seedInvitation(input: {
  owner: SeededUser;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  expiresAt?: Date;
}): Promise<{ id: string; token: string }> {
  const db = createDb(env.DB);
  const { token, tokenHash } = await generateInvitationToken();
  const invitation = await upsertInvitation(db, {
    organizationId: input.organizationId,
    email: input.email,
    role: input.role,
    tokenHash,
    invitedByUserId: input.owner.userId,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
  });
  return { id: invitation.id, token };
}

describe("organization member routes", () => {
  test("owner invites a teammate and the invite appears as pending", async () => {
    const owner = await seedUser();
    const organizationId = await createOrganization(owner, "acme");

    const invite = await call(
      buildTestApp(mountMembers, owner),
      "POST",
      "/api/v1/organizations/invitations",
      {
        body: { email: "teammate@example.com", role: "admin" },
        activeOrganizationId: organizationId,
      },
    );
    expect(invite.status).toBe(201);
    const invited = (await invite.json()) as {
      invitation: { email: string; role: string; status: string };
    };
    expect(invited.invitation.email).toBe("teammate@example.com");
    expect(invited.invitation.role).toBe("admin");

    const list = await call(
      buildTestApp(mountMembers, owner),
      "GET",
      "/api/v1/organizations/invitations",
      {
        activeOrganizationId: organizationId,
      },
    );
    const listed = (await list.json()) as { invitations: Array<{ email: string }> };
    expect(listed.invitations.map((i) => i.email)).toContain("teammate@example.com");
  });

  test("the invite response never leaks the bearer token", async () => {
    const owner = await seedUser();
    const organizationId = await createOrganization(owner, "leak-check");

    const invite = await call(
      buildTestApp(mountMembers, owner),
      "POST",
      "/api/v1/organizations/invitations",
      {
        body: { email: "teammate@example.com" },
        activeOrganizationId: organizationId,
      },
    );
    const text = await invite.text();
    expect(text).not.toContain("token");
  });

  test("a plain member cannot manage membership", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const organizationId = await createOrganization(owner, "scoped");
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: member.userId, role: "member" });

    const memberApp = buildTestApp(mountMembers, member);
    const listInvites = await call(memberApp, "GET", "/api/v1/organizations/invitations", {
      activeOrganizationId: organizationId,
    });
    expect(listInvites.status).toBe(403);

    const invite = await call(memberApp, "POST", "/api/v1/organizations/invitations", {
      body: { email: "nope@example.com" },
      activeOrganizationId: organizationId,
    });
    expect(invite.status).toBe(403);

    const remove = await call(
      memberApp,
      "DELETE",
      `/api/v1/organizations/members/${owner.userId}`,
      { activeOrganizationId: organizationId },
    );
    expect(remove.status).toBe(403);

    // A member can still read the roster.
    const members = await call(memberApp, "GET", "/api/v1/organizations/members", {
      activeOrganizationId: organizationId,
    });
    expect(members.status).toBe(200);
  });

  test("an admin can invite teammates", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const organizationId = await createOrganization(owner, "admin-org");
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: admin.userId, role: "admin" });

    const invite = await call(
      buildTestApp(mountMembers, admin),
      "POST",
      "/api/v1/organizations/invitations",
      {
        body: { email: "fromadmin@example.com" },
        activeOrganizationId: organizationId,
      },
    );
    expect(invite.status).toBe(201);
  });

  test("the invited user accepts and becomes a member with the invited role", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const organizationId = await createOrganization(owner, "join-me");
    const { token } = await seedInvitation({
      owner,
      organizationId,
      email: invitee.email,
      role: "admin",
    });

    const accept = await call(
      buildTestApp(mountMembers, invitee),
      "POST",
      "/api/v1/organizations/invitations/accept",
      { body: { token } },
    );
    expect(accept.status).toBe(200);
    const accepted = (await accept.json()) as { organizationId: string; role: string };
    expect(accepted.organizationId).toBe(organizationId);
    expect(accepted.role).toBe("admin");

    const db = createDb(env.DB);
    expect(await getOrganizationRole(db, organizationId, invitee.userId)).toBe("admin");
  });

  test("a leaked link cannot enroll a different account", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const stranger = await seedUser();
    const organizationId = await createOrganization(owner, "leak-target");
    const { token } = await seedInvitation({
      owner,
      organizationId,
      email: invitee.email,
      role: "member",
    });

    const accept = await call(
      buildTestApp(mountMembers, stranger),
      "POST",
      "/api/v1/organizations/invitations/accept",
      { body: { token } },
    );
    expect(accept.status).toBe(403);

    const db = createDb(env.DB);
    expect(await getOrganizationRole(db, organizationId, stranger.userId)).toBeNull();
  });

  test("an unverified account cannot accept an invitation for its email", async () => {
    const owner = await seedUser();
    const invitee = await seedUser({ emailVerified: false });
    const organizationId = await createOrganization(owner, "verify-first");
    const { token } = await seedInvitation({
      owner,
      organizationId,
      email: invitee.email,
      role: "admin",
    });

    const accept = await call(
      buildTestApp(mountMembers, invitee),
      "POST",
      "/api/v1/organizations/invitations/accept",
      { body: { token } },
    );
    expect(accept.status).toBe(403);
    await expect(accept.json()).resolves.toEqual({
      error: "verify your email address before accepting this invitation",
    });

    const db = createDb(env.DB);
    expect(await getOrganizationRole(db, organizationId, invitee.userId)).toBeNull();
  });

  test("an expired invitation cannot be accepted", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const organizationId = await createOrganization(owner, "expired-org");
    const { token } = await seedInvitation({
      owner,
      organizationId,
      email: invitee.email,
      role: "member",
      expiresAt: new Date(Date.now() - 1_000),
    });

    const accept = await call(
      buildTestApp(mountMembers, invitee),
      "POST",
      "/api/v1/organizations/invitations/accept",
      { body: { token } },
    );
    expect(accept.status).toBe(410);
  });

  test("revoking an invite prevents it from being accepted", async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const organizationId = await createOrganization(owner, "revoke-org");
    const { id, token } = await seedInvitation({
      owner,
      organizationId,
      email: invitee.email,
      role: "member",
    });

    const revoke = await call(
      buildTestApp(mountMembers, owner),
      "DELETE",
      `/api/v1/organizations/invitations/${id}`,
      { activeOrganizationId: organizationId },
    );
    expect(revoke.status).toBe(200);

    const db = createDb(env.DB);
    expect(await listPendingInvitations(db, organizationId)).toHaveLength(0);

    const accept = await call(
      buildTestApp(mountMembers, invitee),
      "POST",
      "/api/v1/organizations/invitations/accept",
      { body: { token } },
    );
    expect(accept.status).toBe(409);
  });

  test("owner removes a member but cannot remove the owner", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const organizationId = await createOrganization(owner, "remove-org");
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: member.userId, role: "member" });

    const removeOwner = await call(
      buildTestApp(mountMembers, owner),
      "DELETE",
      `/api/v1/organizations/members/${owner.userId}`,
      { activeOrganizationId: organizationId },
    );
    expect(removeOwner.status).toBe(400);

    const removeMember = await call(
      buildTestApp(mountMembers, owner),
      "DELETE",
      `/api/v1/organizations/members/${member.userId}`,
      { activeOrganizationId: organizationId },
    );
    expect(removeMember.status).toBe(200);
    expect(await getOrganizationRole(db, organizationId, member.userId)).toBeNull();

    const removeAgain = await call(
      buildTestApp(mountMembers, owner),
      "DELETE",
      `/api/v1/organizations/members/${member.userId}`,
      { activeOrganizationId: organizationId },
    );
    expect(removeAgain.status).toBe(404);
  });

  test("GET /members lists the owner first", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const organizationId = await createOrganization(owner, "roster");
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: member.userId, role: "member" });

    const res = await call(
      buildTestApp(mountMembers, owner),
      "GET",
      "/api/v1/organizations/members",
      {
        activeOrganizationId: organizationId,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ userId: string; isOwner: boolean; role: string }>;
    };
    expect(body.members).toHaveLength(2);
    expect(body.members[0]?.isOwner).toBe(true);
    expect(body.members[0]?.userId).toBe(owner.userId);
    expect(body.members[0]?.role).toBe("owner");
  });
});
