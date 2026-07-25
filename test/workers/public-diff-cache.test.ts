import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  computePublicDiffCacheKey,
  jsonStringByteLength,
  readPublicDiffCache,
  SAMPLE_OMITTED_FLAG,
  serializePublicDiffCachePayload,
  utf8ByteLength,
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

    expect(key).toContain("public-diff:v5:npm:");
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

    expect(pypiKey).toContain("public-diff:v6:pypi:");
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
    expect(cached.toFiles[0]?.flags).toContain(SAMPLE_OMITTED_FLAG);
  });

  test("keeps changed-file samples and drops unchanged ones when over budget", () => {
    const changedSample = "export const changed = 1;\n";
    const bulkySample = "x".repeat(20_000);
    const oversized: PublicPackageDiff = {
      ...payload(),
      fromFiles: [
        { path: "index.js", size: 1, sha256: "a", flags: [], textSample: changedSample },
        { path: "vendor/bundle.js", size: 2, sha256: "b", flags: [], textSample: bulkySample },
      ],
      toFiles: [
        { path: "index.js", size: 1, sha256: "c", flags: [], textSample: changedSample },
        { path: "vendor/bundle.js", size: 2, sha256: "b", flags: [], textSample: bulkySample },
      ],
      diff: [
        { path: "index.js", status: "modified", flags: [] },
        { path: "vendor/bundle.js", status: "unchanged", flags: [] },
      ],
    };
    // Room for the changed file's two sides, nowhere near enough for the bulky
    // unchanged one.
    const threshold = JSON.stringify({ ...oversized, fromFiles: [], toFiles: [] }).length + 2_000;

    const cached = JSON.parse(
      serializePublicDiffCachePayload(oversized, threshold),
    ) as PublicPackageDiff;

    const changed = (files: PublicPackageDiff["fromFiles"]) =>
      files.find((file) => file.path === "index.js");
    const unchanged = (files: PublicPackageDiff["fromFiles"]) =>
      files.find((file) => file.path === "vendor/bundle.js");

    expect(cached.textSamplesOmitted).toBe(true);
    // Both sides of the changed path survive, so it still renders as a diff
    // rather than a whole-file addition.
    expect(changed(cached.fromFiles)?.textSample).toBe(changedSample);
    expect(changed(cached.toFiles)?.textSample).toBe(changedSample);
    expect(changed(cached.toFiles)?.flags).not.toContain(SAMPLE_OMITTED_FLAG);
    expect(unchanged(cached.fromFiles)).not.toHaveProperty("textSample");
    expect(unchanged(cached.toFiles)).not.toHaveProperty("textSample");
    expect(unchanged(cached.toFiles)?.flags).toContain(SAMPLE_OMITTED_FLAG);
    expect(
      new TextEncoder().encode(serializePublicDiffCachePayload(oversized, threshold)).byteLength,
    ).toBeLessThanOrEqual(threshold);
  });

  test("drops every sample when even the changed files do not fit", () => {
    const oversized = payload("y".repeat(50_000));
    const threshold = JSON.stringify({ ...oversized, fromFiles: [], toFiles: [] }).length + 200;

    const cached = JSON.parse(
      serializePublicDiffCachePayload(oversized, threshold),
    ) as PublicPackageDiff;

    expect(cached.textSamplesOmitted).toBe(true);
    expect(cached.fromFiles[0]).not.toHaveProperty("textSample");
    expect(cached.toFiles[0]).not.toHaveProperty("textSample");
  });

  // Every file navigation re-reads the whole cached payload, so a degraded
  // payload must not grow to fill the cache budget with unchanged bodies.
  test("caps how much of an over-budget payload unchanged samples may claim", () => {
    const unchangedSample = "u".repeat(64 * 1024);
    const files = Array.from({ length: 200 }, (_, index) => ({
      path: `lib/mod-${String(index).padStart(3, "0")}.js`,
      size: unchangedSample.length,
      sha256: `sha-${index}`,
      flags: [],
      textSample: unchangedSample,
    }));
    const oversized: PublicPackageDiff = {
      ...payload(),
      fromFiles: files,
      toFiles: files,
      diff: files.map((file) => ({ path: file.path, status: "unchanged", flags: [] })),
    };
    // 25 MiB of samples against a 20 MiB budget: without the unchanged cap the
    // reduction would happily emit a ~20 MiB payload.
    const cached = JSON.parse(
      serializePublicDiffCachePayload(oversized, 20 * 1024 * 1024),
    ) as PublicPackageDiff;

    const retained = cached.toFiles.filter((file) => file.textSample);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(files.length);
    expect(new TextEncoder().encode(JSON.stringify(cached)).byteLength).toBeLessThan(
      4 * 1024 * 1024,
    );
  });
});

// The reduction sums these over every file in a payload and compares the total
// against a hard cache limit, so a drift from the runtime's own encoding would
// silently overshoot (or needlessly discard) samples.
describe("byte-length counters", () => {
  const encoder = new TextEncoder();
  const cases = [
    "",
    "plain ascii",
    'quote " and backslash \\',
    "tab\tnewline\nreturn\r",
    "  control",
    "café façade",
    "日本語のテキスト",
    "emoji 🚢🔥 pair",
    "😀",
    "lone high \ud800 surrogate",
    "lone low \udc00 surrogate",
    "\ud800𐀀",
  ];

  test("utf8ByteLength matches TextEncoder", () => {
    for (const value of cases) {
      expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
    }
  });

  test("jsonStringByteLength matches JSON.stringify", () => {
    for (const value of cases) {
      expect(jsonStringByteLength(value)).toBe(encoder.encode(JSON.stringify(value)).byteLength);
    }
  });

  test("both counters agree with the runtime across random code units", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const nextCode = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 0x11000;
    };
    for (let iteration = 0; iteration < 2_000; iteration++) {
      let value = "";
      for (let index = 0; index < 24; index++) value += String.fromCharCode(nextCode());
      expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
      expect(jsonStringByteLength(value)).toBe(encoder.encode(JSON.stringify(value)).byteLength);
    }
  });
});
