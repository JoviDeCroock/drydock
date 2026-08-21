import { NATIVE_TIERS } from "../../server/lib/platform/rate-limit";

/**
 * Stand-ins for the native Cloudflare Rate Limiting bindings.
 *
 * `test/config/wrangler.jsonc` binds the real (Miniflare-emulated) limiters, so a test
 * that wants to observe the *blocked* path would otherwise have to issue `limit`
 * real requests. These doubles let a test force an outcome and assert which keys
 * the limiter was asked about.
 */
export interface RateLimiterDouble {
  limit(options: { key: string }): Promise<{ success: boolean }>;
  keys: string[];
}

export function rateLimiterDouble(success: boolean): RateLimiterDouble {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success };
    },
  };
}

/**
 * Env overrides that replace every native tier with the same double, so a caller
 * does not need to know which tier a given limit maps to.
 */
export function rateLimitBindingOverrides(limiter: RateLimiterDouble): Partial<Cloudflare.Env> {
  const overrides: Record<string, RateLimiterDouble> = {};
  for (const tier of NATIVE_TIERS) overrides[tier.binding] = limiter;
  return overrides as Partial<Cloudflare.Env>;
}

/** Every native tier reports the caller as over budget. */
export function exhaustedRateLimitBindings(): {
  overrides: Partial<Cloudflare.Env>;
  limiter: RateLimiterDouble;
} {
  const limiter = rateLimiterDouble(false);
  return { overrides: rateLimitBindingOverrides(limiter), limiter };
}
