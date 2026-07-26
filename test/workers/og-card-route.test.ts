import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import worker from "../../server/index";
import { resetOgFontCacheForTests } from "../../server/lib/public-diff/card-render";

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
  });

  test("rate limits cold renders per IP", async () => {
    const ip = "10.9.9.9";
    let limited = false;
    for (let i = 0; i < 70; i++) {
      const res = await cardFetch(`/og/diff/tape/5.7.0/6.0.${i}/card.png`, { ip });
      if (res.headers.get("cache-control") === "public, max-age=60") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
