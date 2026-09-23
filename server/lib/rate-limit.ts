import type { Context, Env } from "hono";
import { enforceD1RateLimit } from "../db/rate-limits";
import { rateLimitResponse } from "./platform/http";
import { enforceRateLimit as enforceWithFallback } from "./platform/rate-limit";
import { RateLimitError, type RateLimitInput } from "./platform/rate-limit-contract";

export { RateLimitError, type RateLimitInput } from "./platform/rate-limit-contract";
export { ORGANIZATION_SCAN_LIMIT, ORGANIZATION_SCAN_WINDOW_MS } from "./platform/rate-limit";

/**
 * The app's limiter: native Cloudflare tiers first, the D1 bucket table for
 * the windows no tier can express. Routes call this (or `guardRateLimit`), never
 * the platform limiter directly, so the fallback is wired in exactly one place.
 */
export function enforceRateLimit(env: Cloudflare.Env, input: RateLimitInput): Promise<void> {
  return enforceWithFallback(env, input, { fallback: enforceD1RateLimit });
}

/**
 * `enforceRateLimit` for handlers: the 429 to return when the budget is spent,
 * `null` to continue. Any other limiter failure still propagates.
 */
export async function guardRateLimit<E extends Env & { Bindings: Cloudflare.Env }>(
  c: Context<E>,
  input: RateLimitInput,
  message: string,
): Promise<Response | null> {
  try {
    await enforceRateLimit(c.env, input);
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitResponse(c, message, err);
    throw err;
  }
  return null;
}
