/**
 * The publish / no-publish verdict on a scanned release.
 */
import { Hono } from "hono";
import { requireVerifiedEmail } from "../../lib/auth/email-verification";
import { SCAN_DECISIONS, type ScanDecision, getScan, recordScanDecision } from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
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

const DECISION_REASON_MAX = 500;
const DECISION_SET = new Set<ScanDecision>(SCAN_DECISIONS);

scanDecisionRoutes.post("/:id/decision", async (c) => {
  const unverified = requireVerifiedEmail(c);
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
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);

  const updated = await recordScanDecision(
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
          actorUserId: session.userId,
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
