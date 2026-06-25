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
    expect(await res.text()).toBe("asset:/dashboard/index.html");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  test("serves singular scan deep links from the generated dashboard shell", async () => {
    const res = await fetchWorker("https://drydock.org/dashboard/scan/123?tab=report", assetEnv);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/dashboard/index.html");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  test("keeps server-owned misses as JSON 404s", async () => {
    const res = await fetchWorker("https://drydock.org/webhooks/not-found", assetEnv);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
