/**
 * The publish / no-publish verdict on a scanned release.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  EMAIL_VERIFICATION_REQUIRED_CODE,
  requireVerifiedEmail,
} from "../../lib/auth/email-verification";
import { emailVerificationAvailable, matchUserTotpStep, userHasTwoFactor } from "../../lib/auth";
import { API_KEY_TOTP_FAILURE_LIMIT, type ApiKeyPrincipal } from "../../lib/auth/api-keys";
import {
  acceptApiKeyTotpStep,
  deleteOrganizationApiKey,
  recordApiKeyTotpFailure,
} from "../../db/api-keys";
import { recordScanEvent } from "../../db/events";
import { guardRateLimit } from "../../lib/rate-limit";
import {
  API_KEY_DECIDABLE_SCAN_SOURCES,
  SCAN_DECISIONS,
  type ScanDecision,
  getScan,
  getScanStatus,
  recordScanDecision,
} from "../../db/scans";
import { user } from "../../db/schema";
import type { AppDb } from "../../db/client";
import { requestActorUserId, requireActiveOrganization } from "../../lib/auth/active-organization";
import { scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin, readJsonObject } from "../../lib/platform/http";
import { optionalWorkerExecutionContext } from "../../lib/platform/execution-context";
import { postReleaseLink } from "../../db/publication-alerts";
import { getPublicationMonitor } from "../../lib/ecosystems";
import {
  badgeLookupKey,
  purgePublicFeedCache,
  scanDistTag,
  scanEcosystem,
} from "../../lib/public-feed";
import type { Bindings, Variables } from "../../types";

export const scanDecisionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

export const DECISION_REASON_MAX = 500;
const DECISION_SET = new Set<ScanDecision>(SCAN_DECISIONS);

type DecisionContext = import("hono").Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * The session check reads Better Auth's session flag; a `decide_staged` API key
 * has no session, so the same rule is applied to the key's creator, the member
 * the decision is attributed to.
 */
async function requireVerifiedDecider(c: DecisionContext, db: AppDb): Promise<Response | null> {
  const apiKey = c.get("apiKey");
  if (!apiKey) return requireVerifiedEmail(c);
  if (!emailVerificationAvailable(c.env)) return null;
  const [creator] = await db
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, apiKey.userId))
    .limit(1);
  if (creator?.emailVerified) return null;
  return c.json(
    {
      error: "The API key's creator must verify their email address before it records decisions.",
      code: EMAIL_VERIFICATION_REQUIRED_CODE,
    },
    403,
  );
}

const KEY_DECIDABLE_SOURCES = new Set<string>(API_KEY_DECIDABLE_SCAN_SOURCES);

/**
 * A session records a staged decision without a step-up, but a key is a bearer
 * secret that can sit in a shell environment where a later `npm install`'s
 * lifecycle script can read it. With an npm token beside it, a worm could
 * record "publish" on its own stage and become the approved baseline. So every
 * key decision needs a TOTP code from the key's creator, checked as the gate
 * decision's step-up is; a creator who has turned two-factor off can no longer
 * decide with any key. A code is accepted once, and a key that sends
 * `API_KEY_TOTP_FAILURE_LIMIT` wrong codes in a row is revoked, so a stolen key
 * cannot guess for its whole life. The code is read from the body only; it is
 * never logged or stored.
 */
