import type { MiddlewareHandler } from "hono";
import {
  API_CSP,
  createScriptNonce,
  DOCUMENT_CSP,
  documentCspWithScriptNonce,
  SECURITY_HEADERS,
  securityHeadersDisabled,
} from "../lib/platform/security-headers";
import type { Bindings, Variables } from "../types";

// Cloudflare injects its detection script only into HTML pages, so only a page
// needs a nonce.
function documentCsp(headers: Headers): string {
  return /^text\/html\b/i.test(headers.get("Content-Type") ?? "")
    ? documentCspWithScriptNonce(createScriptNonce())
    : DOCUMENT_CSP;
}

/** Applies the response security headers after every handler. */
export const securityHeaders: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status > 599) return;
  // Local-dev escape hatch: the strict CSP breaks Vite's HMR client and HSTS
  // would pin the loopback origin to HTTPS. Gated behind a `.dev.vars`-only flag
  // that is absent from every deployed config, so production fails closed.
  if (securityHeadersDisabled(c.env)) return;

  const headers = new Headers(c.res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // /api and /public carry the locked-down API policy, even for HTML; everything
  // else, including assets fetched through the ASSETS binding, gets the document
  // policy.
  headers.set(
    "Content-Security-Policy",
    c.req.path.startsWith("/api/") || c.req.path.startsWith("/public/")
      ? API_CSP
      : documentCsp(headers),
  );
  const response = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
  // Hono's `c.res` setter copies every header of the previous response onto the
  // new one. An asset arrives carrying public/_headers' un-nonced CSP, which
  // would overwrite the policy set above; clearing first keeps ours.
  c.res = undefined;
  c.res = response;
};
