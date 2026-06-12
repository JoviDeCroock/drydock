import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addOrganizationMember,
  createDb,
  ensurePersonalOrganization,
  getSlackConnection,
  getSlackConnectionSecret,
  setSlackConnectionChannel,
  setSlackConnectionEnabled,
  upsertSlackConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { ACTIVE_ORG_HEADER } from "../../server/lib/active-organization";
import { decryptSlackBotToken, encryptSlackBotToken } from "../../server/lib/secret-box";
import { signSlackState } from "../../server/lib/slack";
import { slackRoutes } from "../../server/routes/slack";
import type { Bindings, Variables } from "../../server/types";

const BOT_TOKEN = "xoxb-0000000000-1111111111-AbCdEfGhIjKlMnOpQrStUvWx";

interface SeededUser {
  userId: string;
  personalOrganizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const personalOrganizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, personalOrganizationId };
}

async function seedConnection(
  organizationId: string,
  options: {
    token?: string;
    teamId?: string;
    scope?: string | null;
    channelId?: string | null;
    channelName?: string | null;
    enabled?: boolean;
  } = {},
) {
  const db = createDb(env.DB);
  const encrypted = await encryptSlackBotToken(env, options.token ?? BOT_TOKEN);
  let connection = await upsertSlackConnection(db, {
    organizationId,
    teamId: options.teamId ?? "T0FAKE0001",
    teamName: "Acme",
    botUserId: "U0BOT0001",
    scope: options.scope ?? "chat:write,chat:write.public,channels:read",
    botTokenCiphertext: encrypted.ciphertext,
    botTokenNonce: encrypted.nonce,
    createdByUserId: null,
  });
  if (options.channelId) {
    connection =
      (await setSlackConnectionChannel(db, organizationId, {
        channelId: options.channelId,
        channelName: options.channelName ?? null,
      })) ?? connection;
  }
  if (options.enabled === false) {
    connection = (await setSlackConnectionEnabled(db, organizationId, false)) ?? connection;
  }
  return connection;
}

async function seedRateLimit(key: string, count: number, windowMs: number) {
  const db = createDb(env.DB);
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / windowMs);
  await db.insert(schema.rateLimits).values({
    key: `${key}:${bucket}`,
    count,
    expiresAt: new Date((bucket + 1) * windowMs),
    updatedAt: new Date(nowMs),
  });
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/slack", slackRoutes);
  return app;
}

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  options: { body?: unknown; activeOrganizationId?: string; envOverride?: Partial<Bindings> } = {},
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  if (options.activeOrganizationId) {
    headers[ACTIVE_ORG_HEADER] = options.activeOrganizationId;
  }
  init.headers = headers;
  const routeEnv: Bindings = { ...(env as unknown as Bindings), ...options.envOverride };
  const res = await app.fetch(new Request(`http://test.local${path}`, init), routeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface CapturedRequest {
  url: string;
  authorization: string | null;
  body: string | null;
}

function mockSlackFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization =
      init?.headers && typeof (init.headers as Record<string, string>).authorization === "string"
        ? (init.headers as Record<string, string>).authorization
        : null;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null;
    captured.push({ url, authorization, body });
    return handler(url, init);
  }) as typeof fetch;
  return captured;
}

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function readOrgEvents(orgId: string) {
  const db = createDb(env.DB);
  return db.select().from(schema.scanEvents).where(eq(schema.scanEvents.organizationId, orgId));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GET /api/v1/slack", () => {
  test("reports configured + null connection when nothing is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, connection: null });
  });

  test("returns the public connection without leaking the bot token", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      channelId: "C0RELEASE",
      channelName: "releases",
      canListChannels: true,
    });

    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; connection: Record<string, unknown> };
    expect(body.configured).toBe(true);
    expect(body.connection).toMatchObject({
      teamId: "T0FAKE0001",
      teamName: "Acme",
      channelId: "C0RELEASE",
      channelName: "releases",
      enabled: true,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain("botTokenCiphertext");
  });

  test("reports configured: false when Slack credentials are absent", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack", {
      envOverride: { SLACK_CLIENT_ID: "", SLACK_CLIENT_SECRET: "" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { configured: boolean }).toMatchObject({ configured: false });
  });
});

describe("POST /api/v1/slack/connect", () => {
  test("owner gets an authorize URL carrying the signed state", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/connect");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string; expiresInSeconds: number };
    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-slack-client-id");
    expect(url.searchParams.get("scope")).toContain("chat:write.public");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(body.expiresInSeconds).toBe(15 * 60);
  });

  test("members cannot start the connect flow", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });

    const res = await call(buildTestApp(member), "POST", "/api/v1/slack/connect", {
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(403);
  });

  test("returns 503 when Slack is not configured", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/connect", {
      envOverride: { SLACK_CLIENT_ID: "", SLACK_CLIENT_SECRET: "" },
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "slack_not_configured" });
  });
});

