import { eq, lt, sql } from "drizzle-orm";
import { type AppDb, createDb } from "../../db/client";
import { rateLimits } from "../../db/schema";
import { emitOperationalEvent } from "./observability";

/**
 * Request rate limiting.
 *
 * The primary backend is Cloudflare's native Rate Limiting binding: a per-colo
 * fixed-window counter that costs no D1 write, so a flood of anonymous `/diff`
 * traffic or credential-stuffing attempts never reaches the single D1 writer.
 *
 * The binding's `{limit, period}` pair is static per binding and `period` may
 * only be 10 or 60 seconds, so `wrangler.jsonc` declares one binding per
 * per-minute limit the app enforces and `NATIVE_TIERS` maps a call's
 * `{limit, windowMs}` onto them.
 *
 * Windows longer than a minute — the hourly and 15-minute budgets on
 * human-initiated actions like sign-up, organization creation, or connecting
 * npm — cannot be expressed by the binding at all. Those keep the D1
 * `rate_limits` counter, but first pass through a native per-minute burst guard
 * whose limit is >= the long-window limit. A burst guard can therefore only
 * reject traffic the long window would reject anyway, while capping how many D1
 * writes a single key can force per minute per colo.
 *
 * Semantics that changed when the native binding took over (documented in
 * `docs/security-model.md`):
 *
 * - Counters are per-colo, not global. A distributed client gets up to
 *   `limit` per colo per window instead of `limit` globally.
 * - Windows are fixed (aligned to wall-clock), same as the previous D1 bucket
 *   scheme, so up to `2 * limit` requests can still land across a boundary.
 * - `Retry-After` is derived from the wall-clock window rather than read back
 *   from a counter row; the binding reports only allowed/blocked.
 */

export interface RateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super("rate limit exceeded");
    this.name = "RateLimitError";
  }
}

const NATIVE_WINDOW_MS = 60_000;

type NativeTierBinding =
  | "RATE_LIMIT_10_PER_MINUTE"
  | "RATE_LIMIT_20_PER_MINUTE"
  | "RATE_LIMIT_30_PER_MINUTE"
  | "RATE_LIMIT_60_PER_MINUTE"
  | "RATE_LIMIT_120_PER_MINUTE"
  | "RATE_LIMIT_240_PER_MINUTE";

interface NativeTier {
  limit: number;
  binding: NativeTierBinding;
}

/**
 * Ordered ascending by limit. Adding a per-minute limit at a call site requires
 * a tier here *and* a matching `ratelimits` entry in `wrangler.jsonc` and
 * `wrangler.test.jsonc`; without one the call silently degrades to the D1
 * counter and emits `rate_limit.tier_missing`.
 */
export const NATIVE_TIERS: readonly NativeTier[] = [
  { limit: 10, binding: "RATE_LIMIT_10_PER_MINUTE" },
  { limit: 20, binding: "RATE_LIMIT_20_PER_MINUTE" },
  { limit: 30, binding: "RATE_LIMIT_30_PER_MINUTE" },
  { limit: 60, binding: "RATE_LIMIT_60_PER_MINUTE" },
  { limit: 120, binding: "RATE_LIMIT_120_PER_MINUTE" },
  { limit: 240, binding: "RATE_LIMIT_240_PER_MINUTE" },
];

// One warning per missing tier per isolate: a misconfigured deployment should
// be visible in logs without turning every request into a log line.
const warnedMissingTiers = new Set<string>();

function nativeLimiter(env: Cloudflare.Env, binding: NativeTierBinding): RateLimit | null {
  const candidate = env[binding];
  return candidate && typeof candidate.limit === "function" ? candidate : null;
}

/**
 * Seconds until the end of the wall-clock-aligned window containing `nowMs`.
 *
 * Exact for the D1 counter, which buckets on exactly this boundary. For the
 * native binding it is best-effort: the binding reports only allowed/blocked and
 * does not expose where its window starts, so we assume the same alignment its
 * local implementation uses. A `Retry-After` that is off by part of a window is
 * a hint, never a correctness boundary — the next call is re-checked anyway.
 */
function retryAfterSecondsFor(windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

/**
 * Enforce `input.limit` requests per `input.windowMs` for `input.key`.
 *
 * Throws `RateLimitError` when the caller is over budget; returns normally
 * otherwise. Callers translate the error into a 429 (`rateLimitResponse`).
 */
export async function enforceRateLimit(env: Cloudflare.Env, input: RateLimitInput): Promise<void> {
  const nowMs = Date.now();

  if (input.windowMs === NATIVE_WINDOW_MS) {
    const tier = NATIVE_TIERS.find((candidate) => candidate.limit === input.limit);
    const limiter = tier ? nativeLimiter(env, tier.binding) : null;
    if (limiter) {
      const { success } = await limiter.limit({ key: input.key });
      if (!success) throw new RateLimitError(retryAfterSecondsFor(NATIVE_WINDOW_MS, nowMs));
      return;
    }
    warnMissingTier(input);
  } else {
    // Burst guard for a window the binding cannot express. Its limit is >= the
    // real budget, so it never rejects a request the D1 counter would allow.
    const guard = NATIVE_TIERS.find((candidate) => candidate.limit >= input.limit);
    const limiter = guard ? nativeLimiter(env, guard.binding) : null;
    if (limiter) {
      const { success } = await limiter.limit({ key: `burst:${input.key}` });
      // Report the *long* window, not the guard's minute. Every request the
      // guard let through this minute also incremented the D1 counter, and the
      // guard's limit is >= the long-window limit, so by the time the guard
      // rejects, the long-window budget is necessarily spent too — the D1
      // counter would answer with this same value. Reporting the minute instead
      // would invite a retry that can only earn a second 429.
      if (!success) throw new RateLimitError(retryAfterSecondsFor(input.windowMs, nowMs));
    }
  }

  await enforceD1RateLimit(createDb(env.DB), input, nowMs);
}

function warnMissingTier(input: RateLimitInput): void {
  const tierKey = `${input.limit}/${input.windowMs}`;
  if (warnedMissingTiers.has(tierKey)) return;
  warnedMissingTiers.add(tierKey);
  emitOperationalEvent("warn", "rate_limit.tier_missing", {
    limit: input.limit,
    windowMs: input.windowMs,
  });
}

/**
 * D1 fixed-window counter. Reached for windows longer than a minute, and as a
 * degraded fallback when a per-minute Rate Limiting binding is absent (a
 * self-hosted deployment that skipped the `ratelimits` config, or a test env
 * that deliberately omits it).
 */
async function enforceD1RateLimit(db: AppDb, input: RateLimitInput, nowMs: number): Promise<void> {
  const bucket = Math.floor(nowMs / input.windowMs);
  const key = `${input.key}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * input.windowMs);
  const now = new Date(nowMs);

  await db
    .insert(rateLimits)
    .values({
      key,
      count: 1,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`${rateLimits.count} + 1`,
        updatedAt: now,
      },
    });

  const [entry] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if ((entry?.count ?? 0) > input.limit) {
    throw new RateLimitError(Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 1000)));
  }
}

/**
 * Drop expired D1 buckets. Called from the scheduled handler — the previous
 * home was a per-isolate timer piggybacked on whichever request happened to
 * cross the 5-minute mark, which put an unbounded DELETE on the hot path.
 */
export async function pruneExpiredRateLimitBuckets(db: AppDb, now: Date): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now));
}
