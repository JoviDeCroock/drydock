import { Hono } from "hono";
import { requireVerifiedEmail } from "../lib/auth/email-verification";
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
  removeOrganizationMemberWithApprovalReconciliation,
  revokeInvitation,
  upsertInvitation,
} from "../db/invitations";
import {
  getOrganizationApprovalPolicy,
  listReadyPendingGates,
  recordScanDecisionProductEvents,
} from "../db/scans";
import {
  getOrganizationName,
  getOrganizationOwnerUserId,
  getUserContact,
} from "../db/organizations";
import { RateLimitError, enforceRateLimit } from "../lib/platform/rate-limit";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { sanitizeAddress } from "../lib/notify/email";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../lib/platform/execution-context";
import { purgeReconciledPublicFeedCaches } from "../lib/public-feed";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import { finalizeReconciledWorkflowGateDecision } from "../lib/workflow-gate-job";
import { generateInvitationToken, hashInvitationToken } from "../lib/auth/invitation-token";
import { notifyOrganizationInvite } from "../lib/notify";
import { isInvitableRole, roleCanManageMembers, type OrganizationRole } from "../lib/auth/roles";
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

  const removal = await removeOrganizationMemberWithApprovalReconciliation(
    db,
    organizationId,
    targetUserId,
  );
  if (!removal.removed) return c.json({ error: "not found" }, 404);
  purgeReconciledPublicFeedCaches(
    optionalWorkerExecutionContext(c),
    canonicalOrigin(c),
    removal.changedScans,
  );

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
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
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
    await enforceRateLimit(c.env, {
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

  const changedScans = await addOrganizationMember(db, {
    organizationId: invitation.organizationId,
    userId: session.userId,
    role: invitation.role,
  });
  purgeReconciledPublicFeedCaches(
    optionalWorkerExecutionContext(c),
    canonicalOrigin(c),
    changedScans,
  );
  const policy = await getOrganizationApprovalPolicy(db, invitation.organizationId);
  // Ready gates come from the shared readiness query rather than from the
  // scans this join happened to change: joining is also a recovery point, so a
  // gate left ready by an earlier interrupted request is finalized here too,
  // with the fail-closed rejection already selected when a sibling package
  // carries a durable block.
  for (const gate of await listReadyPendingGates(db, invitation.organizationId)) {
    await finalizeReconciledWorkflowGateDecision(
      c.env,
      workerExecutionContext(c.executionCtx),
      db,
      {
        organizationId: invitation.organizationId,
        gateId: gate.id,
        decision: gate.decision,
        requiredApprovals: policy.required,
        trigger: "member_joined",
        reconciledByUserId: session.userId,
      },
    );
  }
  for (const scan of changedScans) {
    try {
      await recordScanEvent(db, {
        organizationId: invitation.organizationId,
        actorUserId: session.userId,
        scanId: scan.id,
        type: "scan.decided",
        metadata: {
          decision: "publish",
          reason: scan.decisionReason,
          approvedCount: scan.approvalCount,
          requiredApprovals: policy.required,
          trigger: "member_joined",
          decisionAt: scan.decidedAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      emitOperationalEvent("warn", "scan.decision_bookkeeping_failed", {
        organizationId: invitation.organizationId,
        scanId: scan.id,
        decision: "publish",
        trigger: "member_joined",
        error: describeOperationalError(err),
      });
    }
    recordScanDecisionProductEvents(c.env, scan, {
      organizationId: invitation.organizationId,
      decision: "publish",
      ecosystem: scan.source === "workflow_gate" ? "gate" : "npm",
      approvalCount: scan.approvalCount,
      requiredApprovals: policy.required,
      now: scan.decidedAt ?? new Date(),
    });
  }
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