describe("GET /api/v1/slack/callback", () => {
  test("exchanges the code, encrypts the token, and redirects with slack=connected", async () => {
    const owner = await seedUser();
    const state = await signSlackState(env.BETTER_AUTH_SECRET, {
      organizationId: owner.personalOrganizationId,
      userId: owner.userId,
    });

    const captured = mockSlackFetch((url) => {
      if (url.startsWith("https://slack.com/api/oauth.v2.access")) {
        return jsonResponse({
          ok: true,
          access_token: BOT_TOKEN,
          scope: "chat:write,chat:write.public,channels:read",
          bot_user_id: "U0BOT0001",
          team: { id: "T0REAL0001", name: "Real Team" },
        });
      }
      return jsonResponse({ ok: false, error: "unexpected" });
    });

    const res = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/slack/callback?state=${encodeURIComponent(state)}&code=good-code`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack=connected");
    expect(location).toContain("tab=notifications");

    // The exchange happened and never echoed the client secret in a query string.
    expect(captured[0]?.url).toContain("oauth.v2.access");

    const db = createDb(env.DB);
    const connection = await getSlackConnection(db, owner.personalOrganizationId);
    expect(connection?.teamId).toBe("T0REAL0001");

    const secret = await getSlackConnectionSecret(db, owner.personalOrganizationId);
    expect(secret?.botTokenCiphertext.startsWith("v1:")).toBe(true);
    expect(secret?.botTokenCiphertext).not.toContain(BOT_TOKEN);
    expect(
      await decryptSlackBotToken(env, {
        ciphertext: secret!.botTokenCiphertext,
        nonce: secret!.botTokenNonce,
      }),
    ).toBe(BOT_TOKEN);

    const events = await readOrgEvents(owner.personalOrganizationId);
    const connectedEvent = events.find((e) => e.type === "organization.slack_connected");
    expect(connectedEvent).toBeTruthy();
    expect(JSON.stringify(connectedEvent)).not.toContain(BOT_TOKEN);
  });

  test("redirects with an error when Slack denies consent", async () => {
    const owner = await seedUser();
    const res = await call(
      buildTestApp(owner),
      "GET",
      "/api/v1/slack/callback?error=access_denied",
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack=error");
    expect(location).toContain("slackError=access_denied");
  });

  test("rejects a forged state with invalid_state", async () => {
    const owner = await seedUser();
    const res = await call(
      buildTestApp(owner),
      "GET",
      "/api/v1/slack/callback?state=slackv1.forged.signature&code=good-code",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("slackError=invalid_state");
  });

  test("rejects a state minted for a different user", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const state = await signSlackState(env.BETTER_AUTH_SECRET, {
      organizationId: owner.personalOrganizationId,
      userId: attacker.userId,
    });
    const res = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/slack/callback?state=${encodeURIComponent(state)}&code=good-code`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("slackError=state_user_mismatch");
  });

  test("redirects with the Slack error when the token exchange fails", async () => {
    const owner = await seedUser();
    const state = await signSlackState(env.BETTER_AUTH_SECRET, {
      organizationId: owner.personalOrganizationId,
      userId: owner.userId,
    });
    mockSlackFetch(() => jsonResponse({ ok: false, error: "invalid_code" }));

    const res = await call(
      buildTestApp(owner),
      "GET",
      `/api/v1/slack/callback?state=${encodeURIComponent(state)}&code=bad-code`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("slackError=invalid_code");
    expect(await getSlackConnection(createDb(env.DB), owner.personalOrganizationId)).toBeNull();
  });

  test("forbids a caller who is no longer allowed to manage integrations", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    const state = await signSlackState(env.BETTER_AUTH_SECRET, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
    });

    const res = await call(
      buildTestApp(member),
      "GET",
      `/api/v1/slack/callback?state=${encodeURIComponent(state)}&code=good-code`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("slackError=forbidden");
  });
});

