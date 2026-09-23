import type { MiddlewareHandler } from "hono";
import {
  API_CSP,
  DOCUMENT_CSP,
  SECURITY_HEADERS,
  securityHeadersDisabled,
} from "../lib/platform/security-headers";
import type { Bindings, Variables } from "../types";

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
  // Worker-owned routes carry the locked-down API policy; static asset responses
  // fetched through the ASSETS binding keep the document policy.
  headers.set(
    "Content-Security-Policy",
    c.req.path.startsWith("/api/") || c.req.path.startsWith("/public/") ? API_CSP : DOCUMENT_CSP,
  );
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};
