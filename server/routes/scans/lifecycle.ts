/**
 * Scan lifecycle: start one, list them, read one back, delete a failed one.
 *
 * Everything here is organization-scoped; a scan is only ever visible to the
 * organization that created it. `POST /` is rate limited per organization
 * because starting a scan spends registry egress and queue budget.
 */
import { Hono } from "hono";
import {
  ORGANIZATION_SCAN_LIMIT,
  ORGANIZATION_SCAN_WINDOW_MS,
  guardRateLimit,
} from "../../lib/rate-limit";
import type { AppDb } from "../../db/client";
import { getNpmConnection } from "../../db/npm-connections";
import { recordScanEvent } from "../../db/events";
import { postReleaseLink } from "../../db/publication-alerts";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  SCAN_DECISION_FILTERS,
  type ScanDecisionFilter,
  deleteFailedScan,
  deletePendingScanJob,
  findLiveStageReviewId,
  findMemberScanOrganization,
  getScan,
  getScanFile,
  getScanStatus,
  listScans,
  readScanRiskBreakdown,
  scanPublicDisclosureAllowed,
  StageReviewExistsError,
} from "../../db/scans";
import { recordApiKeyAction } from "../../db/api-keys";
import {
  requestActorUserId,
  requestBudgetKey,
  requireActiveOrganization,
} from "../../lib/auth/active-organization";
import { deleteScanArtifacts, scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin, parseLimitQuery, readJsonObject } from "../../lib/platform/http";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import { allowInsecureLocalRegistry, decryptNpmToken } from "../../lib/ecosystems/npm/connection";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
} from "../../lib/ecosystems/npm/staged-publishes";
import { getPublicationMonitor, getStagedAdapter } from "../../lib/ecosystems";
import { parseScanInput } from "../../lib/scan/input";
import { encodeListScansCursor, parseListScansCursor } from "../../lib/scan/list-cursor";
import {
  createPreparedScan,
  enqueuePreparedScan,
  preparePublishedScan,
  type PreparedScan,
} from "../../lib/scan/start";
import type { Bindings, ScanInput, Variables } from "../../types";
import { PackageClaimConflictError } from "../../db/package-claims";
import { readNpmPackageClaimAvailability } from "../../db/scan-jobs";

export const scanLifecycleRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanLifecycleRoutes.post("/", async (c) => {
  const body = await readJsonObject<ScanInput>(c);
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const db = c.var.db;
  // A `scan` API key acts as its creator (`requestActorUserId`).
  const actorUserId = requestActorUserId(c);
  const organizationId = await requireActiveOrganization(c, db);

  // A stage this organization already reviews is answered with that review: a
  // re-run CI job, or one racing the cron or "Check npm", must not pay for a
  // second review or supersede one a person already decided. `createScanJob`
  // repeats the check atomically for requests that pass this one together.
  if (parsed.kind === "staged") {
    const existingId = await findLiveStageReviewId(db, organizationId, parsed.input.stageId);
    if (existingId) return existingReview(c, db, organizationId, existingId);
  }

  const limited = await guardRateLimit(
    c,
    {
      key: requestBudgetKey(c, `scan:${organizationId}`),
      limit: ORGANIZATION_SCAN_LIMIT,
      windowMs: ORGANIZATION_SCAN_WINDOW_MS,
    },
    "scan rate limit exceeded",
  );
  if (limited) return limited;

  const prepared =
    parsed.kind === "published"
      ? await preparePublishedScan(c, parsed.request)
      : await prepareStagedScan(c, db, organizationId, parsed.input);
  if ("error" in prepared) return prepared.error;

  const scanId = crypto.randomUUID();
  const detail = await createPreparedScan(db, {
    scanId,
    organizationId,
    ownerUserId: actorUserId,
    prepared,
  }).catch((err: unknown) => {
    if (err instanceof PackageClaimConflictError || err instanceof StageReviewExistsError) {
      return err;
    }
    throw err;
  });
  if (detail instanceof StageReviewExistsError) {
    return existingReview(c, db, organizationId, detail.scanId);
  }
  if (detail instanceof PackageClaimConflictError) {
    // The caller already proved stage access; only its own history is described.
    const availability = await readNpmPackageClaimAvailability(db, {
      registryUrl: prepared.registryUrl!,
      packageName: prepared.packageName!,
      organizationId,
    });
    const error =
      availability === "own_history"
        ? "This organization's earlier reviews of this package are awaiting an ownership confirmation by support. New reviews can start once support confirms it."
        : detail.message;
    return c.json({ error }, 409);
  }
  if (!detail) return c.json({ error: "failed to create scan" }, 500);
  try {
    if (prepared.staged) {
      await getPublicationMonitor("npm")?.registerStagedReleases(db, c.env, {
        organizationId,
        registryUrl: prepared.registryUrl!,
        releases: [prepared.staged],
      });
    }
    await enqueuePreparedScan(c, db, {
      scanId,
      organizationId,
      actorUserId,
      prepared,
    });
  } catch (err) {
    // A pending row nothing will run would answer every retry of this stage as
    // an existing review (see the check above), so the start is undone.
    await deletePendingScanJob(db, scanId, organizationId);
    throw err;
  }

  const apiKey = c.get("apiKey");
  if (apiKey) {
    // The review is already queued; a failed audit write must not answer 500
    // and invite a CI retry that starts a second one.
    await recordApiKeyAction(db, apiKey, {
      type: "organization.api_key_review_started",
      scanId,
      metadata: {
        ecosystem: prepared.ecosystem,
        packageName: prepared.packageName,
        stagedVersion: prepared.version,
      },
    }).catch((err: unknown) => {
      emitOperationalEvent("error", "api_key.audit_failed", {
        apiKeyId: apiKey.id,
        scanId,
        error: describeOperationalError(err),
      });
    });
  }

  return c.json({ scan: detail?.scan, queued: Boolean(c.env.SCAN_QUEUE), existing: false }, 202);
});

