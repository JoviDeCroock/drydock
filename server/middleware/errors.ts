import type { ErrorHandler } from "hono";
import { ForbiddenError, UnauthorizedError } from "../lib/platform/errors";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings, Variables } from "../types";

// A share link's capability *is* its token, so the raw path must never reach a
// log line. Cloudflare's own invocation logs still capture the full URL — that
// is inherent to capability URLs and is why revocation is immediate — but
// nothing Drydock writes should widen that exposure.
// Both spellings carry the token: /public/reports/:token is the API read, and
// /reports/:token is the browser-facing page that wraps it. Redacting only the
// former leaves the document request — the one a human actually pastes around,
// and the one whose asset fallback can throw — logging the capability in full.
// Better Auth's password-reset callback, /api/auth/reset-password/:token, puts
// a token that mints a password in the path. Drydock mails a fragment link
// instead, but the route still answers whoever builds the URL by hand.
// Email-verification and the reset page carry theirs outside the path (query
// string, fragment), which `c.req.path` never includes.
export function redactCapabilityPath(path: string): string {
  return path
    .replace(/^(\/public)?\/reports\/[^/]+/, "$1/reports/:token")
    .replace(/^\/api\/auth\/reset-password\/[^/]+/, "/api/auth/reset-password/:token");
}

/**
 * The app's `onError`. Route tests mount routers behind the same handler so a
 * helper that throws `ForbiddenError` produces the 403 the production app does.
 */
export const handleAppError: ErrorHandler<{ Bindings: Bindings; Variables: Variables }> = (
  err,
  c,
) => {
  // A session that resolved from the cookie cache can outlive its user by up to
  // the cache lifetime. Helpers that discover the missing principal raise this
  // instead of threading a nullable identity through every return type.
  if (err instanceof UnauthorizedError) return c.json({ error: "unauthorized" }, 401);
  // Raised by requireOrganizationRole once the caller's membership is known.
  if (err instanceof ForbiddenError) {
    return c.json({ error: "forbidden", ...(err.code ? { code: err.code } : {}) }, 403);
  }
  emitOperationalEvent("error", "request.unhandled_error", {
    method: c.req.method,
    path: redactCapabilityPath(c.req.path),
    error: describeOperationalError(err),
  });
  return c.json({ error: "internal error" }, 500);
};
