import { base64UrlDecode, base64UrlEncode, hmacSha256, timingSafeEqual } from "./crypto-utils";
import { errorMessage } from "./errors";

// ── Slack OAuth (bot token) ──────────────────────────────────────────────────
//
// Drydock connects a Slack workspace through the "Add to Slack" OAuth v2 flow and
// posts release alerts with the resulting bot token (`xoxb-…`). We request the
// minimum scopes for posting to a manually supplied public channel:
//   - chat:write          — post messages
//   - chat:write.public    — post to any *public* channel without an invite
// Restricting to public channels is deliberate: chat:write.public means the bot
// never has to be invited, so delivery to the chosen channel always works.

export const SLACK_CHANNEL_LIST_SCOPE = "channels:read";
export const SLACK_OAUTH_SCOPES = "chat:write,chat:write.public";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list";
const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const SLACK_API_TIMEOUT_MS = 5000;
const CHANNEL_PAGE_LIMIT = 200;
const MAX_CHANNEL_PAGES = 10;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function readSlackOAuthConfig(env: Cloudflare.Env): SlackOAuthConfig | null {
  const clientId = typeof env.SLACK_CLIENT_ID === "string" ? env.SLACK_CLIENT_ID.trim() : "";
  const clientSecret =
    typeof env.SLACK_CLIENT_SECRET === "string" ? env.SLACK_CLIENT_SECRET.trim() : "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The Slack OAuth redirect URI. It must exactly match a redirect URL registered
 * in the Slack app config and resolves from `BETTER_AUTH_URL` so a deployment
 * never has to configure it twice.
 */
export function slackRedirectUri(env: Cloudflare.Env): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    return new URL("/api/v1/slack/callback", base).toString();
  } catch {
    return null;
  }
}

export function buildSlackAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_OAUTH_SCOPES);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function canListSlackChannels(scope: string | null): boolean {
  return (
    scope
      ?.split(",")
      .map((item) => item.trim())
      .includes(SLACK_CHANNEL_LIST_SCOPE) ?? false
  );
}

export interface SlackOAuthResult {
  ok: boolean;
  botToken?: string;
  teamId?: string;
  teamName?: string | null;
  botUserId?: string | null;
  scope?: string | null;
  error?: string;
}

/**
 * Exchange an OAuth `code` for a bot token via `oauth.v2.access`. Slack returns
 * HTTP 200 with `{ ok: false, error }` on failure, so we key success off the
 * `ok` field rather than the HTTP status. The returned `error` is a short Slack
 * token (e.g. `invalid_code`) — never the client secret or the code.
 */
export async function exchangeSlackOAuthCode(input: {
  config: SlackOAuthConfig;
  code: string;
  redirectUri: string;
}): Promise<SlackOAuthResult> {
  let data: {
    ok?: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string } | null;
  };
  try {
    const response = await fetch(SLACK_OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
    data = (await response.json()) as typeof data;
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (!data.ok || !data.access_token) {
    return { ok: false, error: shortToken(data.error) ?? "oauth_exchange_failed" };
  }
  return {
    ok: true,
    botToken: data.access_token,
    teamId: typeof data.team?.id === "string" ? data.team.id : undefined,
    teamName: typeof data.team?.name === "string" ? data.team.name : null,
    botUserId: typeof data.bot_user_id === "string" ? data.bot_user_id : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackChannelListResult {
  ok: boolean;
  channels?: SlackChannel[];
  error?: string;
}

/**
 * List the workspace's public channels for the in-app picker. Paginates via
 * `response_metadata.next_cursor`, bounded so a huge workspace can't run the
 * request unbounded. The bot token is sent only in the Authorization header and
 * never echoed back in the result.
 */
export async function listSlackPublicChannels(botToken: string): Promise<SlackChannelListResult> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
      const url = new URL(SLACK_CONVERSATIONS_LIST_URL);
      url.searchParams.set("types", "public_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", String(CHANNEL_PAGE_LIMIT));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        channels?: { id?: string; name?: string }[];
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) {
        return { ok: false, error: shortToken(data.error) ?? "conversations_list_failed" };
      }
      for (const channel of data.channels ?? []) {
        if (typeof channel.id === "string" && typeof channel.name === "string") {
          channels.push({ id: channel.id, name: channel.name });
        }
      }
      cursor = data.response_metadata?.next_cursor?.trim() ?? "";
      if (!cursor) break;
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels };
}

// ── HMAC-signed OAuth state token ────────────────────────────────────────────

export interface SlackStateClaims {
  organizationId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
}

const STATE_TTL_MS = 15 * 60 * 1000;
const STATE_VERSION = "slackv1";

