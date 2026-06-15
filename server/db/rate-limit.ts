import { eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { rateLimits } from "./schema";

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000;
let nextRateLimitCleanupAtMs = 0;

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

export async function enforceRateLimit(db: AppDb, input: RateLimitInput) {
  const nowMs = Date.now();
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
  if (nowMs >= nextRateLimitCleanupAtMs) {
    nextRateLimitCleanupAtMs = nowMs + RATE_LIMIT_CLEANUP_INTERVAL_MS;
    await db.delete(rateLimits).where(lt(rateLimits.expiresAt, new Date(nowMs - input.windowMs)));
  }
  if ((entry?.count ?? 0) > input.limit) {
    throw new RateLimitError(Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 1000)));
  }
}
