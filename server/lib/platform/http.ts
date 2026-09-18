import type { Context, Env } from "hono";
import { isRecord } from "./guards";
import { type RateLimitError } from "./rate-limit-contract";

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

/**
 * The request body as a plain object. Malformed JSON, a missing body, and a
 * non-object document (`null`, an array, a string) all read as `{}`, so every
 * field check below stays a plain `typeof` on an `unknown`. `T` only names the
 * fields a handler will look at; nothing is validated here. The parameter is
 * structural on purpose: `Context` is invariant in its env, and an explicit `T`
 * at the call site would otherwise pin an env parameter to its default.
 */
export async function readJsonObject<T extends object = Record<string, unknown>>(c: {
  req: { json(): Promise<unknown> };
}): Promise<Partial<T>> {
  const body: unknown = await c.req.json().catch(() => null);
  return (isRecord(body) ? body : {}) as Partial<T>;
}

/** A `?limit=` query clamped to `[1, max]`; anything non-numeric is the default. */
export function parseLimitQuery(
  raw: string | undefined,
  bounds: { default: number; max: number },
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return bounds.default;
  return Math.min(bounds.max, Math.max(1, Math.floor(parsed)));
}
