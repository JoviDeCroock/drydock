import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";

const STATE_CHANGING_ORIGIN = "http://example.com";

interface RouteCase {
  method: string;
  path: string;
  body?: unknown;
}

const protectedRoutes: RouteCase[] = [
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/v1/organizations" },
  { method: "POST", path: "/api/v1/organizations", body: { name: "acme" } },
  { method: "GET", path: "/api/v1/npm-connection" },
  {
    method: "POST",
    path: "/api/v1/npm-connection",
    body: { token: "npm_test_token", label: "test" },
  },
  { method: "DELETE", path: "/api/v1/npm-connection" },
  { method: "POST", path: "/api/v1/npm-connection/validate", body: {} },
  { method: "GET", path: "/api/v1/scans" },
  { method: "GET", path: "/api/v1/scans/overview" },
  { method: "POST", path: "/api/v1/scans", body: { stageId: "stage-auth-route-000001" } },
  { method: "GET", path: "/api/v1/scans/scan_auth_route" },
  { method: "DELETE", path: "/api/v1/scans/scan_auth_route" },
  { method: "GET", path: "/api/v1/scans/scan_auth_route/versions" },
  { method: "GET", path: "/api/v1/scans/scan_auth_route/compare?version=1.0.0" },
  {
    method: "POST",
    path: "/api/v1/scans/scan_auth_route/decision",
    body: { decision: "no_publish" },
  },
  { method: "POST", path: "/api/v1/staged-publishes/scan", body: {} },
];

describe("non-auth API routes", () => {
  test.each(protectedRoutes)("$method $path rejects anonymous requests", async (route) => {
    const ctx = createExecutionContext();
    const headers = new Headers();
    const init: RequestInit = { method: route.method, headers };
    if (route.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(route.body);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(route.method)) {
      headers.set("origin", STATE_CHANGING_ORIGIN);
    }

    const res = await worker.fetch(new Request(`http://example.com${route.path}`, init), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
