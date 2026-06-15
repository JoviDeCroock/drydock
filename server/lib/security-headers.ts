// Single source of truth for Drydock's security response headers.
//
// These headers reach the browser by two independent delivery paths that must
// carry the same policy:
//   1. Worker responses — paths listed under `run_worker_first` in
//      wrangler.jsonc (/api, /api/*, /webhooks/*) flow through the Worker, where
//      applySecurityHeaders() in server/index.ts stamps these on every response.
//   2. Static assets — the SPA HTML document, JS, CSS and everything else are
//      served by Cloudflare's edge BEFORE the Worker runs, so they never hit
//      path (1). Those responses get their headers from the static
//      `public/_headers` file instead.
// Because `_headers` is plain text consumed at build time it cannot import this
// module, so the values are duplicated there by hand. The drift guard in
// test/security-headers.test.ts fails if the two ever diverge — update both.

// Non-CSP headers; identical for every response regardless of content type.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // Pin clients to HTTPS for a year so a stripped/downgraded request can't reach
  // the origin in cleartext. Drydock is only ever served over TLS at the edge,
  // and browsers ignore this header on plaintext responses, so it's safe to emit
  // unconditionally. includeSubDomains + preload satisfy the HSTS preload-list
  // requirements that surface scanners (Aikido) check for.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// API/webhook responses are JSON and never load any subresource, so the policy
// denies everything. frame-ancestors/base-uri are still pinned in case a
// response is ever rendered directly in a browser tab.
export const API_CSP = ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"].join(
  "; ",
);

const POSTHOG_EU_HOST = "https://eu.i.posthog.com";

// The HTML UI loads same-origin scripts/styles/images plus the Geist webfont
// from Google Fonts: the stylesheet from fonts.googleapis.com (style-src) pulls
// font files from fonts.gstatic.com (font-src). 'unsafe-inline' on style-src
// covers Tailwind's injected styles and the prerendered critical CSS; img-src
// data: covers inline data-URI images. connect-src allows same-origin /api calls
// and the EU PostHog ingestion host for product analytics.
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self' ${POSTHOG_EU_HOST}`,
].join("; ");
