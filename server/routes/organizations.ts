import { Hono } from "hono";
import {
  addNotificationRecipient,
  createDb,
  createOrganization,
  deleteNotificationRecipient,
  deleteOrganization,
  ensurePersonalOrganization,
  getOrganizationRole,
  isOrganizationOwner,
  listNotificationRecipients,
  listUserOrganizations,
  recordScanEvent,
  renameOrganization,
  type NotificationRecipient,
} from "../db";
import { sanitizeAddress } from "../lib/email";
import { withRateLimit } from "../lib/http";
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

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const limited = await withRateLimit(
    c,
    db,
    { key: `organizations:create:${session.userId}`, limit: 10, windowMs: 60 * 60 * 1000 },
    "organization create rate limit exceeded",
  );
  if (limited) return limited;

  try {
    const id = await createOrganization(db, { ownerUserId: session.userId, name });
    await recordScanEvent(db, {
      organizationId: id,
      actorUserId: session.userId,
      type: "organization.created",
      metadata: { name },
    });
    return c.json({ organization: { id, name } }, 201);
  } catch (err) {
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

organizationsRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");

  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  if (organizationId === personalOrganizationId(session.userId)) {
    return c.json({ error: "personal workspaces cannot be deleted" }, 400);
  }

  const limited = await withRateLimit(
    c,
    db,
    { key: `organizations:delete:${session.userId}`, limit: 10, windowMs: 60 * 60 * 1000 },
    "organization delete rate limit exceeded",
  );
  if (limited) return limited;

  // No scan_event is recorded: the org and its scan_events are removed together,
  // so the audit row would be deleted in the same breath.
  await deleteOrganization(db, organizationId);
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

  const limited = await withRateLimit(
    c,
    db,
    { key: `organizations:recipients:add:${session.userId}`, limit: 30, windowMs: 60 * 60 * 1000 },
    "notification recipient rate limit exceeded",
  );
  if (limited) return limited;

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
