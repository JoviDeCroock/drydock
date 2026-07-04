import { Hono } from "hono";
import {
  createApiToken,
  listApiTokens,
  normalizeApiTokenName,
  normalizeApiTokenScopes,
  revokeApiToken,
} from "../db/api-tokens";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { getOrganizationRole } from "../db/invitations";
import {
  type NotificationRecipient,
  addNotificationRecipient,
  createOrganization,
  deleteNotificationRecipient,
  deleteOrganization,
  ensurePersonalOrganization,
  isOrganizationOwner,
  listNotificationRecipients,
  listUserOrganizations,
  renameOrganization,
  setRequireTwoFactorForReleaseDecisions,
} from "../db/organizations";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import { userHasTwoFactor, verifyTotpStepUp } from "../lib/auth";
import { sanitizeAddress } from "../lib/email";
import { rateLimitResponse } from "../lib/http";
import { describeOperationalError, emitOperationalEvent } from "../lib/observability";
import { personalOrganizationId } from "../lib/ownership";
import { roleCanManageIntegrations, type OrganizationRole } from "../lib/roles";
import type { Bindings, Variables } from "../types";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-./]{0,79}$/u;
const ORGANIZATION_NAME_ERROR =
  "organization name must be 1-80 characters of letters, digits, or _-./";
const MAX_NOTIFICATION_RECIPIENTS = 5;

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
  const parsed = parseOrganizationName(body.name);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name } = parsed;

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
    await enforceRateLimit(db, {
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
    await enforceRateLimit(db, {
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

organizationsRoutes.get("/:id/api-tokens", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  return c.json({ tokens: await listApiTokens(db, organizationId) });
});

organizationsRoutes.post("/:id/api-tokens", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    scopes?: unknown;
  };
  const name = normalizeApiTokenName(body.name);
  if (!name) return c.json({ error: "token name is required" }, 400);
  const scopes = normalizeApiTokenScopes(body.scopes);
  if (!scopes) {
    return c.json({ error: "scopes must include scans:read or scans:write" }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `api-tokens:create:${organizationId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "API token create rate limit exceeded", err);
    }
    throw err;
  }

  const created = await createApiToken(db, {
    organizationId,
    name,
    scopes,
    createdByUserId: session.userId,
  });
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "api_token.created",
    metadata: {
      tokenId: created.token.id,
      name,
      scopes,
      tokenLast4: created.token.tokenLast4,
    },
  });
  return c.json({ token: created.token, secret: created.secret }, 201);
});

organizationsRoutes.delete("/:id/api-tokens/:tokenId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const role = await requireOrganizationMember(db, organizationId, session.userId);
  if (!role) return c.json({ error: "not found" }, 404);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const token = await revokeApiToken(db, {
    organizationId,
    tokenId: c.req.param("tokenId"),
    revokedByUserId: session.userId,
  });
  if (!token) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "api_token.revoked",
    metadata: {
      tokenId: token.id,
      name: token.name,
      scopes: token.scopes,
      tokenLast4: token.tokenLast4,
    },
  });
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
    await enforceRateLimit(db, {
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
