import { eq, lt, sql } from "drizzle-orm";
import { type AppDb, createDb } from "../../db/client";
import { rateLimits } from "../../db/schema";
import { emitOperationalEvent } from "./observability";

export interface RateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export const ORGANIZATION_SCAN_LIMIT = 10;
export const ORGANIZATION_SCAN_WINDOW_MS = 60 * 60 * 1000;

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

// Keep tiers aligned with every ratelimits declaration; missing tiers fall back to D1.
export const NATIVE_TIERS: readonly NativeTier[] = [
  { limit: 10, binding: "RATE_LIMIT_10_PER_MINUTE" },
  { limit: 20, binding: "RATE_LIMIT_20_PER_MINUTE" },
  { limit: 30, binding: "RATE_LIMIT_30_PER_MINUTE" },
  { limit: 60, binding: "RATE_LIMIT_60_PER_MINUTE" },
  { limit: 120, binding: "RATE_LIMIT_120_PER_MINUTE" },
  { limit: 240, binding: "RATE_LIMIT_240_PER_MINUTE" },
];

const warnedMissingTiers = new Set<string>();

function nativeLimiter(env: Cloudflare.Env, binding: NativeTierBinding): RateLimit | null {
  const candidate = env[binding];
  return candidate && typeof candidate.limit === "function" ? candidate : null;
}

function retryAfterSecondsFor(windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

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
    const guard = NATIVE_TIERS.find((candidate) => candidate.limit >= input.limit);
    const limiter = guard ? nativeLimiter(env, guard.binding) : null;
    if (limiter) {
      const { success } = await limiter.limit({ key: `burst:${input.key}` });
      // The burst guard can reject only after the long-window budget is also spent.
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

export async function pruneExpiredRateLimitBuckets(db: AppDb, now: Date): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now));
}
