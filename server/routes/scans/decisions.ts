/**
 * The publish / no-publish verdict on a scanned release.
 */
import { Hono } from "hono";
import { requireVerifiedEmail } from "../../lib/auth/email-verification";
import { createDb } from "../../db/client";
import { SCAN_DECISIONS, type ScanDecision, getScan, recordScanDecision } from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin } from "../../lib/platform/http";
import { optionalWorkerExecutionContext } from "../../lib/platform/execution-context";
import { purgePublicFeedCache, scanDistTag } from "../../lib/public-feed";
import { badgeLookupKey } from "../../db/scan-share";
import type { Bindings, Variables } from "../../types";

export const scanDecisionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const DECISION_REASON_MAX = 500;
const DECISION_SET = new Set<ScanDecision>(SCAN_DECISIONS);

scanDecisionRoutes.post("/:id/decision", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    reason: string;
  }>;
  if (!DECISION_SET.has(body.decision as ScanDecision)) {
    return c.json({ error: "decision must be 'publish' or 'no_publish'" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (reason && reason.length > DECISION_REASON_MAX) {
    return c.json({ error: `reason must be <= ${DECISION_REASON_MAX} characters` }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);

  const result = await recordScanDecision(
    db,
    {
      scanId: c.req.param("id"),
      organizationId,
      actorUserId: session.userId,
      decision: body.decision as ScanDecision,
      reason,
    },
    scanArtifactReadBucket(c.env),
    c.env,
  );

  if (result.outcome !== "recorded") {
    // Existence check only — skip the R2 artifact load; the detail is discarded.
    const existing = await getScan(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.scan.registryStatusSupersededAt) {
      return c.json(
        { error: "decision cannot be changed after this staged release was superseded" },
        409,
      );
    }
    if (existing.scan.source === "workflow_gate") {
      return c.json({ error: "workflow-gate decisions must be submitted through the gate" }, 409);
    }
    return c.json({ error: "decision can only be set on completed scans" }, 409);
  }
  const updated = result.detail;

  // A decision changes what a listed scan's cached badge and feed entry
  // assert ("reviewed · risk" → "approved"/"blocked"), and a publish →
  // no_publish flip must not leave a brightgreen "approved" badge sitting in
  // this colo for the full TTL. Same canonical-origin purge as (un)listing.
  // An approval that has not yet met the org's bar changes nothing the badge
  // asserts, so it is not worth a purge.
  if (result.verdictChanged && updated.scan.publicFeedListedAt) {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      badgeLookupKey({
        source: updated.scan.source,
        packageName: updated.scan.packageName,
        summaryJson: updated.scan.summaryJson,
      }),
      // The scan's own release line: purging the default entry for an `rc`
      // review would leave the stale rc badge cached and drop an unrelated one.
      scanDistTag(updated.scan.summaryJson),
    );
  }

  return c.json({ ...updated, approvals: result.approvals });
});
