import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  deleteSlackConnection,
  enforceRateLimit,
  getOrganizationRole,
  getSlackConnection,
  getSlackConnectionSecret,
  recordScanEvent,
  setSlackConnectionChannel,
  setSlackConnectionEnabled,
  upsertSlackConnection,
  type SlackConnection,
} from "../db";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/active-organization";
import { rateLimitResponse } from "../lib/http";
import { roleCanManageIntegrations } from "../lib/roles";
import { decryptSlackBotToken, encryptSlackBotToken } from "../lib/secret-box";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOAuthCode,
  listSlackPublicChannels,
  postSlackMessage,
  readSlackOAuthConfig,
  renderSlackTestMessage,
  signSlackState,
  slackRedirectUri,
  verifySlackState,
} from "../lib/slack";
import type { Bindings, Variables } from "../types";

export const slackRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_CHANNEL_ID_LENGTH = 64;
const MAX_CHANNEL_NAME_LENGTH = 80;

// Status is readable by any member; managing the connection requires owner/admin.
slackRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const connection = await getSlackConnection(db, organizationId);
  return c.json({
    configured: readSlackOAuthConfig(c.env) !== null,
    connection: connection ? publicConnection(connection) : null,
  });
});

slackRoutes.post("/connect", async (c) => {
  const config = readSlackOAuthConfig(c.env);
  if (!config)
    return c.json({ error: "Slack is not configured", code: "slack_not_configured" }, 503);
  const redirectUri = slackRedirectUri(c.env);
  if (!redirectUri) return c.json({ error: "BETTER_AUTH_URL is not configured" }, 503);

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `slack:connect:${organizationId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "Slack connect rate limit exceeded", err);
    }
    throw err;
  }

  const state = await signSlackState(c.env.BETTER_AUTH_SECRET, {
    organizationId,
    userId: session.userId,
  });
  const authorizeUrl = buildSlackAuthorizeUrl({ clientId: config.clientId, redirectUri, state });
  return c.json({ authorizeUrl, expiresInSeconds: 15 * 60 });
});

// Slack redirects the browser here after consent. There is no x-organization-id
// header on a top-level navigation, so the org binding comes entirely from the
// signed state token (CSRF defense), cross-checked against the session user and
// a fresh role lookup. Always finish with a redirect back into settings so the
// user never sees a raw JSON body.
slackRoutes.get("/callback", async (c) => {
  const config = readSlackOAuthConfig(c.env);
  const redirectUri = slackRedirectUri(c.env);
  const state = c.req.query("state")?.trim() ?? "";
  const code = c.req.query("code")?.trim() ?? "";
  const denied = c.req.query("error")?.trim();

  if (denied) return c.redirect(settingsRedirect(c.env, "error", denied));
  if (!config || !redirectUri)
    return c.redirect(settingsRedirect(c.env, "error", "not_configured"));
  if (!state || !code) return c.redirect(settingsRedirect(c.env, "error", "missing_params"));

  const claims = await verifySlackState(c.env.BETTER_AUTH_SECRET, state);
  if (!claims) return c.redirect(settingsRedirect(c.env, "error", "invalid_state"));
  const session = c.get("authSession");
  if (claims.userId !== session.userId) {
    return c.redirect(settingsRedirect(c.env, "error", "state_user_mismatch"));
  }

  const db = createDb(c.env.DB);
  const role = await getOrganizationRole(db, claims.organizationId, session.userId);
  if (!role || !roleCanManageIntegrations(role)) {
    return c.redirect(settingsRedirect(c.env, "error", "forbidden"));
  }

  const exchange = await exchangeSlackOAuthCode({ config, code, redirectUri });
  if (!exchange.ok || !exchange.botToken || !exchange.teamId) {
    return c.redirect(settingsRedirect(c.env, "error", exchange.error ?? "oauth_failed"));
  }

  const encrypted = await encryptSlackBotToken(c.env, exchange.botToken);
  const connection = await upsertSlackConnection(db, {
    organizationId: claims.organizationId,
    teamId: exchange.teamId,
    teamName: exchange.teamName ?? null,
    botUserId: exchange.botUserId ?? null,
    scope: exchange.scope ?? null,
    botTokenCiphertext: encrypted.ciphertext,
    botTokenNonce: encrypted.nonce,
    createdByUserId: session.userId,
  });
  await recordScanEvent(db, {
    organizationId: claims.organizationId,
    actorUserId: session.userId,
    type: "organization.slack_connected",
    metadata: { teamId: connection.teamId, teamName: connection.teamName },
  });

  return c.redirect(settingsRedirect(c.env, "connected"));
});

slackRoutes.get("/channels", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const secret = await getSlackConnectionSecret(db, organizationId);
  if (!secret) return c.json({ error: "Slack is not connected" }, 404);

  try {
    await enforceRateLimit(db, {
      key: `slack:channels:${organizationId}`,
      limit: 30,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "Slack channel lookup rate limit exceeded", err);
    }
    throw err;
  }

  const botToken = await decryptSlackBotToken(c.env, {
    ciphertext: secret.botTokenCiphertext,
    nonce: secret.botTokenNonce,
  });
  const result = await listSlackPublicChannels(botToken);
  if (!result.ok) {
    return c.json({ error: "could not list Slack channels", reason: result.error }, 502);
  }
  return c.json({ channels: result.channels ?? [] });
});

slackRoutes.put("/channel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    channelId?: unknown;
    channelName?: unknown;
  };
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId || channelId.length > MAX_CHANNEL_ID_LENGTH) {
    return c.json({ error: "a Slack channel id is required" }, 400);
  }
  const channelName = sanitizeChannelName(body.channelName);

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const updated = await setSlackConnectionChannel(db, organizationId, { channelId, channelName });
  if (!updated) return c.json({ error: "Slack is not connected" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.slack_channel_set",
    metadata: { channel: "slack", channelName: updated.channelName },
  });
  return c.json({ connection: publicConnection(updated) });
});

slackRoutes.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const updated = await setSlackConnectionEnabled(db, organizationId, body.enabled);
  if (!updated) return c.json({ error: "Slack is not connected" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: updated.enabled ? "organization.slack_enabled" : "organization.slack_disabled",
    metadata: { channel: "slack", channelName: updated.channelName },
  });
  return c.json({ connection: publicConnection(updated) });
});

slackRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const removed = await deleteSlackConnection(db, organizationId);
  if (!removed) return c.json({ error: "Slack is not connected" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.slack_disconnected",
    metadata: { channel: "slack", teamName: removed.teamName },
  });
  return c.json({ ok: true });
});

slackRoutes.post("/test", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `slack:test:${organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "Slack test rate limit exceeded", err);
    }
    throw err;
  }

  const secret = await getSlackConnectionSecret(db, organizationId);
  if (!secret) return c.json({ error: "Slack is not connected" }, 404);
  if (!secret.channelId) return c.json({ error: "choose a channel first" }, 400);

  let result: Awaited<ReturnType<typeof postSlackMessage>>;
  try {
    const botToken = await decryptSlackBotToken(c.env, {
      ciphertext: secret.botTokenCiphertext,
      nonce: secret.botTokenNonce,
    });
    result = await postSlackMessage(
      botToken,
      secret.channelId,
      renderSlackTestMessage(secret.channelName),
    );
  } catch {
    result = { ok: false, statusClass: "other", reason: "delivery_error" };
  }

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: result.ok ? "organization.slack_tested" : "organization.slack_test_failed",
    metadata: {
      channel: "slack",
      channelName: secret.channelName,
      ...(result.statusClass ? { statusClass: result.statusClass } : {}),
      ...(result.rateLimited ? { rateLimited: true } : {}),
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });

  return c.json({
    ok: result.ok,
    ...(result.rateLimited ? { rateLimited: true } : {}),
    ...(result.ok ? {} : { reason: result.reason ?? "delivery_failed" }),
  });
});

function publicConnection(connection: SlackConnection) {
  return {
    teamId: connection.teamId,
    teamName: connection.teamName,
    channelId: connection.channelId,
    channelName: connection.channelName,
    enabled: connection.enabled,
    createdAt: connection.createdAt,
  };
}

function sanitizeChannelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\r\n\t]/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

function settingsRedirect(
  env: Cloudflare.Env,
  status: "connected" | "error",
  detail?: string,
): string {
  const params = new URLSearchParams({ tab: "notifications", slack: status });
  if (detail) params.set("slackError", detail);
  const query = params.toString();
  const base = env.BETTER_AUTH_URL;
  if (typeof base === "string" && base) {
    try {
      const url = new URL("/dashboard/settings", base);
      url.search = query;
      return url.toString();
    } catch {
      // fall through to a relative redirect
    }
  }
  return `/dashboard/settings?${query}`;
}
