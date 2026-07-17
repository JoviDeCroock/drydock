import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import worker from "../../server/index";

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

  test("file endpoint requires a path", async () => {
    const res = await publicDiffFetch(
      "/api/public/v1/package-diff/file?package=left-pad&from=1.0.0&to=1.0.1",
      "10.0.0.5",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path is required" });
  });

  test("delegates a canonical credential-free pair request only when the pilot is enabled", async () => {
    const ctx = createExecutionContext() as ExecutionContext & {
      exports: {
        PublicDiffReads: { fetch: ReturnType<typeof vi.fn> };
      };
    };
    const cachedResponse = Response.json({ source: "workers-cache" }, { status: 200 });
    const fetch = vi.fn(async () => cachedResponse);
    ctx.exports = { PublicDiffReads: { fetch } };
    const pilotEnv = {
      ...env,
      PUBLIC_DIFF_WORKERS_CACHE_PILOT: "1",
    } satisfies Cloudflare.Env;

    const res = await worker.fetch(
      new Request(
        "http://example.com/api/public/v1/package-diff?to=1.0.1&ignored=1&package=left-pad&from=1.0.0",
        {
          headers: {
            authorization: "Bearer secret",
            cookie: "session=secret",
            "cf-connecting-ip": "10.0.0.10",
          },
        },
      ),
      pilotEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: "workers-cache" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const delegated = fetch.mock.calls[0]?.[0] as Request;
    expect(delegated.url).toBe(
      "http://example.com/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=1.0.1",
    );
    expect(delegated.headers.get("authorization")).toBeNull();
    expect(delegated.headers.get("cookie")).toBeNull();
    expect(delegated.headers.get("accept")).toBe("application/json");
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
