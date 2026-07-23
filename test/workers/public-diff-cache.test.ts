import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  computePublicDiffCacheKey,
  readPublicDiffCache,
  serializePublicDiffCachePayload,
  writePublicDiffCache,
  type PublicPackageDiff,
} from "../../server/lib/public-diff";
import { PYPI_RULES_VERSION } from "../../server/lib/adapters/pypi/types";
import { DETERMINISTIC_RULES_VERSION } from "../../server/lib/review";

function payload(textSample = "export const value = 1;\n"): PublicPackageDiff {
  return {
    ecosystem: "npm",
    packageName: "cache-test-package",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [
      { path: "index.js", size: textSample.length, sha256: "before", flags: [], textSample },
    ],
    toFiles: [
      { path: "index.js", size: textSample.length, sha256: "after", flags: [], textSample },
    ],
    diff: [{ path: "index.js", status: "modified", flags: [] }],
    packageJsonDiff: {},
    findings: [],
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      aiRisk: "low",
    },
    cachedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("public diff cache", () => {
  test("versions computed results by deterministic rules and risk schema", async () => {
    const key = await computePublicDiffCacheKey({
      ecosystem: "npm",
      registryUrl: "https://registry.npmjs.org",
      packageName: "cache-test-package",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });

    expect(key).toContain(`rules=${DETERMINISTIC_RULES_VERSION}`);
    expect(key).toContain("risk=1");
  });

  test("keys PyPI pairs by ecosystem, both rules versions, and normalized name", async () => {
    const pypiKey = await computePublicDiffCacheKey({
      ecosystem: "pypi",
      registryUrl: "https://pypi.org/pypi",
      packageName: "Cache.Test_Package",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });

    expect(pypiKey).toContain(":pypi:");
    expect(pypiKey).toContain(`rules=${DETERMINISTIC_RULES_VERSION}+pypi-${PYPI_RULES_VERSION}`);
    // PyPI names are case- and separator-insensitive; both spellings must hit
    // the same cache entry.
    expect(
      await computePublicDiffCacheKey({
        ecosystem: "pypi",
        registryUrl: "https://pypi.org/pypi",
        packageName: "cache-test-package",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
      }),
    ).toBe(pypiKey);
  });

  test("serves an awaited colo write even when KV still returns a cached miss", async () => {
    const key = `public-diff-test:${crypto.randomUUID()}`;
    const cacheEnv = {
      ...env,
      COMPARE_CACHE: {
        get: async () => null,
        put: async () => undefined,
      },
    } as unknown as Cloudflare.Env;

    await writePublicDiffCache(cacheEnv, key, payload());
    const cached = await readPublicDiffCache(cacheEnv, key);

    expect(cached?.packageName).toBe("cache-test-package");
    expect(cached?.toFiles[0]?.textSample).toContain("export const value");
  });

  test("uses UTF-8 bytes when deciding whether to omit samples", () => {
    const unicodeSample = "🚢".repeat(30);
    const unicodePayload = payload(unicodeSample);
    const utf16LengthThreshold = JSON.stringify(unicodePayload).length + 1;

    const serialized = serializePublicDiffCachePayload(unicodePayload, utf16LengthThreshold);
    const cached = JSON.parse(serialized) as PublicPackageDiff;

    expect(cached.textSamplesOmitted).toBe(true);
    expect(cached.fromFiles[0]).not.toHaveProperty("textSample");
    expect(cached.toFiles[0]).not.toHaveProperty("textSample");
  });
});
