import type { Context } from "hono";
import { matchedRoutes } from "hono/route";
import { createDb } from "../db/client";
import { findApiKeyByHash, markApiKeyUsedIfStale } from "../db/api-keys";
import {
  API_KEY_ATTEMPTS_PER_IP_PER_MINUTE,
  API_KEY_REQUESTS_PER_MINUTE,
  API_KEY_USE_DEBOUNCE_MS,
  apiKeyExpired,
  apiKeyMayReach,
  apiKeyUseIsStale,
  hashApiKey,
  isWellFormedApiKey,
} from "../lib/auth/api-keys";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import { guardRateLimit } from "../lib/rate-limit";
import type { Bindings, Variables } from "../types";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const ROUTE_METHOD_ALL = "ALL";

/**
 * The route that will answer this request: the first non-middleware route
 * Hono matched after the current one. Middleware (`app.use`) registers as
 * `ALL`; the first method-bound route after it is the handler that responds.
 */
function answeringRoute(c: AppContext): { method: string; path: string } | null {
  const routes = matchedRoutes(c);
  for (let index = c.req.routeIndex + 1; index < routes.length; index += 1) {
    const route = routes[index];
    if (route.method !== ROUTE_METHOD_ALL) return { method: route.method, path: route.path };
  }
  return null;
}

function rejectKey(c: AppContext): Response {
  return c.json({ error: "invalid API key", code: "invalid_api_key" }, 401, {
    "www-authenticate": 'Bearer realm="drydock", error="invalid_token"',
  });
}

/**
 * Authenticates an `Authorization: Bearer ddk_…` request and, on success,
 * attaches the key as `c.var.apiKey` with no `authSession`. Returns the
 * response to send instead when the key is unknown, expired, used on an
 * endpoint outside its access level's allowlist, or over its rate budget. Cookies are never
 * consulted for such a request.
 */
export async function authenticateApiKeyRequest(
  c: AppContext,
  token: string,
): Promise<Response | null> {
  if (!isWellFormedApiKey(token)) return rejectKey(c);

  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) {
    const limited = await guardRateLimit(
      c,
      { key: `api-key-ip:${ip}`, limit: API_KEY_ATTEMPTS_PER_IP_PER_MINUTE, windowMs: 60_000 },
      "too many API key requests",
    );
    if (limited) return limited;
  }

  const db = createDb(c.env.DB);
  const key = await findApiKeyByHash(db, await hashApiKey(token));
  const nowMs = Date.now();
  if (!key || apiKeyExpired(key.expiresAt, nowMs)) return rejectKey(c);

  const verdict = apiKeyMayReach(answeringRoute(c), key.access);
  if (verdict === "endpoint_not_allowed") {
    return c.json(
      { error: "this endpoint does not accept API keys", code: "api_key_endpoint_not_allowed" },
      403,
    );
  }
  if (verdict === "access_insufficient") {
    return c.json(
      {
        error: "this API key is read-only; starting reviews needs a key with scan access",
        code: "api_key_access_insufficient",
      },
      403,
    );
  }

  const limited = await guardRateLimit(
    c,
    { key: `api-key:${key.id}`, limit: API_KEY_REQUESTS_PER_MINUTE, windowMs: 60_000 },
    "API key rate limit exceeded",
  );
  if (limited) return limited;

  c.set("apiKey", {
    id: key.id,
    organizationId: key.organizationId,
    access: key.access,
    userId: key.createdByUserId,
    name: key.name,
    prefix: key.prefix,
  });

  if (apiKeyUseIsStale(key.lastUsedAt, nowMs)) {
    c.executionCtx.waitUntil(
      markApiKeyUsedIfStale(
        db,
        key.id,
        new Date(nowMs - API_KEY_USE_DEBOUNCE_MS),
        new Date(nowMs),
      ).catch((err: unknown) => {
        emitOperationalEvent("warn", "api_key.last_used_update_failed", {
          apiKeyId: key.id,
          error: describeOperationalError(err),
        });
      }),
    );
  }
  return null;
}
