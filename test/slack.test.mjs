import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SLACK_OAUTH_SCOPES,
  buildSlackAuthorizeUrl,
  exchangeSlackOAuthCode,
  listSlackPublicChannels,
  postSlackMessage,
  readSlackOAuthConfig,
  renderSlackMessage,
  renderSlackTestMessage,
  signSlackState,
  slackRedirectUri,
  verifySlackState,
} from "../server/lib/notify/slack";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CONFIG = { clientId: "client-id", clientSecret: "client-secret" };
const STATE_SECRET = "state-secret-that-is-long-enough-for-hmac";

describe("readSlackOAuthConfig", () => {
  test("returns the config when both client id and secret are present", () => {
    expect(
      readSlackOAuthConfig({ SLACK_CLIENT_ID: " client-id ", SLACK_CLIENT_SECRET: " secret " }),
    ).toEqual({ clientId: "client-id", clientSecret: "secret" });
  });

  test("returns null when either credential is missing", () => {
    expect(readSlackOAuthConfig({ SLACK_CLIENT_ID: "client-id" })).toBeNull();
    expect(readSlackOAuthConfig({ SLACK_CLIENT_SECRET: "secret" })).toBeNull();
    expect(readSlackOAuthConfig({})).toBeNull();
  });
});

describe("slackRedirectUri", () => {
  test("resolves the callback path from BETTER_AUTH_URL", () => {
    expect(slackRedirectUri({ BETTER_AUTH_URL: "https://drydock.test" })).toBe(
      "https://drydock.test/api/v1/slack/callback",
    );
  });

  test("returns null without a base URL", () => {
    expect(slackRedirectUri({})).toBeNull();
    expect(slackRedirectUri({ BETTER_AUTH_URL: "not a url" })).toBeNull();
  });
});

describe("buildSlackAuthorizeUrl", () => {
  test("includes the client id, scopes, redirect URI, and state", () => {
    const url = new URL(
      buildSlackAuthorizeUrl({
        clientId: "client-id",
        redirectUri: "https://drydock.test/api/v1/slack/callback",
        state: "state-token",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe(SLACK_OAUTH_SCOPES);
    expect(url.searchParams.get("scope")).not.toContain("channels:read");
    expect(url.searchParams.get("redirect_uri")).toBe("https://drydock.test/api/v1/slack/callback");
    expect(url.searchParams.get("state")).toBe("state-token");
  });
});

describe("signSlackState / verifySlackState", () => {
  test("round-trips the org and user binding", async () => {
    const token = await signSlackState(STATE_SECRET, { organizationId: "org_1", userId: "user_1" });
    const claims = await verifySlackState(STATE_SECRET, token);
    expect(claims).toMatchObject({ organizationId: "org_1", userId: "user_1" });
    expect(claims.expiresAt).toBeGreaterThan(Date.now());
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await signSlackState(STATE_SECRET, { organizationId: "org_1", userId: "user_1" });
    expect(await verifySlackState("another-secret-long-enough-x", token)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await signSlackState(STATE_SECRET, { organizationId: "org_1", userId: "user_1" });
    const [version, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ organizationId: "org_evil", userId: "user_1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifySlackState(STATE_SECRET, `${version}.${forged}.${signature}`)).toBeNull();
  });

  test("rejects malformed or wrong-version tokens", async () => {
    expect(await verifySlackState(STATE_SECRET, "")).toBeNull();
    expect(await verifySlackState(STATE_SECRET, "only.two")).toBeNull();
    const token = await signSlackState(STATE_SECRET, { organizationId: "org_1", userId: "user_1" });
    const [, payload, signature] = token.split(".");
    expect(await verifySlackState(STATE_SECRET, `othver.${payload}.${signature}`)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const token = await signSlackState(STATE_SECRET, { organizationId: "org_1", userId: "user_1" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect(await verifySlackState(STATE_SECRET, token)).toBeNull();
  });
});

describe("exchangeSlackOAuthCode", () => {
  test("returns the bot token and team on success", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-secret-token",
            scope: SLACK_OAUTH_SCOPES,
            bot_user_id: "U999",
            team: { id: "T123", name: "Acme" },
          }),
          { status: 200 },
        ),
    );
    const result = await exchangeSlackOAuthCode({
      config: CONFIG,
      code: "the-code",
      redirectUri: "https://drydock.test/api/v1/slack/callback",
    });
    expect(result).toMatchObject({
      ok: true,
      botToken: "xoxb-secret-token",
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U999",
    });
  });

  test("keys success off the ok field, not the HTTP status", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 }),
    );
    const result = await exchangeSlackOAuthCode({
      config: CONFIG,
      code: "bad",
      redirectUri: "https://drydock.test/api/v1/slack/callback",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_code");
    expect(result.botToken).toBeUndefined();
  });

  test("never echoes the client secret on a network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const result = await exchangeSlackOAuthCode({
      config: CONFIG,
      code: "the-code",
      redirectUri: "https://drydock.test/api/v1/slack/callback",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("client-secret");
  });
});