type ScanRouteContext = import("hono").Context<{ Bindings: Bindings; Variables: Variables }>;

async function existingReview(
  c: ScanRouteContext,
  db: AppDb,
  organizationId: string,
  scanId: string,
): Promise<Response> {
  const existing = await getScan(db, scanId, organizationId);
  if (!existing) return c.json({ error: "failed to create scan" }, 500);
  return c.json({ scan: existing.scan, queued: false, existing: true }, 200);
}

async function prepareStagedScan(
  c: ScanRouteContext,
  db: AppDb,
  organizationId: string,
  input: ScanInput,
): Promise<PreparedScan | { error: Response }> {
  const npmConnection = await getNpmConnection(db, organizationId);
  if (!npmConnection) {
    return {
      error: c.json(
        { error: "Connect an organization npm token before scanning staged publishes." },
        400,
      ),
    };
  }
  if (npmConnection.validationStatus !== "valid") {
    return {
      error: c.json(
        { error: "Validate the organization npm token before scanning staged publishes." },
        400,
      ),
    };
  }
  const token = await decryptNpmToken(c.env, npmConnection);
  const access = await checkStagedPublishAccess(npmConnection.registryUrl, token, input.stageId, {
    allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
  });
  if (!access.allowed) {
    return {
      error: c.json(
        {
          error: "This organization's npm token cannot access that staged publish.",
          status: access.status,
        },
        403,
      ),
    };
  }

  if (access.status === null || access.status < 200 || access.status >= 300) {
    return { error: c.json({ error: "Could not verify npm stage access. Try again later." }, 503) };
  }

  // Package claims need a registry identity before admission; manifest bytes
  // cannot grant ownership and a transient metadata failure must not reserve it.
  const staged = await fetchStagedPublishDetails(npmConnection.registryUrl, token, input.stageId, {
    allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
  }).catch(() => null);

  if (!staged?.packageName || staged.id !== input.stageId || !staged.version?.trim()) {
    return {
      error: c.json({ error: "Could not verify npm package identity. Try again later." }, 503),
    };
  }
  // npm answered with a complete stage record; a name that still fails
  // validation is permanent, so retrying would never help.
  if (
    !getStagedAdapter("npm").stagedClaimIdentity?.({
      registryUrl: npmConnection.registryUrl,
      packageName: staged.packageName,
      version: staged.version,
    })
  ) {
    return {
      error: c.json(
        { error: "npm reported a package name for this stage that Drydock cannot review." },
        422,
      ),
    };
  }

  return {
    input,
    source: "manual",
    ecosystem: "npm",
    packageName: staged?.packageName ?? null,
    version: staged?.version ?? null,
    stagedCreatedAt: staged?.createdAt ?? null,
    stagedDeclaredSha1: staged?.shasum ?? null,
    registryUrl: npmConnection.registryUrl,
    stageAccessStatus: access.status,
    staged,
  };
}

