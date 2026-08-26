/**
 * Getting a completed review out of the dashboard.
 *
 * Two ways, both owner/admin only: minting an unguessable public share token
 * (the capability behind /public/reports/*), and the authenticated report
 * export. Both serve the scan report and nothing else.
 */
import { Hono, type Context } from "hono";
import { createDb } from "../../db/client";
import { getOrganizationRole } from "../../db/invitations";
import { getScan, getScanStatus } from "../../db/scans";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../../lib/auth/active-organization";
import { scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin } from "../../lib/platform/http";
import { optionalWorkerExecutionContext } from "../../lib/platform/execution-context";
import { purgePublicFeedCache } from "../../lib/public-feed";
import {
  enablePublicShare,
  readPublicShare,
  revokePublicShare,
  setThreatFeedListing,
} from "../../db/scan-share";
import { reportExportFilename, serializeReportExport } from "../../lib/scan/report-export";
import { roleCanManagePublicShares } from "../../lib/auth/roles";
import type { Bindings, Variables } from "../../types";

export const scanSharingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// opt-in, so it takes owner/admin, not plain membership.
scanSharingRoutes.post("/:id/share", async (c) => {
  // `?? {}` also covers a literal `null` body, which json() parses successfully.
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<{ threatFeed: boolean }>;
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManagePublicShares(role)) return c.json({ error: "forbidden" }, 403);

  // `threatFeed: false` is a *withdrawal*. Routing it through
  // enablePublicShare would mint a fresh token whenever the scan has none, so
  // an admin unchecking "List publicly" on a dialog whose link another admin
  // just revoked would republish the report — the wrong failure direction, and
  // invisible, because the response then hands back a live URL. Read the
  // existing share instead and let the 409 below tell the stale dialog to
  // refresh (the UI drops its share state on 409).
  const unlisting = body.threatFeed === false;
  let share = unlisting
    ? await readPublicShare(db, { scanId: c.req.param("id"), organizationId })
    : await enablePublicShare(db, {
        scanId: c.req.param("id"),
        organizationId,
        actorUserId: session.userId,
      });
  if (!share) {
    const existing = await getScanStatus(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
    // Revoking nulls the token *and* its timestamp, so "revoked a moment ago"
    // and "never shared" are the same persisted state — there is nothing to
    // tell them apart with. Say the part that is true either way; the UI drops
    // its stale share state on 409 regardless.
    if (unlisting) return c.json({ error: "this report is not shared publicly" }, 409);
    return c.json({ error: "only active completed scans can be shared publicly" }, 409);
  }
  // Threat-feed listing is a second opt-in layered on the link: only flip it
  // when the caller states an intent, so a plain re-share never (un)lists.
  if (typeof body.threatFeed === "boolean") {
    const listedNow = share.publicFeedListedAt !== null;
    if (body.threatFeed !== listedNow) {
      const updated = await setThreatFeedListing(db, {
        scanId: c.req.param("id"),
        organizationId,
        actorUserId: session.userId,
        listed: body.threatFeed,
      });
      // A concurrent revoke can void the share between the enable and the
      // toggle; the stale pre-revoke state must not be reported as current.
      if (!updated) return c.json({ error: "the share link was just revoked" }, 409);
      // Unlisting (and re-listing) changes what the cached badge and feed
      // assert; drop both so the change is not delayed by the colo TTL in at
      // least this region. canonicalOrigin, not the request origin: the badge
      // writes its entry under the same value, and this request arrives at the
      // dashboard, which may be a different hostname than the one embedders hit.
      purgePublicFeedCache(
        optionalWorkerExecutionContext(c),
        canonicalOrigin(c),
        updated.publicPackageKey ?? null,
        updated.publicBadgeTag ?? null,
      );
      share = updated;
    }
  }
  return c.json({ share: publicShareResponse(c, share) });
});

scanSharingRoutes.delete("/:id/share", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManagePublicShares(role)) return c.json({ error: "forbidden" }, 403);

  const { revoked, publicPackageKey, publicBadgeTag } = await revokePublicShare(db, {
    scanId: c.req.param("id"),
    organizationId,
    actorUserId: session.userId,
  });
  if (!revoked) {
    const existing = await getScanStatus(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
  } else {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      publicPackageKey,
      publicBadgeTag,
    );
  }
  return c.json({ revoked });
});

function publicShareResponse(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  share: { publicShareToken: string; publicSharedAt: Date; publicFeedListedAt: Date | null },
) {
  return {
    token: share.publicShareToken,
    url: `${canonicalOrigin(c)}/reports/${share.publicShareToken}`,
    sharedAt: share.publicSharedAt,
    threatFeedListedAt: share.publicFeedListedAt,
  };
}

scanSharingRoutes.get("/:id/report.json", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await resolveReportExportOrganization(c, db);
  if (!organizationId) return c.json({ error: "not found" }, 404);
  // Full-detail export: the findings come from R2 for artifact-backed scans, so
  // load the artifact bucket (unlike the metadata-only reads below). `omit`
  // skips the file-samples artifact the export never reads, and keeps this
  // route byte-identical to the public share route by construction — both go
  // through the same artifact reads, so neither can degrade to the D1 fallback
  // while the other does not.
  const detail = await getScan(
    db,
    c.req.param("id"),
    organizationId,
    scanArtifactReadBucket(c.env),
    {
      files: "omit",
    },
  );
  if (!detail) return c.json({ error: "not found" }, 404);
  if (detail.scan.status !== "complete") {
    return c.json({ error: "report export is only available for completed scans" }, 409);
  }
  // Canonical, stable-ordered serialization so re-exports are byte-identical and
  // two artifacts describing the same evidence compare equal. Served as a
  // download; no scan.viewed event is recorded for a pure export.
  return new Response(serializeReportExport(detail), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${reportExportFilename(detail.scan)}"`,
      "cache-control": "private, no-store",
    },
  });
});

async function resolveReportExportOrganization(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: ReturnType<typeof createDb>,
): Promise<string | null> {
  const requested = c.req.query("organizationId")?.trim() || null;
  if (!requested) return requireActiveOrganization(c, db);
  const session = c.get("authSession");
  return (await getOrganizationRole(db, requested, session.userId)) ? requested : null;
}
