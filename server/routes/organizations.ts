import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { recordProductEvent } from "../lib/platform/analytics";
import { getOrganizationRole } from "../db/invitations";
import {
  type NotificationRecipient,
  addNotificationRecipient,
  createOrganization,
  deleteNotificationRecipient,
  deleteOrganization,
  ensurePersonalOrganization,
  getUserContact,
  isOrganizationOwner,
  listNotificationRecipients,
  listUserOrganizations,
  renameOrganization,
  setRequireTwoFactorForReleaseDecisions,
} from "../db/organizations";
import {
  MAX_REQUIRED_RELEASE_APPROVALS,
  getOrganizationApprovalPolicy,
  recordScanDecisionProductEvents,
  setRequiredReleaseApprovals,
} from "../db/scans";
import { RateLimitError, enforceRateLimit } from "../lib/platform/rate-limit";
import { userHasTwoFactor, verifyTotpStepUp } from "../lib/auth";
import { sanitizeAddress } from "../lib/notify/email";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../lib/platform/execution-context";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import { purgeReconciledPublicFeedCaches } from "../lib/public-feed";
import { finalizeReconciledWorkflowGateDecision } from "../lib/workflow-gate-job";
import { personalOrganizationId } from "../lib/auth/ownership";
import { roleCanManageIntegrations, type OrganizationRole } from "../lib/auth/roles";
import type { Bindings, Variables } from "../types";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-./]{0,79}$/u;
const ORGANIZATION_NAME_ERROR =
  "organization name must be 1-80 characters of letters, digits, or _-./";
const MAX_NOTIFICATION_RECIPIENTS = 5;

export const organizationsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

organizationsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  if (!(await ensurePersonalOrganization(db, session))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const organizations = await listUserOrganizations(db, session.userId);
  return c.json({ organizations });
});

organizationsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const parsed = parseOrganizationName(body.name);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name } = parsed;

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    if (!(await getUserContact(db, session.userId))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await enforceRateLimit(c.env, {
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
    // Activation, not acquisition: an explicitly created organization means
    // someone intends to work with other people. Personal workspaces are
    // excluded — `ensurePersonalOrganization` makes one for every account on
    // first request, so counting them would restate `user.signed_up`.
    recordProductEvent(c.env, { name: "organization.created", organizationId: id });
    return c.json({ organization: { id, name } }, 201);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "organization create rate limit exceeded", err);
    }
    emitOperationalEvent("error", "organization.create_failed", {
      error: describeOperationalError(err),
    });
    return c.json({ error: "failed to create organization" }, 500);
  }
});

organizationsRoutes.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const parsed = parseOrganizationName(body.name);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name } = parsed;

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

