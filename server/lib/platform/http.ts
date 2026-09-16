import type { Context, Env } from "hono";
import { type RateLimitError } from "./rate-limit";

// Generic over the Hono env so this stays free of the app's binding/variable
// types; `Context` is invariant, so a fixed wider type would not accept routes.
export function rateLimitResponse<E extends Env>(
  c: Context<E>,
  error: string,
  err: RateLimitError,
) {
  return c.json({ error, retryAfterSeconds: err.retryAfterSeconds }, 429, {
    "retry-after": String(err.retryAfterSeconds),
  });
}

export { coloCache } from "./colo-cache";

// Origin for links we hand out (share URLs, feed report links). Prefer the
// canonical configured origin so copied links never pin a preview host.
export function canonicalOrigin<E extends Env & { Bindings: { BETTER_AUTH_URL?: string } }>(
  c: Context<E>,
): string {
  try {
    if (c.env.BETTER_AUTH_URL) return new URL(c.env.BETTER_AUTH_URL).origin;
  } catch {
    // fall through to the request origin
  }
  return new URL(c.req.url).origin;
}
