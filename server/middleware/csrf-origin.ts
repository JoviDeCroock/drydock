import type { MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "../types";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Rejects state-changing `/api/*` requests whose Origin (or Referer) is not the
 * configured app origin. Session cookies are `SameSite=Lax`, so this is the
 * second line against cross-site POSTs; it is skipped when no origin is
 * configured (local harnesses).
 */
export const csrfOriginCheck: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) return next();
  const expectedOrigin = originOf(c.env.BETTER_AUTH_URL);
  if (!expectedOrigin) return next();
  const sourceOrigin = c.req.header("origin") || originOf(c.req.header("referer"));
  if (!sourceOrigin || sourceOrigin !== expectedOrigin) {
    return c.json({ error: "request origin not allowed" }, 403);
  }
  return next();
};
