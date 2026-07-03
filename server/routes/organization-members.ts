import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import {
  type InvitationRecord,
  type OrganizationMemberEntry,
  addOrganizationMember,
  findUserByEmail,
  getInvitationByTokenHash,
  getOrganizationRole,
  listOrganizationMembers,
  listPendingInvitations,
  markInvitationAccepted,
  normalizeEmail,
  removeOrganizationMember,
  revokeInvitation,
  upsertInvitation,
} from "../db/invitations";
import {
  getOrganizationName,
  getOrganizationOwnerUserId,
  getUserContact,
} from "../db/organizations";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/active-organization";
import { sanitizeAddress } from "../lib/email";
import { rateLimitResponse } from "../lib/http";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token";
import { notifyOrganizationInvite } from "../lib/notify";
import { isInvitableRole, roleCanManageMembers, type OrganizationRole } from "../lib/roles";
import type { Bindings, Variables } from "../types";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const organizationMembersRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

organizationMembersRoutes.get("/members", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const members = await listOrganizationMembers(db, organizationId);
  return c.json({ members: members.map(publicMember) });
});

organizationMembersRoutes.delete("/members/:userId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageMembers(role)) return c.json({ error: "forbidden" }, 403);

  const targetUserId = c.req.param("userId");
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (targetUserId === ownerUserId) {
    return c.json({ error: "cannot remove the organization owner" }, 400);
  }

  const removed = await removeOrganizationMember(db, organizationId, targetUserId);
  if (!removed) return c.json({ error: "not found" }, 404);

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.member_removed",
    metadata: { userId: targetUserId },
  });
  return c.json({ ok: true });
});

organizationMembersRoutes.get("/invitations", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageMembers(role)) return c.json({ error: "forbidden" }, 403);
  const invitations = await listPendingInvitations(db, organizationId);
  return c.json({ invitations: invitations.map(publicInvitation) });
});

organizationMembersRoutes.post("/invitations", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = sanitizeAddress(body.email);
  if (!email) return c.json({ error: "a valid email is required" }, 400);
  const normalizedEmail = normalizeEmail(email);
  const role: OrganizationRole = isInvitableRole(body.role) ? body.role : "member";

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role: actorRole } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageMembers(actorRole)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `organizations:invite:${organizationId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "organization invite rate limit exceeded", err);
    }
    throw err;
  }

  const existingUser = await findUserByEmail(db, normalizedEmail);
  if (existingUser) {
    const existingRole = await getOrganizationRole(db, organizationId, existingUser.id);
    if (existingRole) {
      return c.json({ error: "that user is already a member of this organization" }, 409);
    }
  }

  const { token, tokenHash } = await generateInvitationToken();
  const invitation = await upsertInvitation(db, {
    organizationId,
    email: normalizedEmail,
    role,
    tokenHash,
    invitedByUserId: session.userId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });

  const [organizationName, inviter] = await Promise.all([
    getOrganizationName(db, organizationId),
    getUserContact(db, session.userId),
  ]);
  await notifyOrganizationInvite({
    env: c.env,
    db,
    organizationId,
    organizationName: organizationName ?? "an organization",
    email: normalizedEmail,
    role,
    token,
    invitedByUserId: session.userId,
    invitedByName: inviter?.name ?? null,
  });

  return c.json({ invitation: publicInvitation(invitation) }, 201);
});

organizationMembersRoutes.delete("/invitations/:invitationId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageMembers(role)) return c.json({ error: "forbidden" }, 403);

  const invitationId = c.req.param("invitationId");
  const revoked = await revokeInvitation(db, organizationId, invitationId);
  if (!revoked) return c.json({ error: "not found" }, 404);

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.member_invitation_revoked",
    metadata: { invitationId },
  });
  return c.json({ ok: true });
});

// The accept path is deliberately NOT scoped by the active-organization header:
// an invitee is not a member yet, so the invitation token alone determines which
// org they join. The token is matched by hash and the caller must have verified
// ownership of the invited email address, so a leaked link cannot enroll a third
// party.
organizationMembersRoutes.post("/invitations/accept", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return c.json({ error: "token is required" }, 400);

  const db = createDb(c.env.DB);
  const session = c.get("authSession");

  const invitation = await getInvitationByTokenHash(db, await hashInvitationToken(token));
  if (!invitation) return c.json({ error: "invitation not found" }, 404);
  if (invitation.status !== "pending") {
    return c.json({ error: "invitation has already been used or revoked" }, 409);
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "invitation has expired" }, 410);
  }

  const contact = await getUserContact(db, session.userId);
  if (!contact?.email || normalizeEmail(contact.email) !== invitation.email) {
    return c.json({ error: "this invitation was sent to a different email address" }, 403);
  }
  if (!contact.emailVerified) {
    return c.json({ error: "verify your email address before accepting this invitation" }, 403);
  }

  const accepted = await markInvitationAccepted(db, {
    invitationId: invitation.id,
    acceptedByUserId: session.userId,
  });
  if (!accepted) {
    return c.json({ error: "invitation is no longer valid" }, 409);
  }

  await addOrganizationMember(db, {
    organizationId: invitation.organizationId,
    userId: session.userId,
    role: invitation.role,
  });
  await recordScanEvent(db, {
    organizationId: invitation.organizationId,
    actorUserId: session.userId,
    type: "organization.member_joined",
    metadata: { role: invitation.role, invitedByUserId: invitation.invitedByUserId },
  });

  return c.json({ organizationId: invitation.organizationId, role: invitation.role });
});

function publicMember(member: OrganizationMemberEntry) {
  return {
    userId: member.userId,
    email: member.email,
    name: member.name,
    role: member.role,
    isOwner: member.isOwner,
    joinedAt: member.joinedAt.toISOString(),
  };
}

function publicInvitation(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedByUserId: invitation.invitedByUserId,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    expired: invitation.expiresAt.getTime() <= Date.now(),
  };
}
