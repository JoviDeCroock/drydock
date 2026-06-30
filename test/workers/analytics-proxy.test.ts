import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, assetEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("analytics proxy route", () => {
  test("proxies /b/* to PostHog without auth and without hitting the asset binding", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : input.toString());
      return new Response("captured", { status: 200 });
    });

    const res = await fetchWorker(
      new Request("https://drydock.org/b/i/v0/e/", { method: "POST", body: "{}" }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("captured");
    expect(seen).toEqual(["https://eu.i.posthog.com/i/v0/e/"]);
  });
});
