import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";

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

describe("public package-diff routes", () => {
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
    const ip = "10.99.0.1";
    // Limit is 10/min; validation failures still consume the budget because the
    // limiter runs first (invalid requests are the cheapest to abuse).
    for (let i = 0; i < 10; i++) {
      const res = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip);
      expect(res.status).toBe(400);
    }
    const limited = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    // A different IP keeps its own budget.
    const other = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", "10.99.0.2");
    expect(other.status).toBe(400);
  });

  test("versions endpoint rate-limits by IP independently of the diff endpoint", async () => {
    const ip = "10.99.1.1";
    for (let i = 0; i < 30; i++) {
      const res = await publicDiffFetch("/api/public/v1/package-diff/versions?package=!x!", ip);
      expect(res.status).toBe(400);
    }
    const limited = await publicDiffFetch("/api/public/v1/package-diff/versions?package=!x!", ip);
    expect(limited.status).toBe(429);

    // The same IP is not blocked on the diff bucket by versions traffic.
    const diff = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip);
    expect(diff.status).toBe(400);
  });

  test("file cache misses share the expensive diff computation budget", async () => {
    const ip = "10.99.2.1";
    for (let i = 0; i < 10; i++) {
      const res = await publicDiffFetch("/api/public/v1/package-diff?package=!x!", ip);
      expect(res.status).toBe(400);
    }

    const limited = await publicDiffFetch(
      "/api/public/v1/package-diff/file?package=left-pad&from=1.0.0&to=1.0.1&path=index.js",
      ip,
    );
    expect(limited.status).toBe(429);
  });
});
