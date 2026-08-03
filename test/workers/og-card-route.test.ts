import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import worker from "../../server/index";
import { resetOgFontCacheForTests } from "../../server/lib/public-diff/card-render";
import type { PublicPackageDiff } from "../../server/lib/public-diff";
import {
  exhaustedRateLimitBindings,
  rateLimitBindingOverrides,
  rateLimiterDouble,
} from "./rate-limit-doubles";

// The share-card route is anonymous like the diff API it decorates: crawlers
// unfurl it without a session. These tests cover the trust-boundary behavior —
// input validation, the private-deployment killswitch, and the guarantee that a
// card request never triggers a cold diff computation. Rasterization itself is
// covered in test/og-render.test.ts, which can read the real font files.

const FONT_BYTES = new Uint8Array(4096).fill(1);

// A stub ASSETS binding: the workers pool has no static assets, so the real
// font fetch would 404 and every render would fall back.
function envWithAssets(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    ...env,
    ...overrides,
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.startsWith("/fonts/")) {
          return new Response(FONT_BYTES, { headers: { "content-type": "font/ttf" } });
        }
        if (url.pathname === "/og-image.png") {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            headers: { "content-type": "image/png" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as Fetcher,
  } satisfies Cloudflare.Env;
}

async function cardFetch(
  path: string,
  options: { requestEnv?: Cloudflare.Env; ip?: string } = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers();
  headers.set("cf-connecting-ip", options.ip ?? "10.9.0.1");
  const res = await worker.fetch(
    new Request(`http://example.com${path}`, { headers }),
    options.requestEnv ?? envWithAssets(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("package-diff share card route", () => {
  // Loaded fonts are memoized per isolate, and the pool reuses isolates across
  // tests; without this the font-failure case would render from a cache warmed
  // by an earlier test.
  beforeEach(() => resetOgFontCacheForTests());

  test("rejects a request with no package or versions", async () => {
    expect((await cardFetch("/og/diff/card.png")).status).toBe(400);
    expect((await cardFetch("/og/diff/tape/card.png")).status).toBe(400);
  });

  test("rejects invalid package names and versions", async () => {
    for (const path of [
      "/og/diff/..%2F..%2Fetc%2Fpasswd/1.0.0/1.0.1/card.png",
      "/og/diff/tape/not%20a%20version/1.0.1/card.png",
      "/og/diff/tape/1.0.0/%00/card.png",
      "/og/diff/tape/1.0.0/1.0.0/card.png",
      "/og/diff/tape/1.0.0/1.0.1/1.0.2/card.png",
    ]) {
      const res = await cardFetch(path);
      expect(res.status, path).toBe(400);
    }
  });

  test("renders a scoped package name that spans two path segments", async () => {
    const res = await cardFetch("/og/diff/@preact/signals/1.0.0/2.0.0/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBe("public-diff:@preact/signals");
  });

  test("is disabled when the deployment uses a custom registry", async () => {
    // Same killswitch as the diff API: a private install must not render cards
    // for public packages it has no business reaching out for.
    const res = await cardFetch("/og/diff/tape/5.7.0/5.7.1/card.png", {
      requestEnv: envWithAssets({ NPM_REGISTRY: "https://registry.example.test" }),
    });
    expect(res.status).toBe(404);
  });

  test("serves a PNG for a valid version pair without computing the diff", async () => {
    // Nothing warmed the public-diff cache, so a card that returned stats here
    // would mean an anonymous request had triggered a tarball download.
    const res = await cardFetch("/og/diff/tape/5.7.0/5.7.1/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Names a rasterizer failure directly instead of surfacing it as a
    // confusing mismatch on the header below.
    expect(res.headers.get("x-og-card-fallback")).toBeNull();
    expect(res.headers.get("x-og-card-stats")).toBe("unavailable");
    expect(res.headers.get("cache-tag")).toBe("public-diff:tape");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  test("tags PyPI cards with the prefixed purge tag", async () => {
    const res = await cardFetch("/og/diff/pypi/Requests/2.31.0/2.32.0/card.png");
    expect(res.status).toBe(200);
    // PEP 503 normalization must reach the tag, or a purge would miss the card.
    expect(res.headers.get("cache-tag")).toBe("public-diff:pypi:requests");
  });

  test("does not cache a mutable atpm card beyond the pair lifetime", async () => {
    const res = await cardFetch(
      "/og/diff/atpm/did:plc:twegdcgytckr5cxm57gyruxa/counter/0.0.14-ttl/0.0.15-ttl/card.png",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
  });

  test("uses only a warmed atpm pair's remaining lifetime", async () => {
    const cacheExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const cached = {
      ecosystem: "atpm",
      packageName: "did:plc:twegdcgytckr5cxm57gyruxa/counter",
      fromVersion: "0.0.12-remaining",
      toVersion: "0.0.13-remaining",
      fromPackageJson: null,
      toPackageJson: null,
      fromFiles: [],
      toFiles: [],
      diff: [],
      packageJsonDiff: {},
      findings: [],
      risk: {
        artifactRisk: "low",
        releaseRisk: "low",
        contextRisk: "low",
        releaseFindingCount: 0,
        contextFindingCount: 0,
        unknownFindingCount: 0,
        priorApprovedContextFindingCount: 0,
      },
      cachedAt: new Date().toISOString(),
      cacheExpiresAt,
    } satisfies PublicPackageDiff;
    const requestEnv = envWithAssets({
      COMPARE_CACHE: {
        get: async () => cached,
        put: async () => undefined,
      } as unknown as KVNamespace,
    });

    const res = await cardFetch(
      "/og/diff/atpm/did:plc:twegdcgytckr5cxm57gyruxa/counter/0.0.12-remaining/0.0.13-remaining/card.png",
      { requestEnv },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-og-card-stats")).toBe("cached");
    const match = res.headers
      .get("cache-control")
      ?.match(/^public, max-age=(\d+), s-maxage=(\d+)$/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
    expect(Number(match?.[1])).toBeLessThanOrEqual(120);
    expect(match?.[2]).toBe(match?.[1]);
  });

  test("falls back to the static card when the fonts cannot be loaded", async () => {
    const brokenAssets = {
      ...env,
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/og-image.png") {
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              headers: { "content-type": "image/png" },
            });
          }
          return new Response("gone", { status: 500 });
        },
      } as unknown as Fetcher,
    } satisfies Cloudflare.Env;

    const res = await cardFetch("/og/diff/tape/5.7.0/5.7.2/card.png", {
      requestEnv: brokenAssets,
      ip: "10.9.0.2",
    });
    // A broken card must still unfurl as *something*; a failed image makes the
    // shared link look broken in the timeline.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-og-card-fallback")).toBe("render-failed");
  });

  test("rate limits cold renders per IP", async () => {
    const ip = "10.9.9.9";
    const { overrides, limiter } = exhaustedRateLimitBindings();

    const res = await cardFetch("/og/diff/tape/5.7.0/5.8.0/card.png", {
      ip,
      requestEnv: envWithAssets(overrides),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-og-card-fallback")).toBe("rate-limited");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(limiter.keys).toEqual([`og-card:${ip}`]);
  });

  test("does not charge the limit for a card that is already cached", async () => {
    // Crawlers refetch the same card across platforms; cache hits must not
    // consume the IP's native rate-limit budget.
    const ip = "10.9.9.8";
    const path = "/og/diff/tape/5.7.0/5.9.0/card.png";
    const limiter = rateLimiterDouble(true);
    const requestEnv = envWithAssets(rateLimitBindingOverrides(limiter));
    const first = await cardFetch(path, { ip, requestEnv });
    expect(first.headers.get("x-og-card-fallback")).toBeNull();
    expect(limiter.keys).toEqual([`og-card:${ip}`]);

    const second = await cardFetch(path, { ip, requestEnv });
    expect(second.status).toBe(200);
    expect(limiter.keys).toEqual([`og-card:${ip}`]);
  });
});
