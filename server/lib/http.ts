import type { Context } from "hono";
import { RateLimitError, type RateLimitInput, enforceRateLimit } from "../db";
import type { AppDb } from "../db/client";
import type { Bindings, Variables } from "../types";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export function rateLimitResponse(c: AppContext, error: string, err: RateLimitError) {
  return c.json({ error, retryAfterSeconds: err.retryAfterSeconds }, 429, {
    "retry-after": String(err.retryAfterSeconds),
  });
}

/**
 * Enforce a rate limit and return a 429 response on violation.
 *
 * Replaces the repeated try/catch + `instanceof RateLimitError` boilerplate
 * scattered across route handlers. Returns `null` when the limit is not
 * exceeded, or a ready-to-return `Response` when it is.
 */
export async function withRateLimit(
  c: AppContext,
  db: AppDb,
  input: RateLimitInput,
  message: string,
): Promise<Response | null> {
  try {
    await enforceRateLimit(db, input);
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, message, err);
    }
    throw err;
  }
}
