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
