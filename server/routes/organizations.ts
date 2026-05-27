import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  RateLimitError,
  acceptOrganizationInvite,
  createDb,
  createOrganization,
  createOrganizationInvite,
  enforceRateLimit,
  ensurePersonalOrganization,
  getInviteByTokenHash,
  getOrganizationMembership,
  isOrganizationOwner,
  listOrganizationInvites,
  listOrganizationMembers,
  listUserOrganizations,
  recordScanEvent,
  removeOrganizationMember,
  renameOrganization,
  revokeOrganizationInvite,
} from "../db";
import { organizations as organizationsTable } from "../db/schema";
import { isPersonalOrganizationId, isOrganizationRole } from "../lib/ownership";
import {
  INVITE_DEFAULT_TTL_MS,
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  inviteTokenLast4,
} from "../lib/invites";
import type { Bindings, Variables } from "../types";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-./]{0,79}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const organizationsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

organizationsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  await ensurePersonalOrganization(db, session);
  const organizations = await listUserOrganizations(db, session.userId);
  return c.json({ organizations });
});

organizationsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "organization name is required" }, 400);
  if (!NAME_RE.test(name)) {
    return c.json(
      { error: "organization name must be 1-80 characters of letters, digits, or _-./" },
      400,
    );
  }

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    await enforceRateLimit(db, {
      key: `organizations:create:${session.userId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    const id = await createOrganization(db, { ownerUserId: session.userId, name });
    await recordScanEvent(db, {
      organizationId: id,
      actorUserId: session.userId,
      type: "organization.created",
      metadata: { name },
    });
    return c.json({ organization: { id, name } }, 201);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "organization create rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    console.error("organization create failed", err);
    return c.json({ error: "failed to create organization" }, 500);
  }
});

organizationsRoutes.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "organization name is required" }, 400);
  if (!NAME_RE.test(name)) {
    return c.json(
      { error: "organization name must be 1-80 characters of letters, digits, or _-./" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  await renameOrganization(db, organizationId, name);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.renamed",
    metadata: { name },
  });
  return c.json({ organization: { id: organizationId, name } });
});

organizationsRoutes.get("/:id/members", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const membership = await getOrganizationMembership(db, organizationId, session.userId);
  if (!membership) return c.json({ error: "not found" }, 404);
  const members = await listOrganizationMembers(db, organizationId);
  return c.json({ members, viewer: { role: membership.role } });
});

organizationsRoutes.delete("/:id/members/:userId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  if (isPersonalOrganizationId(organizationId)) {
    return c.json({ error: "personal organizations cannot have members removed" }, 400);
  }
  const members = await listOrganizationMembers(db, organizationId);
  const target = members.find((member) => member.userId === targetUserId);
  if (!target) return c.json({ error: "member not found" }, 404);
  if (target.isOwner) return c.json({ error: "cannot remove the organization owner" }, 400);
  await removeOrganizationMember(db, organizationId, targetUserId);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.member_removed",
    metadata: { userId: targetUserId },
  });
  return c.json({ ok: true });
});

organizationsRoutes.get("/:id/invites", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  const invites = await listOrganizationInvites(db, organizationId);
  return c.json({ invites });
});

organizationsRoutes.post("/:id/invites", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    role?: unknown;
    email?: unknown;
  };
  const role = isOrganizationRole(body.role) ? body.role : "member";
  const email =
    typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) {
    return c.json({ error: "invalid email" }, 400);
  }

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = c.req.param("id");
    const owner = await isOrganizationOwner(db, organizationId, session.userId);
    if (!owner) return c.json({ error: "not found" }, 404);
    if (isPersonalOrganizationId(organizationId)) {
      return c.json({ error: "personal organizations cannot send invites" }, 400);
    }
    await enforceRateLimit(db, {
      key: `organizations:invite:${organizationId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });

    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const expiresAt = new Date(Date.now() + INVITE_DEFAULT_TTL_MS);
    const invite = await createOrganizationInvite(db, {
      organizationId,
      role,
      email,
      tokenHash,
      tokenLast4: inviteTokenLast4(token),
      invitedByUserId: session.userId,
      expiresAt,
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "organization.invite_created",
      metadata: { inviteId: invite.id, role, email },
    });

    const url = buildInviteUrl(c.env.BETTER_AUTH_URL, token);
    return c.json({ invite, token, url }, 201);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "invite create rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    console.error("invite create failed", err);
    return c.json({ error: "failed to create invite" }, 500);
  }
});

organizationsRoutes.delete("/:id/invites/:inviteId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const inviteId = c.req.param("inviteId");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  const revoked = await revokeOrganizationInvite(db, inviteId, organizationId);
  if (!revoked) return c.json({ error: "invite not found or already settled" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.invite_revoked",
    metadata: { inviteId },
  });
  return c.json({ ok: true });
});

export const invitesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

invitesRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const tokenHash = await hashInviteToken(token);
  const db = createDb(c.env.DB);
  const invite = await getInviteByTokenHash(db, tokenHash);
  if (!invite) return c.json({ error: "invite not found" }, 404);

  const session = c.get("authSession");
  const expired = new Date(invite.expiresAt).getTime() <= Date.now();
  const status = expired && invite.status === "pending" ? "expired" : invite.status;

  const [organizationRow] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, invite.organizationId))
    .limit(1);
  const organizationName = organizationRow?.name ?? "organization";

  const alreadyMember = Boolean(
    await getOrganizationMembership(db, invite.organizationId, session.userId),
  );

  return c.json({
    invite: {
      id: invite.id,
      organizationId: invite.organizationId,
      organizationName,
      role: invite.role,
      email: invite.email,
      status,
      expiresAt: invite.expiresAt,
    },
    viewer: { alreadyMember },
  });
});

invitesRoutes.post("/:token/accept", async (c) => {
  const token = c.req.param("token");
  const tokenHash = await hashInviteToken(token);
  const db = createDb(c.env.DB);
  const session = c.get("authSession");

  try {
    await enforceRateLimit(db, {
      key: `invites:accept:${session.userId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "invite accept rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const invite = await getInviteByTokenHash(db, tokenHash);
  if (!invite) return c.json({ error: "invite not found" }, 404);
  if (invite.status === "expired" || new Date(invite.expiresAt).getTime() <= Date.now()) {
    return c.json({ error: "invite has expired" }, 410);
  }
  if (invite.status !== "pending") return c.json({ error: "invite is no longer pending" }, 409);

  const { accepted } = await acceptOrganizationInvite(db, { invite, userId: session.userId });
  if (!accepted) return c.json({ error: "invite is no longer pending" }, 409);

  await recordScanEvent(db, {
    organizationId: invite.organizationId,
    actorUserId: session.userId,
    type: "organization.invite_accepted",
    metadata: { inviteId: invite.id, role: invite.role },
  });
  return c.json({
    organization: { id: invite.organizationId },
    role: invite.role,
  });
});
