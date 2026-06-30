import { afterEach, describe, expect, test, vi } from "vitest";
import { isAnalyticsProxyPath, proxyAnalyticsRequest } from "../server/lib/analytics-proxy";
import { ANALYTICS_PROXY_PREFIX } from "../server/lib/analytics-proxy-path";

interface CapturedUpstream {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function stubUpstream(response = new Response("ok", { status: 200 })): {
  captured: CapturedUpstream[];
} {
  const captured: CapturedUpstream[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const body = init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "";
    captured.push({ url, method: init?.method ?? "GET", headers, body });
    return response;
  });
  return { captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAnalyticsProxyPath", () => {
  test("matches the prefix and its descendants only", () => {
    expect(isAnalyticsProxyPath(ANALYTICS_PROXY_PREFIX)).toBe(true);
    expect(isAnalyticsProxyPath(`${ANALYTICS_PROXY_PREFIX}/i/v0/e/`)).toBe(true);
    expect(isAnalyticsProxyPath("/bored")).toBe(false);
    expect(isAnalyticsProxyPath("/api/v1/scans")).toBe(false);
  });
});

describe("proxyAnalyticsRequest", () => {
  test("forwards ingestion traffic to PostHog EU with the prefix stripped", async () => {
    const { captured } = stubUpstream();

    await proxyAnalyticsRequest(
      new Request("https://drydock.org/b/i/v0/e/?ip=1&ver=1", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ event: "$pageview" }),
      }),
    );

    expect(captured).toHaveLength(1);
    const upstream = captured[0]!;
    expect(upstream.url).toBe("https://eu.i.posthog.com/i/v0/e/?ip=1&ver=1");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("host")).toBe("eu.i.posthog.com");
    expect(upstream.body).toContain("$pageview");
  });

  test("routes static asset requests to the PostHog assets host", async () => {
    const { captured } = stubUpstream();

    await proxyAnalyticsRequest(new Request("https://drydock.org/b/static/recorder.js"));

    expect(captured[0]!.url).toBe("https://eu-assets.i.posthog.com/static/recorder.js");
  });

  test("strips client identity headers so no reviewer IP reaches PostHog", async () => {
    const { captured } = stubUpstream();

    await proxyAnalyticsRequest(
      new Request("https://drydock.org/b/i/v0/e/", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.7",
          cookie: "drydock_session=secret",
          "true-client-ip": "203.0.113.7",
        },
        body: "{}",
      }),
    );

    const headers = captured[0]!.headers;
    for (const name of [
      "cf-connecting-ip",
      "x-forwarded-for",
      "x-real-ip",
      "cookie",
      "true-client-ip",
    ]) {
      expect(headers.get(name)).toBeNull();
    }
  });

  test("drops upstream set-cookie from the proxied response", async () => {
    stubUpstream(
      new Response("ok", { status: 200, headers: { "set-cookie": "ph_session=1; Path=/" } }),
    );

    const res = await proxyAnalyticsRequest(new Request("https://drydock.org/b/flags/?v=2"));

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
