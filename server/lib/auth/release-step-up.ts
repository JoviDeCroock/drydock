import type { Context } from "hono";
import { type AppDb } from "../../db/client";
import { organizationRequiresTwoFactorForReleaseDecisions } from "../../db/organizations";
import { RateLimitError, enforceRateLimit } from "../../db/rate-limit";
import { rateLimitResponse } from "../platform/http";
import { userHasTwoFactor, verifyTotpStepUp } from "./index";
import type { Bindings, Variables } from "../../types";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export interface ReleaseStepUpInput {
  totpCode: string;
  /** Rate-limit bucket; distinct per route so one surface cannot exhaust another. */
  rateLimitKey: string;
}

/**
 * Two-factor step-up for a decision that can release or block a real
 * deployment.
 *
 * Returns a `Response` to send when the caller must be stopped (enrollment
 * required, code missing, code invalid, too many attempts), or `null` when the
 * decision may proceed.
 *
 * The policy, in one place because two routes now need it — the workflow-gate
 * decision and a decision on a pushed release set that a gate will later
 * collect:
 *
 *  - An organization can require 2FA for every release decision. Then an
 *    unenrolled member is blocked outright and must enroll first.
 *  - A member who has enrolled always proves a *fresh* factor, policy or not.
 *    An existing session is not enough: approving is irreversible, because the
 *    publish happens immediately over Trusted Publishing/OIDC.
 *  - With the policy off and no enrollment, the decision proceeds as before.
 *
 * Call this only after the decision is known to be actionable, so nobody is
 * prompted for a code on a request that would fail anyway.
 */
export async function requireReleaseDecisionStepUp(
  c: AppContext,
  db: AppDb,
  userId: string,
  organizationId: string,
  input: ReleaseStepUpInput,
): Promise<Response | null> {
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );
  const userEnrolled = await userHasTwoFactor(db, userId);

  if (orgRequiresTwoFactor && !userEnrolled) {
    return c.json(
      {
        error:
          "your organization requires two-factor authentication to decide releases — enable it in Settings, then try again",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  if (!orgRequiresTwoFactor && !userEnrolled) return null;

  try {
    await enforceRateLimit(db, {
      key: input.rateLimitKey,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "too many two-factor attempts", err);
    }
    throw err;
  }

  if (!input.totpCode) {
    return c.json({ error: "two-factor verification required", code: "two_factor_required" }, 401);
  }
  if (!(await verifyTotpStepUp(c.get("auth"), c.req.raw, input.totpCode))) {
    return c.json({ error: "invalid two-factor code", code: "two_factor_invalid" }, 401);
  }
  return null;
}
