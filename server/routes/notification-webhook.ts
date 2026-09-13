import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import {
  deleteWebhookConnection,
  getWebhookConnection,
  getWebhookConnectionSecret,
  setWebhookConnectionEnabled,
  upsertWebhookConnection,
} from "../db/webhook-connection";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { isRecord } from "../lib/platform/guards";
import { rateLimitResponse } from "../lib/platform/http";
import { enforceRateLimit, RateLimitError } from "../lib/platform/rate-limit";
import { emitOperationalEvent } from "../lib/platform/observability";
import {
  decryptWebhookCredentials,
  encryptWebhookCredentials,
} from "../lib/notify/webhook-credentials";
import { sendWebhookNotification, validateWebhookUrl } from "../lib/notify/webhook";
import type { Bindings, Variables } from "../types";

export const notificationWebhookRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

notificationWebhookRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  return c.json({ connection: await getWebhookConnection(db, organizationId) });
});

notificationWebhookRoutes.put("/", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  const body: unknown = await c.req.json().catch(() => null);
  const url = isRecord(body) && typeof body.url === "string" ? validateWebhookUrl(body.url) : null;
  if (!url) return c.json({ error: "a public HTTPS webhook URL is required" }, 400);
  if (
    !isRecord(body) ||
    typeof body.secret !== "string" ||
    body.secret.length < 32 ||
    body.secret.length > 512
  ) {
    return c.json({ error: "a signing secret of 32 to 512 characters is required" }, 400);
  }
  const encrypted = await encryptWebhookCredentials(c.env, { url: url.href, secret: body.secret });
  const connection = await upsertWebhookConnection(db, {
    organizationId,
    hostname: url.hostname,
    credentialsCiphertext: encrypted.ciphertext,
    credentialsNonce: encrypted.nonce,
    createdByUserId: c.get("authSession").userId,
  });
  await recordScanEvent(db, {
    organizationId,
    actorUserId: c.get("authSession").userId,
    type: "organization.webhook_connected",
    metadata: { channel: "webhook" },
  });
  return c.json({ connection });
});

notificationWebhookRoutes.patch("/", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.enabled !== "boolean")
    return c.json({ error: "enabled must be a boolean" }, 400);
  const connection = await setWebhookConnectionEnabled(db, organizationId, body.enabled);
  if (!connection) return c.json({ error: "webhook is not connected" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: c.get("authSession").userId,
    type: body.enabled ? "organization.webhook_enabled" : "organization.webhook_disabled",
    metadata: { channel: "webhook" },
  });
  return c.json({ connection });
});

notificationWebhookRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  if (!(await deleteWebhookConnection(db, organizationId)))
    return c.json({ error: "webhook is not connected" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: c.get("authSession").userId,
    type: "organization.webhook_disconnected",
    metadata: { channel: "webhook" },
  });
  return c.json({ ok: true });
});

notificationWebhookRoutes.post("/test", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  try {
    await enforceRateLimit(c.env, {
      key: `webhook:test:${organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
  } catch (error) {
    if (error instanceof RateLimitError)
      return rateLimitResponse(c, "webhook test rate limit exceeded", error);
    throw error;
  }
  const connection = await getWebhookConnectionSecret(db, organizationId);
  if (!connection) return c.json({ error: "webhook is not connected" }, 404);
  let ok = false;
  try {
    const credentials = await decryptWebhookCredentials(c.env, {
      ciphertext: connection.credentialsCiphertext,
      nonce: connection.credentialsNonce,
    });
    await sendWebhookNotification({
      ...credentials,
      event: {
        version: 1,
        id: crypto.randomUUID(),
        type: "notification.test",
        createdAt: new Date().toISOString(),
        organizationId,
        data: { message: "Drydock webhook connection verified." },
      },
    });
    ok = true;
  } catch {
    emitOperationalEvent("warn", "notification.webhook_test_failed", {
      organizationId,
      reason: "delivery_failed",
    });
  }
  await recordScanEvent(db, {
    organizationId,
    actorUserId: c.get("authSession").userId,
    type: ok ? "organization.webhook_tested" : "organization.webhook_test_failed",
    metadata: { channel: "webhook", ...(ok ? {} : { reason: "delivery_failed" }) },
  });
  return c.json({ ok, ...(ok ? {} : { reason: "delivery_failed" }) });
});
