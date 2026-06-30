// First-party path prefix under which the browser talks to PostHog. Requests
// to `${ANALYTICS_PROXY_PREFIX}/*` are reverse-proxied by the Worker to PostHog
// EU (see analytics-proxy.ts), so the analytics traffic stays same-origin: it
// survives content blockers and never needs a third-party entry in the CSP.
//
// The short, opaque prefix is shared by the Worker proxy and the browser SDK
// (src/lib/analytics.ts) and is also pre-declared as a route in wrangler.jsonc
// for the legacy zone. Keep all three in sync.
export const ANALYTICS_PROXY_PREFIX = "/b";
