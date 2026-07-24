import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server/index";

const assetEnv = {
  ...env,
  ASSETS: {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      return new Response(`asset:${url.pathname}${url.search}`);
    },
  },
} satisfies Cloudflare.Env;

const diffShellHtml = `<!doctype html>
<html><head>
<title>Diff any npm package | Drydock</title>
<meta name="description" content="landing description">
<meta property="og:title" content="landing title">
<meta property="og:description" content="landing description">
<meta property="og:url" content="https://drydock.org/diff">
<meta name="twitter:title" content="landing title">
<meta name="twitter:description" content="landing description">
<link rel="canonical" href="https://drydock.org/diff">
</head><body><div id="app">diff shell</div></body></html>`;

const diffAssetRequests: string[] = [];
const diffAssetEnv = {
  ...env,
  ASSETS: {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      diffAssetRequests.push(`${url.pathname}${url.search}`);
      return new Response(diffShellHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
} satisfies Cloudflare.Env;

async function fetchWorker(url: string, requestEnv: Cloudflare.Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url), requestEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("canonical domain routing", () => {
  test("redirects legacy host requests to drydock.org", async () => {
    const res = await fetchWorker("https://drydock.resynapse.dev/dashboard/scans/123?tab=report");

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://drydock.org/dashboard/scans/123?tab=report");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
  });

  test("serves generated app assets through the Worker-first fallback", async () => {
    const res = await fetchWorker("https://drydock.org/dashboard/settings?tab=general", assetEnv);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/dashboard/settings?tab=general");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  test("serves dashboard deep links from the generated dashboard shell", async () => {
    const res = await fetchWorker("https://drydock.org/dashboard/scans/123?tab=report", assetEnv);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/dashboard/");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  test("serves package-specific metadata with the generated diff shell", async () => {
    diffAssetRequests.length = 0;
    const res = await fetchWorker(
      "https://drydock.org/diff/@preact/signals/1.0.0/2.0.0?utm_source=share",
      diffAssetEnv,
    );
    const html = await res.text();

    expect(diffAssetRequests).toEqual(["/diff/"]);
    expect(html).toContain("<title>@preact/signals 1.0.0 → 2.0.0 | Drydock package diff</title>");
    expect(html).toContain('content="https://drydock.org/diff/@preact/signals/1.0.0/2.0.0"');
    expect(html).toContain('href="https://drydock.org/diff/@preact/signals/1.0.0/2.0.0"');
    expect(html).toContain("File-by-file diff of @preact/signals between 1.0.0 and 2.0.0");
  });

  test("serves the diff shell for the package-only /diff/<name> form", async () => {
    // Added-dependency "view diff" links open /diff/<name> in a new tab; a hard
    // navigation must get the diff shell, not the homepage prerender.
    diffAssetRequests.length = 0;
    const res = await fetchWorker("https://drydock.org/diff/peace-banner", diffAssetEnv);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(diffAssetRequests).toEqual(["/diff/"]);
    expect(html).toContain('<div id="app">diff shell</div>');
  });

  test("serves the diff shell for a scoped package-only /diff/@scope/name form", async () => {
    diffAssetRequests.length = 0;
    const res = await fetchWorker("https://drydock.org/diff/@preact/signals", diffAssetEnv);

    expect(res.status).toBe(200);
    expect(diffAssetRequests).toEqual(["/diff/"]);
  });

  test("keeps server-owned misses as JSON 404s", async () => {
    const res = await fetchWorker("https://drydock.org/webhooks/not-found", assetEnv);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
