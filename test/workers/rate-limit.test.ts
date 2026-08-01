import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import {
  NATIVE_TIERS,
  RateLimitError,
  enforceRateLimit,
  pruneExpiredRateLimitBuckets,
} from "../../server/lib/platform/rate-limit";
import {
  exhaustedRateLimitBindings,
  rateLimitBindingOverrides,
  rateLimiterDouble,
} from "./rate-limit-doubles";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Miniflare's local Rate Limiting bindings are in-memory per pool worker and are
// only cleared when the wall-clock window rolls over, so every test uses a key
// nothing else touches.
function uniqueKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function countD1Buckets(keyPrefix: string): Promise<number> {
  // Filtered in JS rather than with LIKE: D1 caps LIKE pattern complexity and
  // these keys carry a UUID.
  const rows = await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
  return rows.results.filter((row) => row.key.startsWith(keyPrefix)).length;
}

/** An env whose D1 binding fails on any use, to prove a path never reaches it. */
function envWithoutD1(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  const forbidden = () => {
    throw new Error("D1 must not be used on this path");
  };
  return {
    ...env,
    DB: {
      prepare: forbidden,
      batch: forbidden,
      exec: forbidden,
      dump: forbidden,
      withSession: forbidden,
    } as unknown as D1Database,
    ...overrides,
  };
}

/** An env with no native Rate Limiting bindings at all. */
function envWithoutNativeLimiters(): Cloudflare.Env {
  const stripped: Record<string, unknown> = { ...env };
  for (const tier of NATIVE_TIERS) delete stripped[tier.binding];
  return stripped as Cloudflare.Env;
}

