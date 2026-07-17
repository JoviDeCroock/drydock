import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  computePublicDiffCacheKey,
  readPublicDiffCache,
  serializePublicDiffCachePayload,
  writePublicDiffCache,
  type PublicPackageDiff,
} from "../../server/lib/public-diff";
import {
  PUBLIC_DIFF_PATH,
  PUBLIC_NPM_REGISTRY,
  PublicDiffReads,
} from "../../server/lib/public-diff-read";
import { DETERMINISTIC_RULES_VERSION } from "../../server/lib/review";

function payload(textSample = "export const value = 1;\n"): PublicPackageDiff {
  return {
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

function buildEntrypoint(entrypointEnv: Cloudflare.Env) {
  const entrypoint = Object.create(PublicDiffReads.prototype) as PublicDiffReads & {
    env: Cloudflare.Env;
    ctx: ExecutionContext;
  };
  entrypoint.env = entrypointEnv;
  entrypoint.ctx = createExecutionContext();
  return entrypoint;
}

describe("public diff cache", () => {
  test("versions computed results by deterministic rules and risk schema", async () => {
    const key = await computePublicDiffCacheKey({
      registryUrl: "https://registry.npmjs.org",
      packageName: "cache-test-package",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });

    expect(key).toContain(`rules=${DETERMINISTIC_RULES_VERSION}`);
    expect(key).toContain("risk=1");
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

  test("serves a cached pair with separate edge and browser policies", async () => {
    const input = {
      registryUrl: PUBLIC_NPM_REGISTRY,
      packageName: "cache-test-package",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    } as const;
    const key = await computePublicDiffCacheKey(input);
    await writePublicDiffCache(env, key, payload());

    const response = await buildEntrypoint(env).fetch(
      new Request(
        `https://drydock.org${PUBLIC_DIFF_PATH}?package=cache-test-package&from=1.0.0&to=1.0.1`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(response.headers.get("cache-tag")).toBe("public-diff:cache-test-package");
    expect(await response.json()).toMatchObject({
      packageName: "cache-test-package",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });
  });

  test("never caches invalid or unsupported entrypoint requests", async () => {
    const entrypoint = buildEntrypoint(env);
    const invalid = await entrypoint.fetch(
      new Request(`https://drydock.org${PUBLIC_DIFF_PATH}?package=!invalid!`),
    );
    const unsupported = await entrypoint.fetch(
      new Request(`https://drydock.org${PUBLIC_DIFF_PATH}`, { method: "POST" }),
    );

    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("private, no-store");
    expect(unsupported.status).toBe(404);
    expect(unsupported.headers.get("cache-control")).toBe("private, no-store");
  });
});
