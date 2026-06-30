import { ANALYTICS_PROXY_PREFIX } from "./analytics-proxy-path";

// PostHog EU region. Ingestion (event capture, flags, decide) and static SDK
// assets (recorder/surveys bundles) are served from different hosts, so the
// proxy fans `${PREFIX}/static/*` out to the assets host and everything else to
// the ingestion host.
const POSTHOG_INGESTION_ORIGIN = "https://eu.i.posthog.com";
const POSTHOG_ASSETS_ORIGIN = "https://eu-assets.i.posthog.com";

// Request headers that would leak the end user's network identity to PostHog.
// We deliberately strip them: Drydock is the only hop PostHog sees, so no
// reviewer IP ever leaves the platform (GeoIP is traded away for privacy).
const CLIENT_IDENTITY_HEADERS = [
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ipcountry",
  "true-client-ip",
];

export function isAnalyticsProxyPath(path: string): boolean {
  return path === ANALYTICS_PROXY_PREFIX || path.startsWith(`${ANALYTICS_PROXY_PREFIX}/`);
}

export async function proxyAnalyticsRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Drop the proxy prefix; the remainder is PostHog's own path verbatim.
  const forwardedPath = url.pathname.slice(ANALYTICS_PROXY_PREFIX.length) || "/";
  const useAssets = forwardedPath === "/static" || forwardedPath.startsWith("/static/");
  const upstream = new URL(useAssets ? POSTHOG_ASSETS_ORIGIN : POSTHOG_INGESTION_ORIGIN);
  upstream.pathname = forwardedPath;
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.set("host", upstream.host);
  for (const name of CLIENT_IDENTITY_HEADERS) headers.delete(name);

  // PostHog ingestion payloads are small JSON bodies; buffering avoids the
  // half-duplex streaming dance and keeps the forwarded request self-contained.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const upstreamResponse = await fetch(upstream.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  // The proxy never sets first-party cookies on PostHog's behalf.
  responseHeaders.delete("set-cookie");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
