import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { computeCompareCacheKey } = await import("../server/lib/compare-cache.ts");

describe("compare cache key", () => {
  test("differs between registries even for the same package@version", async () => {
    const a = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
    );
    const b = await computeCompareCacheKey(
      "https://npm.internal.example.com",
      "https://npm.internal.example.com/acme/-/acme-1.0.0.tgz",
    );
    expect(a).not.toBe(b);
  });

  test("differs between tarball URLs on the same registry", async () => {
    const a = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
    );
    const b = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.1.tgz",
    );
    expect(a).not.toBe(b);
  });

  test("uses a v2 prefix so old v1 entries cannot be hit", async () => {
    const key = await computeCompareCacheKey(
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
    );
    expect(key.startsWith("compare:v2:")).toBe(true);
  });
});