describe("listSlackPublicChannels", () => {
  test("paginates, sorts by name, and never echoes the bot token", async () => {
    const pages = [
      {
        ok: true,
        channels: [
          { id: "C2", name: "releases" },
          { id: "C1", name: "alerts" },
        ],
        response_metadata: { next_cursor: "cursor-2" },
      },
      {
        ok: true,
        channels: [{ id: "C3", name: "builds" }],
        response_metadata: { next_cursor: "" },
      },
    ];
    let call = 0;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(pages[call++]), { status: 200 }),
    );
    const result = await listSlackPublicChannels("xoxb-secret-token");
    expect(result.ok).toBe(true);
    expect(result.channels.map((channel) => channel.name)).toEqual([
      "alerts",
      "builds",
      "releases",
    ]);
    expect(JSON.stringify(result)).not.toContain("xoxb-secret-token");
  });

  test("returns the Slack error code on a failed list", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
    );
    const result = await listSlackPublicChannels("xoxb-secret-token");
    expect(result).toMatchObject({ ok: false, error: "invalid_auth" });
  });
});

describe("renderSlackMessage", () => {
  test("includes package, source, and risk in the summary text and fields", () => {
    const message = renderSlackMessage({
      title: "Staged release scan complete",
      packageLabel: "demo-package@1.2.0",
      source: "npm staged publish",
      risk: "high",
      findingsSummary: "3 findings (2 on the release diff)",
      releaseMemory:
        "Finding profile matches v1.1.0; the same deterministic findings were already reviewed and published.",
      dashboardUrl: "https://drydock.test/dashboard/scans/scan_1",
    });

    expect(message.text).toContain("demo-package@1.2.0");
    expect(message.text).toContain("risk high");

    const serialized = JSON.stringify(message.blocks);
    expect(serialized).toContain("demo-package@1.2.0");
    expect(serialized).toContain("npm staged publish");
    expect(serialized).toContain("high");
    expect(serialized).toContain("3 findings (2 on the release diff)");
    expect(serialized).toContain("Release memory");
    expect(serialized).toContain("Finding profile matches v1.1.0");
    expect(serialized).toContain("https://drydock.test/dashboard/scans/scan_1");
  });

  test.each(["low", "medium", "high", "critical"])("renders the %s risk level", (risk) => {
    const message = renderSlackMessage({
      title: "Release gate needs a decision",
      packageLabel: "demo-package@2.0.0",
      source: "GitHub workflow gate",
      risk,
    });
    expect(JSON.stringify(message.blocks)).toContain(risk);
    expect(message.text).toContain(`risk ${risk}`);
  });

  test("omits optional fields when absent and adds no action button without a URL", () => {
    const message = renderSlackMessage({
      title: "Staged release scan failed",
      packageLabel: "demo-package",
      source: "npm staged publish",
      risk: null,
    });
    const serialized = JSON.stringify(message.blocks);
    expect(serialized).not.toContain("Open in Drydock");
    expect(serialized).not.toContain("Risk");
    expect(message.text).not.toContain("risk");
  });

  test("adds an Open in Drydock link only when a dashboard URL is present", () => {
    const message = renderSlackMessage({
      title: "Staged release scan complete",
      packageLabel: "demo-package",
      source: "npm staged publish",
      dashboardUrl: "https://drydock.test/dashboard/scans/scan_1",
    });
    const serialized = JSON.stringify(message.blocks);
    // Rendered as an mrkdwn link, not an interactive button. A button — even a
    // `url` link button — would require the app to configure a Slack Interactivity
    // Request URL, which Drydock does not have, surfacing a warning on the message.
    expect(serialized).toContain("<https://drydock.test/dashboard/scans/scan_1|Open in Drydock>");
    expect(serialized).not.toContain('"type":"actions"');
    expect(serialized).not.toContain('"type":"button"');
  });
});

describe("renderSlackTestMessage", () => {
  test("names the channel label when provided", () => {
    const message = renderSlackTestMessage("releases");
    expect(JSON.stringify(message.blocks)).toContain("releases");
  });

  test("falls back to a generic channel reference without a label", () => {
    const message = renderSlackTestMessage(null);
    expect(JSON.stringify(message.blocks)).toContain("this channel");
  });
});

describe("postSlackMessage", () => {
  const message = { text: "hi", blocks: [] };

  test("reports success when Slack responds ok:true", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await postSlackMessage("xoxb-token", "C123", message);
    expect(result).toMatchObject({ ok: true, status: 200, statusClass: "2xx" });
    expect(result.reason).toBeUndefined();
  });

  test("treats a 200 with ok:false as an application failure", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    );
    const result = await postSlackMessage("xoxb-token", "C123", message);
    expect(result).toMatchObject({ ok: false, status: 200, reason: "channel_not_found" });
  });

  test("surfaces 429 as rateLimited with the Retry-After value", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 429, headers: { "retry-after": "42" } }),
    );
    const result = await postSlackMessage("xoxb-token", "C123", message);
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimited: true,
      retryAfterSeconds: 42,
    });
  });

  test("reports a network error without throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const result = await postSlackMessage("xoxb-token", "C123", message);
    expect(result.ok).toBe(false);
    expect(result.statusClass).toBe("other");
  });

  test("never includes the bot token or channel id in the result", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 }),
    );
    const result = await postSlackMessage("xoxb-supersecret", "C-private-id", message);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("xoxb-supersecret");
    expect(serialized).not.toContain("C-private-id");
  });

  test("fails fast without a token or channel", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    expect(await postSlackMessage("", "C123", message)).toMatchObject({ ok: false });
    expect(await postSlackMessage("xoxb-token", "", message)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