async function requireKeyCreatorStepUp(
  c: DecisionContext,
  db: AppDb,
  organizationId: string,
  apiKey: ApiKeyPrincipal,
  totpCode: unknown,
): Promise<Response | null> {
  if (!(await userHasTwoFactor(db, apiKey.userId))) {
    return c.json(
      {
        error:
          "Recording a decision with an API key needs two-factor authentication on the account that created the key, and it is turned off.",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  const limited = await guardRateLimit(
    c,
    { key: `api-key-decision-2fa:${apiKey.userId}`, limit: 10, windowMs: 15 * 60 * 1000 },
    "too many two-factor attempts",
  );
  if (limited) return limited;
  const code = typeof totpCode === "string" ? totpCode.trim() : "";
  if (!code) {
    return c.json(
      {
        error: "Recording a decision with an API key needs a code from your authenticator app.",
        code: "two_factor_required",
      },
      401,
    );
  }
  const step = await matchUserTotpStep(c.get("auth"), db, apiKey.userId, code);
  if (step === "unavailable") {
    return c.json(
      {
        error:
          "Drydock cannot check authenticator codes for the account that created this key right now (two-factor is locked after failed sign-in codes, or not confirmed); try again later",
        code: "two_factor_unavailable",
      },
      401,
    );
  }
  if (step === "mismatch") {
    const failures = await recordApiKeyTotpFailure(db, apiKey.id);
    if (failures !== null && failures >= API_KEY_TOTP_FAILURE_LIMIT) {
      const removed = await deleteOrganizationApiKey(db, organizationId, apiKey.id);
      // Concurrent wrong codes can all reach the limit; only the request that
      // deleted the key records it.
      if (removed) {
        await recordScanEvent(db, {
          organizationId,
          actorUserId: apiKey.userId,
          type: "organization.api_key_revoked_wrong_codes",
          metadata: { name: removed.name, prefix: removed.prefix, failedCodes: failures },
        });
      }
      return c.json(
        {
          error: `${API_KEY_TOTP_FAILURE_LIMIT} wrong authenticator codes in a row, so Drydock revoked this API key. Create a new one in Organization settings.`,
          code: "api_key_revoked",
        },
        401,
      );
    }
    return c.json(
      {
        error: `invalid two-factor code; after ${API_KEY_TOTP_FAILURE_LIMIT} wrong codes in a row the key is revoked`,
        code: "two_factor_invalid",
      },
      401,
    );
  }
  if (!(await acceptApiKeyTotpStep(db, apiKey.id, apiKey.userId, step))) {
    return c.json(
      {
        error: "that code was already used; wait for the next one",
        code: "two_factor_invalid",
      },
      401,
    );
  }
  return null;
}

scanDecisionRoutes.post("/:id/decision", async (c) => {
  const unverified = await requireVerifiedDecider(c, c.var.db);
  if (unverified) return unverified;
  const body = await readJsonObject<{
    decision: string;
    reason: string;
    totpCode: unknown;
  }>(c);
  if (!DECISION_SET.has(body.decision as ScanDecision)) {
    return c.json({ error: "decision must be 'publish' or 'no_publish'" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (reason && reason.length > DECISION_REASON_MAX) {
    return c.json({ error: `reason must be <= ${DECISION_REASON_MAX} characters` }, 400);
  }

  const db = c.var.db;
  const apiKey = c.get("apiKey");
  const organizationId = await requireActiveOrganization(c, db);

  if (apiKey) {
    // A clear refusal for a key on a gate package or a published-release
    // review. `recordScanDecision` re-checks the same thing in its update, so
    // this is the message, not the guarantee.
    const existing = await getScanStatus(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (!KEY_DECIDABLE_SOURCES.has(existing.source) || existing.gateId) {
      return c.json(
        {
          error:
            "API keys record decisions on staged npm publishes only; decide workflow gates and published-release reviews in Drydock",
          code: "api_key_staged_decisions_only",
        },
        403,
      );
    }
    const refused = await requireKeyCreatorStepUp(c, db, organizationId, apiKey, body.totpCode);
    if (refused) return refused;
  }

  const updated = await recordScanDecision(
    db,
    {
      scanId: c.req.param("id"),
      organizationId,
      actorUserId: requestActorUserId(c),
      decision: body.decision as ScanDecision,
      reason,
      apiKey: apiKey ? { name: apiKey.name, prefix: apiKey.prefix } : null,
    },
    scanArtifactReadBucket(c.env),
    c.env,
  );

  if (!updated) {
    // Existence check only — skip the R2 artifact load; the detail is discarded.
    const existing = await getScan(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.scan.registryStatusSupersededAt) {
      return c.json(
        { error: "decision cannot be changed after this staged release was superseded" },
        409,
      );
    }
    return c.json({ error: "decision can only be set on completed scans" }, 409);
  }

  // A decision changes what the cached badge and feed entry assert
  // ("reviewed · risk" → "approved"/"blocked"), and a publish → no_publish
  // flip must not leave a brightgreen "approved" badge sitting in this colo
  // for the full TTL. It moves a default-on badge too, which needs no listing
  // at all. Same canonical-origin purge as (un)listing.
  if (updated.scan.badgePublic || updated.scan.publicFeedListedAt) {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      badgeLookupKey(updated.scan),
      // The scan's own release line: purging the default entry for an `rc`
      // review would leave the stale rc badge cached and drop an unrelated one.
      scanDistTag(updated.scan.summaryJson),
    );
  }

  // A published-pair review started from a publication alert resolves that
  // alert. Whether the decision may also speak on the public badge is decided
  // there; either way the badge may have changed, so purge every line the
  // package's badge answers on.
  if (updated.scan.source === "published") {
    const ecosystem = scanEcosystem(updated.scan.source, updated.scan.summaryJson);
    const resolved = ecosystem
      ? await getPublicationMonitor(ecosystem)?.resolvePostReleaseReview(db, c.env, {
          organizationId,
          scanId: updated.scan.id,
          actorUserId: requestActorUserId(c),
        })
      : null;
    for (const tag of resolved?.badgeTags ?? []) {
      purgePublicFeedCache(
        optionalWorkerExecutionContext(c),
        canonicalOrigin(c),
        resolved?.badgeKey ?? null,
        tag,
      );
    }
  }

  return c.json({
    ...updated,
    postRelease: await postReleaseLink(db, organizationId, updated.scan.id, updated.scan.source),
  });
});