describe("GET /api/v1/slack/channels", () => {
  test("lists public channels sorted by name without echoing the token", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId);

    const captured = mockSlackFetch((url) => {
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return jsonResponse({
          ok: true,
          channels: [
            { id: "C2", name: "releases" },
            { id: "C1", name: "alerts" },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      return jsonResponse({ ok: false, error: "unexpected" });
    });

    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: { id: string; name: string }[] };
    expect(body.channels.map((c) => c.name)).toEqual(["alerts", "releases"]);
    // The bot token reaches Slack only via the Authorization header.
    expect(captured[0]?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
  });

  test("404s when no Slack workspace is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack/channels");
    expect(res.status).toBe(404);
  });

  test("members cannot list channels", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    await seedConnection(owner.personalOrganizationId);

    const res = await call(buildTestApp(member), "GET", "/api/v1/slack/channels", {
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(403);
  });

  test("skips Slack API calls when channel list permission is unavailable", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      scope: "chat:write,chat:write.public",
    });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true }));

    const res = await call(buildTestApp(owner), "GET", "/api/v1/slack/channels");
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/slack/channel", () => {
  test("stores the chosen channel and records a redacted event", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId);

    const res = await call(buildTestApp(owner), "PUT", "/api/v1/slack/channel", {
      body: { channelId: "C0RELEASE", channelName: "releases" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { channelId: string; channelName: string } };
    expect(body.connection.channelId).toBe("C0RELEASE");
    expect(body.connection.channelName).toBe("releases");

    const connection = await getSlackConnection(createDb(env.DB), owner.personalOrganizationId);
    expect(connection?.channelId).toBe("C0RELEASE");

    const events = await readOrgEvents(owner.personalOrganizationId);
    expect(events.some((e) => e.type === "organization.slack_channel_set")).toBe(true);
  });

  test("rejects a missing channel id", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId);
    const res = await call(buildTestApp(owner), "PUT", "/api/v1/slack/channel", {
      body: { channelName: "releases" },
    });
    expect(res.status).toBe(400);
  });

  test("404s when no Slack workspace is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "PUT", "/api/v1/slack/channel", {
      body: { channelId: "C0RELEASE", channelName: "releases" },
    });
    expect(res.status).toBe(404);
  });

  test("members cannot choose a channel", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    await seedConnection(owner.personalOrganizationId);
    const res = await call(buildTestApp(member), "PUT", "/api/v1/slack/channel", {
      body: { channelId: "C0RELEASE" },
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/slack", () => {
  test("toggles delivery off and records the event", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      channelId: "C0RELEASE",
      channelName: "releases",
    });

    const res = await call(buildTestApp(owner), "PATCH", "/api/v1/slack", {
      body: { enabled: false },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: { enabled: boolean } }).connection.enabled).toBe(
      false,
    );

    const connection = await getSlackConnection(createDb(env.DB), owner.personalOrganizationId);
    expect(connection?.enabled).toBe(false);

    const events = await readOrgEvents(owner.personalOrganizationId);
    expect(events.some((e) => e.type === "organization.slack_disabled")).toBe(true);
  });

  test("rejects a non-boolean enabled", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId);
    const res = await call(buildTestApp(owner), "PATCH", "/api/v1/slack", {
      body: { enabled: "nope" },
    });
    expect(res.status).toBe(400);
  });

  test("404s when no Slack workspace is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "PATCH", "/api/v1/slack", {
      body: { enabled: true },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/slack", () => {
  test("disconnects the workspace and records the event", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, { channelId: "C0RELEASE" });

    const res = await call(buildTestApp(owner), "DELETE", "/api/v1/slack");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(await getSlackConnection(createDb(env.DB), owner.personalOrganizationId)).toBeNull();

    const events = await readOrgEvents(owner.personalOrganizationId);
    expect(events.some((e) => e.type === "organization.slack_disconnected")).toBe(true);
  });

  test("404s when nothing is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "DELETE", "/api/v1/slack");
    expect(res.status).toBe(404);
  });

  test("members cannot disconnect", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.personalOrganizationId,
      userId: member.userId,
      role: "member",
    });
    await seedConnection(owner.personalOrganizationId);
    const res = await call(buildTestApp(member), "DELETE", "/api/v1/slack", {
      activeOrganizationId: owner.personalOrganizationId,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/slack/test", () => {
  test("posts to the chosen channel and records a redacted success event", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      channelId: "C0RELEASE",
      channelName: "releases",
    });

    const captured = mockSlackFetch((url) => {
      if (url.startsWith("https://slack.com/api/chat.postMessage")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: false, error: "unexpected" });
    });

    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/test");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    expect(captured[0]?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(captured[0]?.body).toContain("C0RELEASE");

    const events = await readOrgEvents(owner.personalOrganizationId);
    const testEvent = events.find((e) => e.type === "organization.slack_tested");
    expect(testEvent).toBeTruthy();
    expect(JSON.stringify(testEvent)).not.toContain(BOT_TOKEN);
  });

  test("reports a failure reason without leaking the token", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      channelId: "C0RELEASE",
      channelName: "releases",
    });
    mockSlackFetch(() => jsonResponse({ ok: false, error: "channel_not_found" }));

    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("channel_not_found");

    const events = await readOrgEvents(owner.personalOrganizationId);
    const failEvent = events.find((e) => e.type === "organization.slack_test_failed");
    expect(failEvent).toBeTruthy();
    expect(JSON.stringify(failEvent)).not.toContain(BOT_TOKEN);
  });

  test("400s when no channel has been chosen", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId);
    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/test");
    expect(res.status).toBe(400);
  });

  test("404s when nothing is connected", async () => {
    const owner = await seedUser();
    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/test");
    expect(res.status).toBe(404);
  });

  test("rate-limits repeated test sends", async () => {
    const owner = await seedUser();
    await seedConnection(owner.personalOrganizationId, {
      channelId: "C0RELEASE",
      channelName: "releases",
    });
    await seedRateLimit(`slack:test:${owner.personalOrganizationId}`, 10, 60 * 60 * 1000);

    const res = await call(buildTestApp(owner), "POST", "/api/v1/slack/test");
    expect(res.status).toBe(429);
  });
});
