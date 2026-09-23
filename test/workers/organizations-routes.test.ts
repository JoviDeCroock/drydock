import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember, getOrganizationRole } from "../../server/db/invitations";
import { getNpmConnection } from "../../server/db/npm-connections";
import {
  listNotificationRecipients,
  resolveNotificationEmails,
} from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { organizationsRoutes } from "../../server/routes/organizations";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";

const mountOrganizations = (app: TestApp) => {
  app.route("/api/v1/organizations", organizationsRoutes);
  app.route("/api/v1/npm-connection", npmConnectionRoutes);
};

async function readReleasePolicy(
  session: { userId: string },
  orgId: string,
): Promise<boolean | undefined> {
  const list = await call(
    buildTestApp(mountOrganizations, session),
    "GET",
    "/api/v1/organizations",
  );
  return (
    (await list.json()) as {
      organizations: Array<{ id: string; requireTwoFactorForReleaseDecisions: boolean }>;
    }
  ).organizations.find((o) => o.id === orgId)?.requireTwoFactorForReleaseDecisions;
}

// Flip Better Auth's enrollment flag directly. The stub harness has no real
// `auth` to run TOTP enrollment through, but enabling the policy only checks
// enrollment (no fresh code), so the column is all these specs need.
async function setEnrolledInTwoFactor(userId: string, enabled: boolean): Promise<void> {
  await createDb(env.DB)
    .update(schema.user)
    .set({ twoFactorEnabled: enabled })
    .where(eq(schema.user.id, userId));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("organizations routes", () => {
  test("GET / returns the caller's organizations with the personal one first", async () => {
    const owner = await seedUser();
    await call(buildTestApp(mountOrganizations, owner), "POST", "/api/v1/organizations", {
      body: { name: "secondary" },
    });

    const res = await call(buildTestApp(mountOrganizations, owner), "GET", "/api/v1/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<{ id: string; name: string; isPersonal: boolean }>;
    };
    expect(body.organizations).toHaveLength(2);
    expect(body.organizations[0]?.isPersonal).toBe(true);
    expect(body.organizations[0]?.id).toBe(owner.organizationId);
    expect(body.organizations[1]?.name).toBe("secondary");
  });

  test("POST / creates an org visible to the caller but not to others", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "acme-frontend" },
      },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { organization: { id: string; name: string } };
    expect(created.organization.name).toBe("acme-frontend");

    const ownerList = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      "/api/v1/organizations",
    );
    const ownerBody = (await ownerList.json()) as {
      organizations: Array<{ id: string; name: string }>;
    };
    expect(ownerBody.organizations.map((o) => o.name)).toContain("acme-frontend");

    const strangerList = await call(
      buildTestApp(mountOrganizations, stranger),
      "GET",
      "/api/v1/organizations",
    );
    const strangerBody = (await strangerList.json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(strangerBody.organizations.map((o) => o.id)).not.toContain(created.organization.id);
  });

  test("POST / rejects invalid names", async () => {
    const owner = await seedUser();

    const blank = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "  " },
      },
    );
    expect(blank.status).toBe(400);

    const garbage = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "$bad name!" },
      },
    );
    expect(garbage.status).toBe(400);
  });

  test("PATCH /:id renames an owned org and rejects non-owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "old-name" },
      },
    );
    const created = (await create.json()) as { organization: { id: string } };

    const rename = await call(
      buildTestApp(mountOrganizations, owner),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { body: { name: "new-name" } },
    );
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { organization: { name: string } };
    expect(renamed.organization.name).toBe("new-name");

    const intruder = await call(
      buildTestApp(mountOrganizations, stranger),
      "PATCH",
      `/api/v1/organizations/${created.organization.id}`,
      { body: { name: "hijack" } },
    );
    expect(intruder.status).toBe(404);
  });

  test("PUT /:id/release-two-factor requires the owner to be enrolled before enabling", async () => {
    const owner = await seedUser();
    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "secure-org" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;
    expect(await readReleasePolicy(owner, orgId)).toBe(false);

    // An owner who has not turned on 2FA themselves cannot mandate it for everyone.
    const blocked = await call(
      buildTestApp(mountOrganizations, owner),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: true } },
    );
    expect(blocked.status).toBe(403);
    expect((await blocked.json()) as unknown).toMatchObject({
      code: "two_factor_enrollment_required",
    });
    expect(await readReleasePolicy(owner, orgId)).toBe(false);

    // Once enrolled, enabling only hardens the gate, so it needs no fresh code.
    await setEnrolledInTwoFactor(owner.userId, true);
    const enable = await call(
      buildTestApp(mountOrganizations, owner),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: true } },
    );
    expect(enable.status).toBe(200);
    expect((await enable.json()) as unknown).toMatchObject({
      requireTwoFactorForReleaseDecisions: true,
    });
    expect(await readReleasePolicy(owner, orgId)).toBe(true);
  });

  test("PUT /:id/release-two-factor refuses to relax the policy without a fresh code", async () => {
    const owner = await seedUser();
    await setEnrolledInTwoFactor(owner.userId, true);
    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "hardened-org" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    const enable = await call(
      buildTestApp(mountOrganizations, owner),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: true } },
    );
    expect(enable.status).toBe(200);

    // Relaxing the policy is the security-weakening direction: a live session is
    // not enough, the route demands a fresh second factor (verified for real in
    // the worker e2e specs). Without a code it stops at `two_factor_required` and
    // the policy stays on.
    const disable = await call(
      buildTestApp(mountOrganizations, owner),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: false } },
    );
    expect(disable.status).toBe(401);
    expect((await disable.json()) as unknown).toMatchObject({ code: "two_factor_required" });
    expect(await readReleasePolicy(owner, orgId)).toBe(true);
  });

  test("PUT /:id/release-two-factor is owner-only (admins and strangers get 404)", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const stranger = await seedUser();
    const db = createDb(env.DB);

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "owner-only-org" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;
    await addOrganizationMember(db, { organizationId: orgId, userId: admin.userId, role: "admin" });

    const asAdmin = await call(
      buildTestApp(mountOrganizations, admin),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: true } },
    );
    expect(asAdmin.status).toBe(404);

    const asStranger = await call(
      buildTestApp(mountOrganizations, stranger),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: true } },
    );
    expect(asStranger.status).toBe(404);

    // The policy was never flipped by the rejected callers.
    const list = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      "/api/v1/organizations",
    );
    const org = (
      (await list.json()) as {
        organizations: Array<{ id: string; requireTwoFactorForReleaseDecisions: boolean }>;
      }
    ).organizations.find((o) => o.id === orgId);
    expect(org?.requireTwoFactorForReleaseDecisions).toBe(false);
  });

  test("PUT /:id/release-two-factor rejects a non-boolean body", async () => {
    const owner = await seedUser();
    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "validate-org" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    const res = await call(
      buildTestApp(mountOrganizations, owner),
      "PUT",
      `/api/v1/organizations/${orgId}/release-two-factor`,
      { body: { enabled: "yes" } },
    );
    expect(res.status).toBe(400);
  });

  test("x-organization-id header scopes npm-connection writes to that org", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(mountOrganizations, owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_personal_token_AAAAAAAA", label: "personal" },
    });

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "client-work" },
      },
    );
    const created = (await create.json()) as { organization: { id: string } };

    const beforeWrite = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      "/api/v1/npm-connection",
      {
        activeOrganizationId: created.organization.id,
      },
    );
    const beforeBody = (await beforeWrite.json()) as { connection: { label: string } | null };
    expect(beforeBody.connection).toBeNull();

    await call(buildTestApp(mountOrganizations, owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_client_token_BBBBBBBB", label: "client" },
      activeOrganizationId: created.organization.id,
    });

    const personalConnection = await getNpmConnection(db, owner.organizationId);
    const clientConnection = await getNpmConnection(db, created.organization.id);
    expect(personalConnection?.label).toBe("personal");
    expect(clientConnection?.label).toBe("client");
    expect(personalConnection?.tokenCiphertext).not.toBe(clientConnection?.tokenCiphertext);
  });

  test("x-organization-id pointing at a non-member org silently falls back to personal", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "owner-private" },
      },
    );
    const created = (await create.json()) as { organization: { id: string } };

    await call(buildTestApp(mountOrganizations, owner), "POST", "/api/v1/npm-connection", {
      body: { token: "npm_personal_token_CCCCCCCC", label: "owner personal" },
    });

    const res = await call(
      buildTestApp(mountOrganizations, stranger),
      "GET",
      "/api/v1/npm-connection",
      {
        activeOrganizationId: created.organization.id,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: unknown };
    expect(body.connection).toBeNull();
  });
});

