import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { atpmPublicDiff } from "../../server/lib/ecosystems/atpm/public-diff";
import { PUBLIC_NPM_REGISTRY } from "../../server/lib/ecosystems/npm/public-diff";
import {
  computePublicDiffCacheKey,
  PublicDiffError,
  writePublicDiffCache,
  type PublicPackageDiff,
} from "../../server/lib/public-diff";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";

function cachedPayload(packageName: string): PublicPackageDiff {
  const textSample = "export const value = 1;\n";
  return {
    ecosystem: "npm",
    packageName,
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
    risk: { artifactRisk: "low", releaseRisk: "low", contextRisk: "low", aiRisk: "low" },
    cachedAt: "2026-07-15T00:00:00.000Z",
  };
}

// The public package-diff endpoints are deliberately anonymous: they must be
// reachable without a session (mounted before the auth middleware), validate
// their inputs strictly, and rate-limit by IP before doing any work. None of
// these tests reach the registry — rate limiting runs before validation and
// validation failures return before any fetch.

async function publicDiffFetch(path: string, ip?: string): Promise<Response> {
  return publicDiffFetchWithEnv(path, env, ip);
}

async function publicDiffFetchWithEnv(
  path: string,
  requestEnv: Cloudflare.Env,
  ip?: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (ip) headers.set("cf-connecting-ip", ip);
  const res = await worker.fetch(
    new Request(`http://example.com${path}`, { headers }),
    requestEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

// server/lib/platform/rate-limit.ts counts into fixed wall-clock buckets (`Math.floor(now
// / windowMs)`), so a request sequence that straddles a bucket boundary gets a
// fresh budget partway through and the request that should have been rejected is
// allowed instead. 31 requests against a 60s window cross a boundary roughly once
// in a hundred runs — often enough to have turned CI red on an unrelated commit.
const RATE_LIMIT_ATTEMPTS = 5;

// Spends `limit` requests, then fires one the limiter must reject. An attempt
// whose budget reset underneath it is retried on a fresh IP — the retry starts
// just after the boundary that spoiled the last one, so it has a whole window to
// itself. The final attempt is returned whatever happened, so a limiter that
// genuinely stopped rejecting still fails the assertions at the call site rather
// than being retried into a false green.
async function exhaustRateLimit(
  ipPrefix: string,
  limit: number,
  fill: (ip: string) => Promise<Response>,
  probe: (ip: string) => Promise<Response> = fill,
): Promise<{ ip: string; allowed: Response[]; limited: Response }> {
  let last: { ip: string; allowed: Response[]; limited: Response } | undefined;
  for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt += 1) {
    const ip = `${ipPrefix}.${attempt}`;
    const allowed: Response[] = [];
    for (let i = 0; i < limit; i += 1) allowed.push(await fill(ip));
    last = { ip, allowed, limited: await probe(ip) };
    if (last.limited.status === 429) return last;
  }
  return last!;
}

describe("public package-diff routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("is disabled when the deployment uses a custom registry", async () => {
    const customRegistryEnv = {
      ...env,
      NPM_REGISTRY: "https://registry.example.test",
    } satisfies Cloudflare.Env;
    const res = await publicDiffFetchWithEnv(
      "/api/public/v1/package-diff/versions?package=left-pad",
      customRegistryEnv,
      "10.0.0.9",
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "public package diff is disabled for custom registries",
    });

    // A custom registry signals a private deployment, so the PyPI surface is
    // disabled with it — it would otherwise still reach the public internet.
    const pypi = await publicDiffFetchWithEnv(
      "/api/public/v1/package-diff/versions?package=requests&ecosystem=pypi",
      customRegistryEnv,
      "10.0.0.9",
    );
    expect(pypi.status).toBe(404);
  });

  test("rejects an unknown ecosystem", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=1.0.1&ecosystem=rubygems",
      "10.0.0.6",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid ecosystem" });

    const versions = await publicDiffFetch(
      "/api/public/v1/package-diff/versions?package=left-pad&ecosystem=rubygems",
      "10.0.0.6",
    );
    expect(versions.status).toBe(400);
    expect(await versions.json()).toEqual({ error: "invalid ecosystem" });
  });

  test("validates PyPI project names with PyPI rules, not npm rules", async () => {
    const invalid = await publicDiffFetch(
      "/api/public/v1/package-diff?package=-bad-&from=1.0.0&to=1.0.1&ecosystem=pypi",
      "10.0.0.7",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid package name" });

    // Uppercase is invalid for npm but fine for PyPI: the request advances to
    // version validation instead of failing on the name.
    const upper = await publicDiffFetch(
      "/api/public/v1/package-diff?package=UPPER_CASE&to=1.0.1&ecosystem=pypi",
      "10.0.0.7",
    );
    expect(upper.status).toBe(400);
    expect(await upper.json()).toEqual({ error: "invalid from version" });
  });

  test("accepts PEP 440 epoch versions only for PyPI", async () => {
    // Identical from/to proves the epoch version passed the PyPI version regex
    // without the request ever reaching the registry.
    const pypi = await publicDiffFetch(
      `/api/public/v1/package-diff?package=pkg&from=${encodeURIComponent("1!1.0")}&to=${encodeURIComponent("1!1.0")}&ecosystem=pypi`,
      "10.0.0.8",
    );
    expect(pypi.status).toBe(400);
    expect(await pypi.json()).toEqual({ error: "from and to must differ" });

    const npm = await publicDiffFetch(
      `/api/public/v1/package-diff?package=pkg&from=${encodeURIComponent("1!1.0")}&to=1.0.1`,
      "10.0.0.8",
    );
    expect(npm.status).toBe(400);
    expect(await npm.json()).toEqual({ error: "invalid from version" });
  });

  test("responds without a session instead of 401", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff?package=!invalid!&from=1.0.0&to=1.0.1",
      "10.0.0.1",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid package name" });
  });

  test("versions endpoint rejects an invalid package name", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff/versions?package=UPPER_CASE",
      "10.0.0.2",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid package name" });
  });

  test("diff endpoint rejects missing and malformed versions", async () => {
    const missing = await publicDiffFetch(
      "/api/public/v1/package-diff?package=left-pad&to=1.0.1",
      "10.0.0.3",
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid from version" });

    const malformed = await publicDiffFetch(
      `/api/public/v1/package-diff?package=left-pad&from=${encodeURIComponent("1.0.0 OR 1=1")}&to=1.0.1`,
      "10.0.0.3",
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid from version" });
  });

  test("diff endpoint rejects identical versions", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff?package=left-pad&from=1.0.1&to=1.0.1",
      "10.0.0.4",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "from and to must differ" });
  });

  test("diff endpoint accepts a pkg.pr.new preview URL but rejects a package mismatch", async () => {
    // The mismatch check is fetch-free and runs before any cache or registry
    // work, so this exercises the full preview-URL validation path without
    // reaching the network.
    const previewUrl = encodeURIComponent("https://pkg.pr.new/other-pkg@a832a55");
    const res = await publicDiffFetch(
      `/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=${previewUrl}`,
      "10.0.0.6",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "preview URL is for a different package" });
  });

  test("diff endpoint rejects preview URLs on foreign hosts", async () => {
    const foreign = encodeURIComponent("https://pkg.pr.new.evil.example.com/left-pad@a832a55");
    const res = await publicDiffFetch(
      `/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=${foreign}`,
      "10.0.0.7",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid to version" });
  });

  test("diff endpoint rejects identical preview URLs", async () => {
    const previewUrl = encodeURIComponent("https://pkg.pr.new/left-pad@a832a55");
    const res = await publicDiffFetch(
      `/api/public/v1/package-diff?package=left-pad&from=${previewUrl}&to=${previewUrl}`,
      "10.0.0.8",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "from and to must differ" });
  });

  test("file endpoint requires a path", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff/file?package=left-pad&from=1.0.0&to=1.0.1",
      "10.0.0.5",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path is required" });
  });

  test("diff endpoint rate-limits by IP", async () => {
    // Limit is 10/min; validation failures still consume the budget because the
    // limiter runs first (invalid requests are the cheapest to abuse).
    const { allowed, limited } = await exhaustRateLimit("10.99.0", 10, (ip) =>
      publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip),
    );
    expect(allowed.map((res) => res.status)).toEqual(Array(10).fill(400));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    // A different IP keeps its own budget.
    const other = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", "10.99.9.1");
    expect(other.status).toBe(400);
  });

  test("versions endpoint rate-limits by IP independently of the diff endpoint", async () => {
    const { ip, allowed, limited } = await exhaustRateLimit("10.99.1", 30, (address) =>
      publicDiffFetch("/api/public/v1/package-diff/versions?package=!x!", address),
    );
    expect(allowed.map((res) => res.status)).toEqual(Array(30).fill(400));
    expect(limited.status).toBe(429);

    // The same IP is not blocked on the diff bucket by versions traffic.
    const diff = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip);
    expect(diff.status).toBe(400);
  });

  test("file cache misses share the expensive diff computation budget", async () => {
    const { allowed, limited } = await exhaustRateLimit(
      "10.99.2",
      10,
      (ip) => publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip),
      (ip) =>
        publicDiffFetch(
          "/api/public/v1/package-diff/file?package=left-pad&from=1.0.0&to=1.0.1&path=index.js",
          ip,
        ),
    );
    expect(allowed.map((res) => res.status)).toEqual(Array(10).fill(400));
    expect(limited.status).toBe(429);
  });

  test("file cache hits revalidate staged atpm candidates", async () => {
    const packageName = "did:plc:twegdcgytckr5cxm57gyruxa/counter";
    const toVersion = "staged.3lmabcdefghij.bafyreicachedrevision";
    const payload = {
      ...cachedPayload(packageName),
      ecosystem: "atpm",
      toVersion,
      cacheExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    } satisfies PublicPackageDiff;
    const input = {
      ecosystem: "atpm",
      registryUrl: "at://",
      packageName,
      fromVersion: payload.fromVersion,
      toVersion,
    };
    await writePublicDiffCache(env, await computePublicDiffCacheKey(input), payload);

    const validate = vi
      .spyOn(atpmPublicDiff, "validateCachedPair")
      .mockRejectedValue(new PublicDiffError("staged release not found", 404));
    const params = new URLSearchParams({
      ecosystem: "atpm",
      package: packageName,
      from: payload.fromVersion,
      to: toVersion,
      path: "index.js",
    });
    const res = await publicDiffFetch(
      `/api/public/v1/package-diff/file?${params.toString()}`,
      "10.99.2.99",
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "staged release not found" });
    expect(validate).toHaveBeenCalledWith(env, expect.anything(), input);
  });

  test("the anonymous surface reaches D1 on no request path", async () => {
    // Rate limiting used to be an unconditional D1 upsert plus select on every
    // request — ahead of the cache read, so a cache hit still cost two writes to
    // the single D1 writer. The native Rate Limiting binding removed the last
    // reason for these routes to hold a D1 handle at all; a binding that throws
    // on use keeps it that way.
    const forbidden = () => {
      throw new Error("the anonymous package-diff surface must not use D1");
    };
    const noD1Env = {
      ...env,
      DB: {
        prepare: forbidden,
        batch: forbidden,
        exec: forbidden,
        dump: forbidden,
        withSession: forbidden,
      } as unknown as D1Database,
    } satisfies Cloudflare.Env;

    const ip = "10.99.3.1";
    for (const path of [
      "/api/public/v1/package-diff?package=!x!",
      "/api/public/v1/package-diff/versions?package=!x!",
      "/api/public/v1/package-diff/file?package=!x!&from=1.0.0&to=1.0.1&path=index.js",
    ]) {
      const res = await publicDiffFetchWithEnv(path, noD1Env, ip);
      expect(res.status).toBe(400);
    }

    // Blocked requests must not fall back to D1 either.
    const { overrides } = exhaustedRateLimitBindings();
    const limited = await publicDiffFetchWithEnv(
      "/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=1.0.1",
      { ...noD1Env, ...overrides },
      ip,
    );
    expect(limited.status).toBe(429);

    // The paths above all reject early. The one that matters most is the one
    // that succeeds: serve a real cached pair and assert it renders a 200
    // without D1 either.
    const packageName = `no-d1-${crypto.randomUUID()}`;
    const payload = cachedPayload(packageName);
    await writePublicDiffCache(
      env,
      await computePublicDiffCacheKey({
        ecosystem: "npm",
        registryUrl: PUBLIC_NPM_REGISTRY,
        packageName,
        fromVersion: payload.fromVersion,
        toVersion: payload.toVersion,
      }),
      payload,
    );

    const served = await publicDiffFetchWithEnv(
      `/api/public/v1/package-diff?package=${packageName}&from=1.0.0&to=1.0.1`,
      noD1Env,
      "10.99.3.2",
    );
    expect(served.status).toBe(200);
    expect(await served.json()).toMatchObject({ packageName, toVersion: "1.0.1" });

    const servedFile = await publicDiffFetchWithEnv(
      `/api/public/v1/package-diff/file?package=${packageName}&from=1.0.0&to=1.0.1&path=index.js`,
      noD1Env,
      "10.99.3.2",
    );
    expect(servedFile.status).toBe(200);
    expect(await servedFile.json()).toMatchObject({ path: "index.js" });
  });

  test("fails closed when the rate limiter itself is broken", async () => {
    // A limiter that throws must never read as "allowed". The route has no
    // fallback that could quietly serve the request, so the only correct answer
    // is a 5xx.
    const throwing = {
      limit: () => Promise.reject(new Error("rate limiter unavailable")),
    } as unknown as RateLimit;
    const brokenEnv = {
      ...env,
      RATE_LIMIT_10_PER_MINUTE: throwing,
    } satisfies Cloudflare.Env;

    const res = await publicDiffFetchWithEnv(
      "/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=1.0.1",
      brokenEnv,
      "10.99.4.1",
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
