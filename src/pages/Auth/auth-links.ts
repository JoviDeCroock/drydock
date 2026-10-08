import { normalizeAuthReturnTo } from "../../lib/auth-return";

type AuthPagePath = "/login" | "/register" | "/forgot-password";

// Any fixed origin works: the sanitizer only compares the parsed origin with
// it, and a root-relative value always resolves onto it. A fixed one keeps the
// prerendered href identical to the hydrated one.
const SANITIZE_ORIGIN = "https://drydock.invalid";

/**
 * Link to another auth page that carries the post-auth destination along, so
 * moving between sign in, sign up, and password reset never drops where the
 * visitor was headed. The default destination stays implicit (bare path).
 */
export function authPageHref(path: AuthPagePath, returnTo: unknown): string {
  const target = normalizeAuthReturnTo(returnTo, SANITIZE_ORIGIN);
  return target === "/dashboard" ? path : `${path}?returnTo=${encodeURIComponent(target)}`;
}