// Enforce (or relax) the org-wide two-factor requirement for release-gate
// decisions. Owner-only — this is a security policy that binds every member, so
// it sits alongside rename/delete rather than the admin-level integration
// controls; an admin must not be able to weaken a gate the owner hardened.
//
// Changing this policy is itself a 2FA-guarded action, mirroring the gate
// decision it governs: the owner must have enrolled in 2FA before they can
// mandate it for everyone (you cannot enforce a control you have not adopted,
// and it would otherwise lock the owner out of their own release decisions), and
// *relaxing* the policy weakens a security control — so, like deciding a gate, it
// demands a fresh second factor rather than just a live session. Enabling only
// hardens, so enrollment alone is enough there; disabling additionally needs a
// fresh `totpCode`.
organizationsRoutes.put("/:id/release-two-factor", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: unknown;
    totpCode?: unknown;
  };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = body.enabled;

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);

  try {
    await enforceRateLimit(c.env, {
      key: `organizations:release-two-factor:${session.userId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "release two-factor rate limit exceeded", err);
    }
    throw err;
  }

  const ownerEnrolledInTwoFactor = await userHasTwoFactor(db, session.userId);
  if (!ownerEnrolledInTwoFactor) {
    return c.json(
      {
        error:
          "enable two-factor authentication on your account before changing the release two-factor policy",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  let twoFactorVerified = false;
  if (!enabled) {
    const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
    if (!totpCode) {
      return c.json(
        { error: "two-factor verification required", code: "two_factor_required" },
        401,
      );
    }
    if (!(await verifyTotpStepUp(c.get("auth"), c.req.raw, totpCode))) {
      return c.json({ error: "invalid two-factor code", code: "two_factor_invalid" }, 401);
    }
    twoFactorVerified = true;
  }

  await setRequireTwoFactorForReleaseDecisions(db, organizationId, enabled);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.release_two_factor_changed",
    metadata: {
      enabled,
      // Records whether a fresh step-up gated the change — true only on a relax,
      // which is the security-weakening direction worth auditing precisely.
      twoFactor: twoFactorVerified,
      twoFactorMethod: twoFactorVerified ? "totp" : null,
    },
  });
  return c.json({ requireTwoFactorForReleaseDecisions: enabled });
});

// Set how many distinct members must approve a release before it counts as
// approved. Owner-only for the same reason as the two-factor policy: it binds
// every member, and an admin must not be able to lower a bar the owner raised.
//
// The bar is capped at the org's current member count. A three-approval policy
// in a two-person org is not a stricter policy, it is a release process that
// can never complete — and the failure would surface later, as a deployment
// that silently never releases, rather than here.
organizationsRoutes.put("/:id/release-approvals", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    requiredApprovals?: unknown;
    totpCode?: unknown;
  };
  const requested = Number(body.requiredApprovals);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_REQUIRED_RELEASE_APPROVALS) {
    return c.json(
      { error: `requiredApprovals must be an integer from 1 to ${MAX_REQUIRED_RELEASE_APPROVALS}` },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);

  try {
    await enforceRateLimit(c.env, {
      key: `organizations:release-approvals:${session.userId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "release approvals rate limit exceeded", err);
    }
    throw err;
  }

  const policy = await getOrganizationApprovalPolicy(db, organizationId);
  if (requested > policy.memberCount) {
    return c.json(
      {
        error: `this organization has ${policy.memberCount} member${
          policy.memberCount === 1 ? "" : "s"
        } — invite more before requiring ${requested} approvals`,
        code: "not_enough_members",
        memberCount: policy.memberCount,
      },
      409,
    );
  }

  // Lowering the bar weakens the same release control that gate decisions
  // enforce, and can immediately release a held deployment during the
  // reconciliation below. A live owner session is therefore not enough: match
  // the release-two-factor relax path and require a fresh second factor.
  const lowering = requested < policy.required;
  let twoFactorVerified = false;
  if (lowering) {
    if (!(await userHasTwoFactor(db, session.userId))) {
      return c.json(
        {
          error:
            "enable two-factor authentication on your account before lowering required release approvals",
          code: "two_factor_enrollment_required",
        },
        403,
      );
    }
    const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
    if (!totpCode) {
      return c.json(
        { error: "two-factor verification required", code: "two_factor_required" },
        401,
      );
    }
    if (!(await verifyTotpStepUp(c.get("auth"), c.req.raw, totpCode))) {
      return c.json({ error: "invalid two-factor code", code: "two_factor_invalid" }, 401);
    }
    twoFactorVerified = true;
  }

  const reconciliation = await setRequiredReleaseApprovals(
    db,
    organizationId,
    requested,
    policy.required,
  );
  let policyChangedByThisRequest = reconciliation.applied;
  if (!reconciliation.applied) {
    const currentPolicy = await getOrganizationApprovalPolicy(db, organizationId);
    if (currentPolicy.required !== requested) {
      // A different state must be re-submitted so its live direction (and
      // therefore TOTP requirement) is evaluated again.
      return c.json(
        {
          error: "the release approval policy changed while this request was being applied",
          code: "approval_policy_changed",
          requiredApprovals: currentPolicy.required,
        },
        409,
      );
    }
    // A concurrent identical request committed the policy transaction, but it
    // may have been interrupted before finalizing a now-ready gate. Continue
    // through the idempotent CAS work below; only the policy audit belongs to
    // the request whose conditional write actually succeeded.
    policyChangedByThisRequest = false;
  }
  purgeReconciledPublicFeedCaches(
    optionalWorkerExecutionContext(c),
    canonicalOrigin(c),
    reconciliation.changedScans,
  );
  for (const readyGate of reconciliation.readyGates) {
    await finalizeReconciledWorkflowGateDecision(
      c.env,
      workerExecutionContext(c.executionCtx),
      db,
      {
        organizationId,
        gateId: readyGate.id,
        decision: readyGate.decision,
        requiredApprovals: requested,
        trigger: "approval_policy",
        reconciledByUserId: session.userId,
      },
    );
  }
  for (const scan of reconciliation.changedScans) {
    if (scan.decision !== "publish" && scan.decision !== "no_publish") continue;
    try {
      await recordScanEvent(db, {
        organizationId,
        // The vote that became decisive owns the release verdict. The owner
        // changing policy is the reconciliation trigger, recorded separately
        // here and by organization.release_approvals_changed.
        actorUserId: scan.decidedByUserId,
        scanId: scan.id,
        type: "scan.decided",
        metadata: {
          decision: scan.decision,
          reason: scan.decisionReason,
          approvedCount: scan.approvalCount,
          requiredApprovals: requested,
          trigger: "approval_policy",
          reconciledByUserId: session.userId,
          decisionAt: scan.decidedAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      emitOperationalEvent("warn", "scan.decision_bookkeeping_failed", {
        organizationId,
        scanId: scan.id,
        decision: scan.decision,
        trigger: "approval_policy",
        error: describeOperationalError(err),
      });
    }
    recordScanDecisionProductEvents(c.env, scan, {
      organizationId,
      decision: scan.decision,
      ecosystem: scan.source === "workflow_gate" ? "gate" : "npm",
      approvalCount: scan.approvalCount,
      requiredApprovals: requested,
      now: scan.decidedAt ?? new Date(),
    });
  }
  // The policy and any gate decisions above are already durable. Audit
  // bookkeeping must not strand a gate whose packages were reconciled to
  // approved, so contain it after every ready gate has been finalized and
  // scheduled for delivery.
  if (policyChangedByThisRequest) {
    try {
      await recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: "organization.release_approvals_changed",
        metadata: {
          requiredApprovals: requested,
          previousRequiredApprovals: policy.required,
          twoFactor: twoFactorVerified,
          twoFactorMethod: twoFactorVerified ? "totp" : null,
        },
      });
    } catch (err) {
      emitOperationalEvent("warn", "organization.release_approvals_bookkeeping_failed", {
        organizationId,
        requiredApprovals: requested,
        previousRequiredApprovals: policy.required,
        error: describeOperationalError(err),
      });
    }
  }
  return c.json({ requiredApprovals: requested });
});

organizationsRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");

  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  if (organizationId === personalOrganizationId(session.userId)) {
    return c.json({ error: "personal workspaces cannot be deleted" }, 400);
  }

  try {
    await enforceRateLimit(c.env, {
      key: `organizations:delete:${session.userId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "organization delete rate limit exceeded", err);
    }
    throw err;
  }

  // No scan_event is recorded: the org and its scan_events are removed together,
  // so the audit row would be deleted in the same breath. ARTIFACTS is passed so
  // the org's R2 artifacts are torn down alongside its D1 rows.
  await deleteOrganization(db, organizationId, c.env.ARTIFACTS);
  return c.json({ ok: true });
});

organizationsRoutes.get("/:id/notification-recipients", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  const recipients = await listNotificationRecipients(db, organizationId);
  return c.json({ recipients: recipients.map(publicRecipient) });
});

organizationsRoutes.post("/:id/notification-recipients", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
  const email = sanitizeAddress(body.email);
  if (!email) return c.json({ error: "a valid email address is required" }, 400);

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(c.env, {
      key: `organizations:recipients:add:${session.userId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "notification recipient rate limit exceeded", err);
    }
    throw err;
  }

  const existingRecipients = await listNotificationRecipients(db, organizationId);
  const existingRecipient = existingRecipients.find(
    (recipient) => recipient.email === email.trim().toLowerCase(),
  );
  if (existingRecipient) {
    return c.json({ recipient: publicRecipient(existingRecipient) }, 200);
  }

  if (existingRecipients.length >= MAX_NOTIFICATION_RECIPIENTS) {
    return c.json(
      { error: `at most ${MAX_NOTIFICATION_RECIPIENTS} notification recipients are allowed` },
      400,
    );
  }

  const { created, recipient } = await addNotificationRecipient(db, {
    organizationId,
    email,
    createdByUserId: session.userId,
  });
  if (created) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "organization.notification_recipient_added",
      metadata: { recipient: recipient.email },
    });
  }
  return c.json({ recipient: publicRecipient(recipient) }, created ? 201 : 200);
});

organizationsRoutes.delete("/:id/notification-recipients/:recipientId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const recipientId = c.req.param("recipientId");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const removed = await deleteNotificationRecipient(db, organizationId, recipientId);
  if (!removed) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.notification_recipient_removed",
    metadata: { recipient: removed.email },
  });
  return c.json({ ok: true });
});

function publicRecipient(recipient: NotificationRecipient) {
  return {
    id: recipient.id,
    email: recipient.email,
    createdAt: recipient.createdAt,
  };
}

function requireOrganizationMember(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  return getOrganizationRole(db, organizationId, userId);
}

function parseOrganizationName(
  value: unknown,
):
  | { ok: true; name: string }
  | { ok: false; error: "organization name is required" | typeof ORGANIZATION_NAME_ERROR } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { ok: false, error: "organization name is required" };
  if (!NAME_RE.test(name)) return { ok: false, error: ORGANIZATION_NAME_ERROR };
  return { ok: true, name };
}
