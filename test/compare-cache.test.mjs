import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { computeCompareCacheKey, readCompareCache } = await import("../server/lib/compare-cache");

describe("compare cache key", () => {
  test("differs between registries even for the same package@version", async () => {
    const a = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
      "org:a",
    );
    const b = await computeCompareCacheKey(
      "https://npm.internal.example.com",
      "https://npm.internal.example.com/acme/-/acme-1.0.0.tgz",
      "org:a",
    );
    expect(a).not.toBe(b);
  });

  test("differs between tarball URLs on the same registry", async () => {
    const a = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
      "org:a",
    );
    const b = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.1.tgz",
      "org:a",
    );
    expect(a).not.toBe(b);
  });

  test("differs between organization cache scopes", async () => {
    const a = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
      "org:a",
    );
    const b = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
      "org:b",
    );
    expect(a).not.toBe(b);
  });

  test("uses a v3 prefix so old unscoped entries cannot be hit", async () => {
    const key = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
      "org:a",
    );
    expect(key.startsWith("compare:v3:")).toBe(true);
  });
});

describe("compare cache reads", () => {
  test("reads through KV's colo cache so repeat diff browsing skips the central stores", async () => {
    const calls = [];
    const env = {
      COMPARE_CACHE: {
        get: async (key, options) => {
          calls.push({ key, options });
          return null;
        },
      },
    };
    await readCompareCache(env, "compare:v3:abc");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.type).toBe("json");
    expect(calls[0].options.cacheTtl).toBeGreaterThanOrEqual(60);
  });
});