const DECISION_FILTER_SET = new Set<ScanDecisionFilter>(SCAN_DECISION_FILTERS);

scanLifecycleRoutes.get("/", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);

  const rawFilter = c.req.query("filter");
  const decisionFilter: ScanDecisionFilter = DECISION_FILTER_SET.has(
    rawFilter as ScanDecisionFilter,
  )
    ? (rawFilter as ScanDecisionFilter)
    : "undecided";

  const limit = parseLimitQuery(c.req.query("limit"), {
    default: LIST_SCANS_DEFAULT_LIMIT,
    max: LIST_SCANS_MAX_LIMIT,
  });

  const cursor = parseListScansCursor(c.req.query("cursor"));

  const result = await listScans(db, organizationId, { cursor, limit, decisionFilter });
  return c.json({
    scans: result.scans,
    nextCursor: encodeListScansCursor(result.nextCursor),
    filter: decisionFilter,
    limit,
  });
});

scanLifecycleRoutes.delete("/:id", async (c) => {
  const db = c.var.db;
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scanId = c.req.param("id");

  const result = await deleteFailedScan(db, scanId, organizationId);
  if (result.outcome === "not_found") return c.json({ error: "not found" }, 404);
  if (result.outcome === "not_failed") {
    return c.json({ error: "only failed scans can be deleted" }, 409);
  }

  await Promise.all([
    deleteScanArtifacts(c.env.ARTIFACTS, organizationId, scanId),
    recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "scan.deleted",
      metadata: { scanId, status: "failed", source: result.source },
    }),
  ]);
  return c.json({ ok: true, id: scanId });
});

// Public share link management. Enabling exposes the completed scan's
// canonical report export (and its signed attestation) at
// /public/reports/:token to anyone holding the link — an explicit, elevated

scanLifecycleRoutes.get("/:id", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScan(db, c.req.param("id"), organizationId, scanArtifactReadBucket(c.env), {
    files: "list",
  });
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({
    ...scan,
    postRelease: await postReleaseLink(db, organizationId, scan.scan.id, scan.scan.source),
    scan: {
      ...scan.scan,
      publicShareUrl: scan.scan.publicShareToken
        ? `${canonicalOrigin(c)}/reports/${scan.scan.publicShareToken}`
        : null,
      publicShareIncludesFiles: scan.scan.publicShareIncludesFiles,
      publicShareAwaitingPublication: scan.scan.publicShareToken
        ? !(await scanPublicDisclosureAllowed(db, { scanId: scan.scan.id, organizationId }))
        : false,
    },
  });
});

scanLifecycleRoutes.get("/:id/status", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const status = await getScanStatus(db, c.req.param("id"), organizationId);
  if (!status) return c.json({ error: "not found" }, 404);
  const { baselineComparisonSkipped, ...scan } = status;
  // The release/context split, so a poller can gate on release risk as the
  // workflow gate does. With no baseline compared there is no release delta,
  // and the gate asks for manual review; null sends a poller to overall risk.
  const riskSummary =
    scan.status === "complete" && !baselineComparisonSkipped
      ? readScanRiskBreakdown(scan.riskSummaryJson)
      : null;
  return c.json({ scan, riskSummary });
});

// The one scan read that does not resolve the active organization: a link
// without `?org=` (the workflow gate's GitHub comment has no room for it) asks
// which of the caller's own organizations holds the scan, so the page can pin
// that one. Not found and not a member are the same 404 as `GET /:id`.
scanLifecycleRoutes.get("/:id/organization", async (c) => {
  const session = c.get("authSession");
  const organizationId = await findMemberScanOrganization(
    c.var.db,
    c.req.param("id"),
    session.userId,
  );
  if (!organizationId) return c.json({ error: "not found" }, 404);
  return c.json({ organizationId });
});

scanLifecycleRoutes.get("/:id/file", async (c) => {
  const path = c.req.query("path") || "";
  if (!path) return c.json({ error: "path is required" }, 400);
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const file = await getScanFile(
    db,
    c.req.param("id"),
    organizationId,
    path,
    scanArtifactReadBucket(c.env),
  );
  if (!file) return c.json({ error: "file not found in scan" }, 404);
  return c.json({ file }, 200, { "cache-control": "private, max-age=300" });
});