export async function signSlackState(
  secret: string,
  claims: { organizationId: string; userId: string },
): Promise<string> {
  const payload: SlackStateClaims = {
    organizationId: claims.organizationId,
    userId: claims.userId,
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const body = `${STATE_VERSION}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const signature = await hmacSha256(secret, body);
  return `${body}.${base64UrlEncode(signature)}`;
}

export async function verifySlackState(
  secret: string,
  token: string,
): Promise<SlackStateClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payload, signature] = parts;
  if (version !== STATE_VERSION) return null;
  const expected = await hmacSha256(secret, `${version}.${payload}`);
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signature);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;
  let claims: SlackStateClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  if (typeof claims.organizationId !== "string" || !claims.organizationId) return null;
  if (typeof claims.userId !== "string" || !claims.userId) return null;
  if (typeof claims.nonce !== "string" || !claims.nonce) return null;
  if (typeof claims.expiresAt !== "number" || !Number.isFinite(claims.expiresAt)) return null;
  if (claims.expiresAt < Date.now()) return null;
  return claims;
}

// ── Message rendering ────────────────────────────────────────────────────────

export interface SlackNotificationPayload {
  title: string;
  packageLabel: string;
  source: string;
  risk?: string | null;
  recommendation?: string | null;
  findingsSummary?: string | null;
  repository?: string | null;
  environment?: string | null;
  statusLine?: string | null;
  dashboardUrl?: string | null;
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

export type SlackDeliveryStatusClass = "2xx" | "4xx" | "5xx" | "other";

export interface SlackDeliveryResult {
  ok: boolean;
  status?: number;
  statusClass?: SlackDeliveryStatusClass;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  reason?: string;
}

export function renderSlackMessage(payload: SlackNotificationPayload): SlackMessage {
  const summaryParts = [payload.title, payload.packageLabel];
  if (payload.risk) summaryParts.push(`risk ${payload.risk}`);
  const text = summaryParts.join(" — ");

  const fields: { type: "mrkdwn"; text: string }[] = [
    field("Package", payload.packageLabel),
    field("Source", payload.source),
    field("Risk", payload.risk ?? undefined),
    field("Findings", payload.findingsSummary ?? undefined),
    field("Repository", payload.repository ?? undefined),
    field("Environment", payload.environment ?? undefined),
    field("Recommendation", payload.recommendation ?? undefined),
  ].filter((value): value is { type: "mrkdwn"; text: string } => value !== null);

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(payload.title, 150), emoji: false },
    },
    { type: "section", fields },
  ];

  if (payload.statusLine) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(payload.statusLine, 2000) },
    });
  }

  if (payload.dashboardUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Inspect in Drydock", emoji: false },
          url: payload.dashboardUrl,
        },
      ],
    });
  }

  return { text, blocks };
}

export function renderSlackTestMessage(label?: string | null): SlackMessage {
  const trimmed = typeof label === "string" ? label.trim() : "";
  const detail = trimmed
    ? `Drydock can post release alerts to ${truncate(trimmed, 200)}. You're all set.`
    : "Drydock can post release alerts to this channel. You're all set.";
  return {
    text: "Drydock test notification",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Drydock test notification", emoji: false },
      },
      { type: "section", text: { type: "mrkdwn", text: detail } },
    ],
  };
}

/**
 * Post a rendered message to a public channel with `chat.postMessage`. Slack
 * returns HTTP 200 with `{ ok: false, error }` for application errors (e.g.
 * `channel_not_found`), and HTTP 429 with `Retry-After` when rate-limited. This
 * is best-effort and self-contained: the bot token and channel id never appear
 * in `reason`, and it never throws — callers must treat the result as advisory
 * and never let it block release processing.
 */
export async function postSlackMessage(
  botToken: string,
  channelId: string,
  message: SlackMessage,
): Promise<SlackDeliveryResult> {
  if (!botToken || !channelId) {
    return { ok: false, statusClass: "other", reason: "missing_credentials" };
  }
  try {
    const response = await fetch(SLACK_CHAT_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: channelId, text: message.text, blocks: message.blocks }),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
    const statusClass = classifyStatus(response.status);
    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        statusClass,
        rateLimited: true,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        reason: "rate_limited",
      };
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (data?.ok) {
      return { ok: true, status: response.status, statusClass };
    }
    return {
      ok: false,
      status: response.status,
      statusClass,
      reason: shortToken(data?.error) ?? `http_${response.status}`,
    };
  } catch (err) {
    return { ok: false, statusClass: "other", reason: errorMessage(err) };
  }
}

function field(label: string, value: string | undefined): { type: "mrkdwn"; text: string } | null {
  if (!value) return null;
  return { type: "mrkdwn", text: `*${label}*\n${truncate(value, 1900)}` };
}

function classifyStatus(status: number): SlackDeliveryStatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Slack error codes are short snake_case tokens; keep them tiny and strip any
// stray whitespace so a malformed value can never smuggle in a long string.
function shortToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, "_");
  if (!trimmed) return null;
  return truncate(trimmed, 80);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