describe("organization notification recipients", () => {
  test("lists, adds (lowercased), and the list is scoped to the owner", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const orgId = owner.organizationId;

    const empty = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { recipients: unknown[] }).recipients).toHaveLength(0);

    const add = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "Security@Example.com" } },
    );
    expect(add.status).toBe(201);
    const added = (await add.json()) as { recipient: { id: string; email: string } };
    expect(added.recipient.email).toBe("security@example.com");

    const listed = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    const listedBody = (await listed.json()) as { recipients: Array<{ email: string }> };
    expect(listedBody.recipients.map((r) => r.email)).toEqual(["security@example.com"]);

    const intruder = await call(
      buildTestApp(mountOrganizations, stranger),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(intruder.status).toBe(404);
  });

  test("rejects invalid emails and is idempotent on duplicates", async () => {
    const owner = await seedUser();
    const orgId = owner.organizationId;

    const bad = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "not-an-email" } },
    );
    expect(bad.status).toBe(400);

    const first = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "dupe@example.com" } },
    );
    expect(first.status).toBe(201);

    const second = await call(
      buildTestApp(mountOrganizations, owner),
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
    const orgId = owner.organizationId;

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
      buildTestApp(mountOrganizations, admin),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "reviewers@example.com" } },
    );
    expect(add.status).toBe(201);
    const recipientId = ((await add.json()) as { recipient: { id: string } }).recipient.id;

    const listed = await call(
      buildTestApp(mountOrganizations, member),
      "GET",
      `/api/v1/organizations/${orgId}/notification-recipients`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { recipients: Array<{ email: string }> };
    expect(listedBody.recipients.map((r) => r.email)).toEqual(["reviewers@example.com"]);

    const memberAdd = await call(
      buildTestApp(mountOrganizations, member),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "member-write@example.com" } },
    );
    expect(memberAdd.status).toBe(403);

    const memberRemove = await call(
      buildTestApp(mountOrganizations, member),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(memberRemove.status).toBe(403);
  });

  test("DELETE removes an owned recipient and rejects non-owners", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const orgId = owner.organizationId;

    const add = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "drop@example.com" } },
    );
    const recipientId = ((await add.json()) as { recipient: { id: string } }).recipient.id;

    const intruder = await call(
      buildTestApp(mountOrganizations, stranger),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(intruder.status).toBe(404);

    const removed = await call(
      buildTestApp(mountOrganizations, owner),
      "DELETE",
      `/api/v1/organizations/${orgId}/notification-recipients/${recipientId}`,
    );
    expect(removed.status).toBe(200);

    const db = createDb(env.DB);
    expect(await listNotificationRecipients(db, orgId)).toHaveLength(0);
  });

  test("limits notification recipients to five addresses", async () => {
    const owner = await seedUser();
    const orgId = owner.organizationId;

    for (let i = 0; i < 5; i++) {
      const add = await call(
        buildTestApp(mountOrganizations, owner),
        "POST",
        `/api/v1/organizations/${orgId}/notification-recipients`,
        { body: { email: `recipient-${i}@example.com` } },
      );
      expect(add.status).toBe(201);
    }

    const duplicate = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      { body: { email: "recipient-4@example.com" } },
    );
    expect(duplicate.status).toBe(200);
    expect(await listNotificationRecipients(createDb(env.DB), orgId)).toHaveLength(5);

    const overflow = await call(
      buildTestApp(mountOrganizations, owner),
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
    const orgId = owner.organizationId;
    const db = createDb(env.DB);

    expect(await resolveNotificationEmails(db, orgId, owner.userId)).toEqual([
      `${owner.userId}@example.com`,
    ]);

    await call(
      buildTestApp(mountOrganizations, owner),
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

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "doomed-org" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    await addOrganizationMember(db, {
      organizationId: orgId,
      userId: member.userId,
      role: "admin",
    });
    await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      `/api/v1/organizations/${orgId}/notification-recipients`,
      {
        body: { email: "alerts@example.com" },
      },
    );
    await call(buildTestApp(mountOrganizations, owner), "POST", "/api/v1/npm-connection", {
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
    await db.insert(schema.scanEvents).values({
      id: `event_${crypto.randomUUID()}`,
      organizationId: orgId,
      scanId,
      type: "scan.decided",
      createdAt: now,
    });

    const res = await call(
      buildTestApp(mountOrganizations, owner),
      "DELETE",
      `/api/v1/organizations/${orgId}`,
    );
    expect(res.status).toBe(200);

    const list = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      "/api/v1/organizations",
    );
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
      await db.select().from(schema.scanEvents).where(eq(schema.scanEvents.organizationId, orgId)),
    ).toHaveLength(0);
  });

  test("non-owners cannot delete the org", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "owner-only" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;

    const res = await call(
      buildTestApp(mountOrganizations, stranger),
      "DELETE",
      `/api/v1/organizations/${orgId}`,
    );
    expect(res.status).toBe(404);

    const list = await call(
      buildTestApp(mountOrganizations, owner),
      "GET",
      "/api/v1/organizations",
    );
    const listed = (await list.json()) as { organizations: Array<{ id: string }> };
    expect(listed.organizations.map((o) => o.id)).toContain(orgId);
  });

  test("admins cannot delete the org", async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const db = createDb(env.DB);

    const create = await call(
      buildTestApp(mountOrganizations, owner),
      "POST",
      "/api/v1/organizations",
      {
        body: { name: "admin-managed" },
      },
    );
    const orgId = ((await create.json()) as { organization: { id: string } }).organization.id;
    await addOrganizationMember(db, { organizationId: orgId, userId: admin.userId, role: "admin" });

    const res = await call(
      buildTestApp(mountOrganizations, admin),
      "DELETE",
      `/api/v1/organizations/${orgId}`,
    );
    expect(res.status).toBe(404);
  });

  test("the personal workspace cannot be deleted", async () => {
    const owner = await seedUser();

    const res = await call(
      buildTestApp(mountOrganizations, owner),
      "DELETE",
      `/api/v1/organizations/${owner.organizationId}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "personal workspaces cannot be deleted",
    });

    const db = createDb(env.DB);
    expect(await getOrganizationRole(db, owner.organizationId, owner.userId)).toBe("owner");
  });
});
