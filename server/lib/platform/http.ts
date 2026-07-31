import type { Context } from "hono";
import { type RateLimitError } from "./rate-limit";
import type { Bindings, Variables } from "../../types";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export function rateLimitResponse(c: AppContext, error: string, err: RateLimitError) {
  return c.json({ error, retryAfterSeconds: err.retryAfterSeconds }, 429, {
    "retry-after": String(err.retryAfterSeconds),
  });
}

// The Workers runtime exposes the per-colo cache as `caches.default`, but the
// DOM lib wins the global CacheStorage type in this repo's single tsconfig and
// doesn't know the property.
export function coloCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

// Origin for links we hand out (share URLs, feed report links). Prefer the
// canonical configured origin so copied links never pin a preview host.
export function canonicalOrigin(c: AppContext): string {
  try {
    if (c.env.BETTER_AUTH_URL) return new URL(c.env.BETTER_AUTH_URL).origin;
  } catch {
    // fall through to the request origin
  }
  return new URL(c.req.url).origin;
}
