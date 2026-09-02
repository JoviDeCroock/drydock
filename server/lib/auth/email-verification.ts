/**
 * Per-action email-verification guard.
 *
 * Signing in no longer requires a verified address — an account can open the
 * dashboard and review published releases immediately — so verification is
 * enforced where it actually buys something instead: before an action stores a
 * credential, records a verdict, publishes a link, invites someone else, or
 * installs a GitHub App. Each of those either spends trust the address is the
 * only proof of, or lets an unowned address reach someone who is not the
 * account holder.
 *
 * Reading nothing is a pass. The flag is Better Auth's own session field, and
 * the guard is off entirely on deployments that cannot send mail (see
 * `emailVerificationAvailable`), where no account could ever clear it.
 */
import type { Context } from "hono";
import { emailVerificationAvailable } from "./index";
import type { Bindings, Variables } from "../../types";

/** Stable client contract; the dashboard banner keys its prompt off this code. */
export const EMAIL_VERIFICATION_REQUIRED_CODE = "email_verification_required";

export function requireVerifiedEmail(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Response | null {
  if (!emailVerificationAvailable(c.env)) return null;
  if (c.get("authSession").emailVerified !== false) return null;
  return c.json(
    {
      error: "Verify your email address before using this action.",
      code: EMAIL_VERIFICATION_REQUIRED_CODE,
    },
    403,
  );
}
