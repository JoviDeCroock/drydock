import type { Context, MiddlewareHandler } from "hono";
import { isPackageDiffDetailPath, rewritePackageDiffMetadata } from "../lib/public-diff/page";
import type { Bindings, Variables } from "../types";
import { DISCOVERY_GUIDE_PATHS, INCIDENT_CASE_PATHS } from "../../src/lib/public-content-routes";

type AppEnv = { Bindings: Bindings; Variables: Variables };

const CANONICAL_HOSTNAME = "drydock.org";
const LEGACY_HOSTNAME = "drydock.resynapse.dev";
const WWW_HOSTNAME = "www.drydock.org";
const CANONICAL_STATIC_PATHS = new Set<string>([
  "/diff",
  "/docs",
  "/privacy",
  ...DISCOVERY_GUIDE_PATHS,
  ...INCIDENT_CASE_PATHS,
]);
// Stated once more in test/e2e/worker-routes.mjs for the local harness;
// test/dev-server-route-parity.test.mjs keeps the two lists equal.
const SERVER_OWNED_PATH_PREFIXES = ["/api", "/webhooks", "/og", "/public"];
const DASHBOARD_STATIC_ASSET_PATHS = new Set([
  "/dashboard",
  "/dashboard/",
  "/dashboard/account",
  "/dashboard/account/",
  "/dashboard/invite",
  "/dashboard/invite/",
  "/dashboard/settings",
  "/dashboard/settings/",
  "/dashboard/settings/github-app/callback",
  "/dashboard/settings/github-app/callback/",
]);

function canonicalRequestRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  let redirect = false;

  if (url.hostname === LEGACY_HOSTNAME || url.hostname === WWW_HOSTNAME) {
    url.hostname = CANONICAL_HOSTNAME;
    redirect = true;
  }
  if (url.pathname.endsWith("/") && CANONICAL_STATIC_PATHS.has(url.pathname.slice(0, -1))) {
    url.pathname = url.pathname.slice(0, -1);
    redirect = true;
  }

  if (!redirect) return null;
  return Response.redirect(url.toString(), 308);
}

/** 308s legacy/www hosts and trailing-slash forms of prerendered pages. */
export const canonicalHostRedirect: MiddlewareHandler<AppEnv> = async (c, next) =>
  canonicalRequestRedirect(c.req.raw) ?? next();

function isServerOwnedPath(path: string): boolean {
  return SERVER_OWNED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function assetFallbackRequest(request: Request): Request {
  const url = new URL(request.url);
  // The static asset binding stores prerendered routes as /route/index.html and
  // redirects a bare /route request to /route/. Fetch that generated document
  // internally so the public URL can stay on the self-canonical, no-slash form.
  if (CANONICAL_STATIC_PATHS.has(url.pathname)) {
    url.pathname = `${url.pathname}/`;
    return new Request(url, request);
  }
  if (isPackageDiffDetailPath(url.pathname)) {
    url.pathname = "/diff/";
    url.search = "";
    return new Request(url, request);
  }
  if (url.pathname.startsWith("/reports/")) {
    url.pathname = "/reports/";
    url.search = "";
    return new Request(url, request);
  }
  if (
    (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) &&
    !DASHBOARD_STATIC_ASSET_PATHS.has(url.pathname)
  ) {
    url.pathname = "/dashboard/";
    url.search = "";
    return new Request(url, request);
  }
  return request;
}

/**
 * The `notFound` handler: Worker-owned prefixes answer a JSON 404, everything
 * else is served from the static asset binding (SPA shells for client routes).
 */
export async function staticAssetFallback(c: Context<AppEnv>): Promise<Response> {
  if (!isServerOwnedPath(c.req.path) && c.env.ASSETS) {
    const response = await c.env.ASSETS.fetch(assetFallbackRequest(c.req.raw));
    return rewritePackageDiffMetadata(response, c.req.path, c.env);
  }
  return c.json({ error: "not found" }, 404);
}
