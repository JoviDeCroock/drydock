import { eq, lt, sql } from "drizzle-orm";
import { RateLimitError, type RateLimitInput } from "../lib/platform/rate-limit-contract";
import { type AppDb, createDb } from "./client";
import { rateLimits } from "./schema";

/**
 * Fixed-window counter in D1 for the windows the native bindings cannot express.
 * `platform/rate-limit.ts` is the only caller that decides when this runs.
 */
export async function enforceD1RateLimit(
  env: Cloudflare.Env,
  input: RateLimitInput,
  nowMs: number,
): Promise<void> {
  await enforceD1RateLimitWith(createDb(env.DB), input, nowMs);
}

async function enforceD1RateLimitWith(
  db: AppDb,
  input: RateLimitInput,
  nowMs: number,
): Promise<void> {
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
