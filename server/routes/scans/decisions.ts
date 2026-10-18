/**
 * The publish / no-publish verdict on a scanned release.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  EMAIL_VERIFICATION_REQUIRED_CODE,
  requireVerifiedEmail,
} from "../../lib/auth/email-verification";
import { emailVerificationAvailable } from "../../lib/auth";
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
import { badgeLookupKey, purgePublicFeedCache, scanDistTag } from "../../lib/public-feed";
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

scanDecisionRoutes.post("/:id/decision", async (c) => {
  const unverified = await requireVerifiedDecider(c, c.var.db);
  if (unverified) return unverified;
  const body = await readJsonObject<{
    decision: string;
    reason: string;
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

  return c.json(updated);
});