describe("enforceRateLimit — native binding", () => {
  test("allows a per-minute budget and blocks past it without touching D1", async () => {
    const key = uniqueKey("test-native-allow");
    const noD1 = envWithoutD1();

    for (let i = 0; i < 10; i++) {
      await expect(
        enforceRateLimit(noD1, { key, limit: 10, windowMs: MINUTE_MS }),
      ).resolves.toBeUndefined();
    }

    await expect(
      enforceRateLimit(noD1, { key, limit: 10, windowMs: MINUTE_MS }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(await countD1Buckets(key)).toBe(0);
  });

  test("keys are independent", async () => {
    const noD1 = envWithoutD1();
    const blocked = uniqueKey("test-native-scope-a");
    for (let i = 0; i < 10; i++) {
      await enforceRateLimit(noD1, { key: blocked, limit: 10, windowMs: MINUTE_MS });
    }
    await expect(
      enforceRateLimit(noD1, { key: blocked, limit: 10, windowMs: MINUTE_MS }),
    ).rejects.toBeInstanceOf(RateLimitError);

    await expect(
      enforceRateLimit(noD1, {
        key: uniqueKey("test-native-scope-b"),
        limit: 10,
        windowMs: MINUTE_MS,
      }),
    ).resolves.toBeUndefined();
  });

  test("reports the seconds left in the current wall-clock minute", async () => {
    // Pin the clock so the expected value is computed independently of the
    // implementation rather than re-derived from it.
    vi.useFakeTimers();
    try {
      // 20 seconds past a minute boundary, so 40 seconds remain.
      vi.setSystemTime(new Date("2026-07-15T00:03:20.000Z"));
      const { overrides } = exhaustedRateLimitBindings();
      const error = await enforceRateLimit(envWithoutD1(overrides), {
        key: uniqueKey("test-native-retry-after"),
        limit: 30,
        windowMs: MINUTE_MS,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails closed when the limiter binding throws", async () => {
    // A limiter that errors must propagate, not read as "allowed", and must not
    // silently fall back to the D1 counter it was introduced to replace.
    const throwing = {
      limit: () => Promise.reject(new Error("rate limiter unavailable")),
    } as unknown as RateLimit;

    await expect(
      enforceRateLimit(envWithoutD1({ RATE_LIMIT_10_PER_MINUTE: throwing }), {
        key: uniqueKey("test-native-throws"),
        limit: 10,
        windowMs: MINUTE_MS,
      }),
    ).rejects.toThrow("rate limiter unavailable");
  });

  test("consults the tier matching the requested limit", async () => {
    const limiter = rateLimiterDouble(true);
    const key = uniqueKey("test-native-tier");
    await enforceRateLimit(envWithoutD1({ RATE_LIMIT_240_PER_MINUTE: limiter as never }), {
      key,
      limit: 240,
      windowMs: MINUTE_MS,
    });
    expect(limiter.keys).toEqual([key]);
  });
});

describe("enforceRateLimit — D1 fallback", () => {
  test("enforces a per-minute limit when the binding is missing", async () => {
    const key = uniqueKey("test-fallback");
    const fallbackEnv = envWithoutNativeLimiters();

    for (let i = 0; i < 10; i++) {
      await enforceRateLimit(fallbackEnv, { key, limit: 10, windowMs: MINUTE_MS });
    }
    await expect(
      enforceRateLimit(fallbackEnv, { key, limit: 10, windowMs: MINUTE_MS }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(await countD1Buckets(key)).toBe(1);
  });
});

describe("enforceRateLimit — windows the binding cannot express", () => {
  test("an hourly budget is counted in D1 behind a native burst guard", async () => {
    const key = uniqueKey("test-hourly");
    const limiter = rateLimiterDouble(true);

    for (let i = 0; i < 10; i++) {
      await enforceRateLimit(
        { ...env, ...rateLimitBindingOverrides(limiter) },
        {
          key,
          limit: 10,
          windowMs: HOUR_MS,
        },
      );
    }
    await expect(
      enforceRateLimit(
        { ...env, ...rateLimitBindingOverrides(limiter) },
        {
          key,
          limit: 10,
          windowMs: HOUR_MS,
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);

    // The long window is the authority; the guard only ever saw a burst-scoped
    // key, so it cannot collide with a per-minute budget on the same key.
    expect(await countD1Buckets(key)).toBe(1);
    expect(new Set(limiter.keys)).toEqual(new Set([`burst:${key}`]));
  });

  test("a burst guard rejection short-circuits the D1 write", async () => {
    const { overrides, limiter } = exhaustedRateLimitBindings();
    const key = uniqueKey("test-hourly-burst");

    await expect(
      enforceRateLimit(envWithoutD1(overrides), { key, limit: 5, windowMs: HOUR_MS }),
    ).rejects.toBeInstanceOf(RateLimitError);
    // limit 5 has no exact tier; the smallest tier at or above it guards it.
    expect(limiter.keys).toEqual([`burst:${key}`]);
  });

  test("a burst guard rejection reports the long window, not its own minute", async () => {
    // Every request the guard admitted this minute also spent the long-window
    // budget, so telling the caller to retry in under a minute would only earn a
    // second 429. Main reported the long window here and so must this.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T00:03:20.000Z"));
      const { overrides } = exhaustedRateLimitBindings();
      const error = await enforceRateLimit(envWithoutD1(overrides), {
        key: uniqueKey("test-hourly-retry-after"),
        limit: 10,
        windowMs: HOUR_MS,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RateLimitError);
      // 56 minutes 40 seconds remain in the hour bucket.
      expect((error as RateLimitError).retryAfterSeconds).toBe(56 * 60 + 40);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pruneExpiredRateLimitBuckets", () => {
  test("drops expired buckets and keeps live ones", async () => {
    const db = createDb(env.DB);
    const now = new Date();
    const expired = uniqueKey("test-prune-expired");
    const live = uniqueKey("test-prune-live");
    await db.insert(schema.rateLimits).values([
      {
        key: expired,
        count: 1,
        expiresAt: new Date(now.getTime() - 1000),
        updatedAt: now,
      },
      {
        key: live,
        count: 1,
        expiresAt: new Date(now.getTime() + HOUR_MS),
        updatedAt: now,
      },
    ]);

    await pruneExpiredRateLimitBuckets(db, now);

    expect(await countD1Buckets(expired)).toBe(0);
    expect(await countD1Buckets(live)).toBe(1);
  });
});
