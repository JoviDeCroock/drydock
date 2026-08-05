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

// Local-development escape hatch. The production policy actively breaks
// `pnpm run dev`: CSP `script-src 'self'` (no 'unsafe-inline') blocks Vite's
// injected HMR client, and HSTS would pin the http://localhost origin to HTTPS.
//
// This is a string env var so it follows the same provisioning as
// ALLOW_INSECURE_LOCAL_REGISTRY: set it in `.dev.vars` (gitignored) for local
// dev only. It is deliberately absent from wrangler.jsonc and test/config/wrangler.jsonc
// — NEVER add it there. Production fails closed: when the var is unset the full
// header policy applies, so a deployment can't accidentally ship with headers
// stripped.
export function securityHeadersDisabled(
  env: Pick<Cloudflare.Env, "DISABLE_SECURITY_HEADERS">,
): boolean {
  return env.DISABLE_SECURITY_HEADERS === "true";
}

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
export const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// The HTML UI starts from a deny-all fallback, then opens only the same-origin
// fetch surfaces the app actually uses. The Geist webfont is self-hosted
// (Fontsource, bundled into our assets), so style-src and font-src stay 'self'
// with no third-party origins. No 'unsafe-inline' on style-src, and
// style-src-attr 'none' blocks inline style attributes outright; dynamic visuals
// use classes or SVG geometry attributes instead. img-src data: covers inline
// data-URI images. connect-src stays 'self' — the UI only calls the same-origin
// /api surface.
export const DOCUMENT_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'none'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "media-src 'self'",
].join("; ");
