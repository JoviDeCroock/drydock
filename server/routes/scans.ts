import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { getOrganizationRole } from "../db/invitations";
import { getNpmConnection } from "../db/npm-connections";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  SCAN_DECISIONS,
  SCAN_DECISION_FILTERS,
  type ScanDecision,
  type ScanDecisionFilter,
  createScanJob,
  deleteFailedScan,
  getScan,
  getScanCompareData,
  getScanFile,
  getScanStatus,
  releaseGatingScanContext,
  listScans,
  recordScanDecision,
} from "../db/scans";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { requireReleaseDecisionStepUp } from "../lib/auth/release-step-up";
import { listGateIdsForReleaseSet } from "../db/ci-release-sets";
import { executeWorkflowGateJob } from "../lib/workflow-gate-job";
import { backfillScanArtifactsBatch } from "../lib/scan/artifact-backfill";
import { deleteScanArtifacts, scanArtifactReadBucket } from "../lib/scan/artifacts";
import {
  computeCompareMetadataCacheKey,
  loadCompare,
  readCompareMetadataCache,
  stripTextSamples,
  writeCompareMetadataCache,
} from "../lib/compare-cache";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../lib/platform/execution-context";
import { purgePublicFeedCache } from "../lib/public-feed";
import {
  enablePublicShare,
  readPublicShare,
  revokePublicShare,
  setThreatFeedListing,
} from "../db/scan-share";
import {
  allowInsecureLocalRegistry,
  decryptNpmToken,
  getOrganizationNpmToken,
} from "../lib/ecosystems/npm/connection";
import { isPublishedTarballUrlAllowed } from "../lib/ecosystems/npm/published-tarball";
import {
  compareSemver,
  fetchPackageMetadata,
  pickPreviousVersion,
  type RegistryMetadata,
} from "../lib/ecosystems/npm/registry";
import { annotateFindingsWithDiffStatus, createPackageDiff, type FileRecord } from "../lib/review";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import { parseScanInput } from "../lib/scan/input";
import { reportExportFilename, serializeReportExport } from "../lib/scan/report-export";
import { executeScanJob, type ScanQueueMessage } from "../lib/scan/job";
import { roleCanManageIntegrations, roleCanManagePublicShares } from "../lib/auth/roles";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
} from "../lib/ecosystems/npm/staged-publishes";
import { recordProductEvent } from "../lib/platform/analytics";
import type { Bindings, ScanInput, Variables } from "../types";

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Re-run every deployment gate bound to a release set after one of its packages
 * was decided. Failures are swallowed: the gate stays pending, which is the
 * safe state, and a redelivery or a later decision still resolves it.
 */
async function nudgeGatesForReleaseSet(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: ReturnType<typeof createDb>,
  organizationId: string,
  releaseSetId: string,
): Promise<void> {
  try {
    const gateIds = await listGateIdsForReleaseSet(db, { releaseSetId, organizationId });
    for (const gateId of gateIds) {
      const message = { kind: "workflow_gate" as const, organizationId, gateId };
      if (env.SCAN_QUEUE) await env.SCAN_QUEUE.send(message);
      else await executeWorkflowGateJob(env, executionCtx, message);
    }
  } catch (err) {
    emitOperationalEvent("warn", "scan_decision.gate_nudge_failed", {
      organizationId,
      releaseSetId,
      error: describeOperationalError(err),
    });
  }
}

scansRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { input } = parsed;

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    await enforceRateLimit(db, {
      key: `scan:${organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });

    const npmConnection = await getNpmConnection(db, organizationId);
    if (!npmConnection) {
      return c.json(
        { error: "Connect an organization npm token before scanning staged publishes." },
        400,
      );
    }
    if (npmConnection.validationStatus !== "valid") {
      return c.json(
        { error: "Validate the organization npm token before scanning staged publishes." },
        400,
      );
    }
    const token = await decryptNpmToken(c.env, npmConnection);
    const access = await checkStagedPublishAccess(npmConnection.registryUrl, token, input.stageId, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
    });
    if (!access.allowed) {
      return c.json(
        {
          error: "This organization's npm token cannot access that staged publish.",
          status: access.status,
        },
        403,
      );
    }

    // Best-effort: staged metadata gives the scan a package label up front, so
    // a scan whose tarball never parses still shows which package it was for.
    const staged = await fetchStagedPublishDetails(
      npmConnection.registryUrl,
      token,
      input.stageId,
      { allowInsecureLocalhost: allowInsecureLocalRegistry(c.env) },
    ).catch(() => null);

    const scanId = crypto.randomUUID();
    const detail = await createScanJob(db, {
      id: scanId,
      stageId: input.stageId,
      organizationId,
      ownerUserId: session.userId,
      packageName: staged?.packageName ?? null,
      stagedVersion: staged?.version ?? null,
    });
    if (!detail) return c.json({ error: "failed to create scan" }, 500);
    const message: ScanQueueMessage = {
      ...input,
      scanId,
      organizationId,
      actorUserId: session.userId,
    };

    // Counted at creation, not completion, so the queued → completed drop-off
    // is visible: a scan that never reaches a terminal state emits neither
    // `scan.completed` nor `scan.failed` and would otherwise vanish.
    recordProductEvent(c.env, {
      name: "scan.queued",
      organizationId,
      ecosystem: "npm",
      source: message.source ?? "manual",
    });

    if (c.env.SCAN_QUEUE) {
      await c.env.SCAN_QUEUE.send(message);
    } else {
      c.executionCtx.waitUntil(
        executeScanJob(c.env, workerExecutionContext(c.executionCtx), message, db, {
          finalAttempt: true,
        }),
      );
    }

    return c.json({ scan: detail?.scan, queued: Boolean(c.env.SCAN_QUEUE) }, 202);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "scan rate limit exceeded", err);
    }
    throw err;
  }
});

const DECISION_REASON_MAX = 500;
const DECISION_FILTER_SET = new Set<ScanDecisionFilter>(SCAN_DECISION_FILTERS);
const DECISION_SET = new Set<ScanDecision>(SCAN_DECISIONS);

function parseListScansCursor(raw: string | undefined) {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const createdAtMs = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(createdAtMs) || !id) return null;
  return { createdAtMs, id };
}

function encodeListScansCursor(cursor: { createdAtMs: number; id: string } | null) {
  return cursor ? `${cursor.createdAtMs}:${cursor.id}` : null;
}

scansRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);

  const rawFilter = c.req.query("filter");
  const decisionFilter: ScanDecisionFilter = DECISION_FILTER_SET.has(
    rawFilter as ScanDecisionFilter,
  )
    ? (rawFilter as ScanDecisionFilter)
    : "undecided";

  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(LIST_SCANS_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : LIST_SCANS_DEFAULT_LIMIT;

  const cursor = parseListScansCursor(c.req.query("cursor"));

  const result = await listScans(db, organizationId, { cursor, limit, decisionFilter });
  return c.json({
    scans: result.scans,
    nextCursor: encodeListScansCursor(result.nextCursor),
    filter: decisionFilter,
    limit,
  });
});

const BACKFILL_LIMIT_DEFAULT = 10;
const BACKFILL_LIMIT_MAX = 50;

scansRoutes.post("/artifacts/backfill", async (c) => {
  if (!c.env.ARTIFACTS) return c.json({ error: "artifact bucket is not configured" }, 503);

  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    limit: number;
    cursor: string | null;
  }>;
  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(BACKFILL_LIMIT_MAX, Math.max(1, Math.floor(rawLimit)))
    : BACKFILL_LIMIT_DEFAULT;
  const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;

  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `scan-artifact-backfill:${organizationId}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "artifact backfill rate limit exceeded", err);
    }
    throw err;
  }

  const result = await backfillScanArtifactsBatch(db, c.env.ARTIFACTS, organizationId, {
    limit,
    cursor,
  });
  return c.json(result);
});

scansRoutes.post("/:id/decision", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    reason: string;
    totpCode: string;
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

  // A staged-publish decision is an audit record: it never publishes or cancels
  // anything, so it deliberately needs no step-up. A decision on a *release-
  // gating* scan is different — a pushed release set can be approved here before
  // its deployment gate exists, and the gate then collects that decision and
  // releases the held job. That is the same irreversible act the gate route
  // guards, so it carries the same guard. Without this, deciding through this
  // route would be a way around an organization's release 2FA policy.
  const gating = await releaseGatingScanContext(db, c.req.param("id"), organizationId);
  if (gating.isGating) {
    const stepUp = await requireReleaseDecisionStepUp(c, db, session.userId, organizationId, {
      totpCode: typeof body.totpCode === "string" ? body.totpCode.trim() : "",
      rateLimitKey: `scans:release-decision-2fa:${session.userId}`,
    });
    if (stepUp) return stepUp;
  }

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
    return c.json({ error: "decision can only be set on completed scans" }, 409);
  }

  // A pushed release may already have deployment gates waiting on it. Re-run
  // them so the aggregate is re-evaluated now that this package is decided;
  // otherwise a release decided through this route (rather than the gate
  // dialog) would leave the held job waiting for a webhook redelivery that may
  // never come. Best effort — the decision itself is already durable.
  if (gating.releaseSetId) {
    c.executionCtx.waitUntil(
      nudgeGatesForReleaseSet(
        c.env,
        workerExecutionContext(c.executionCtx),
        db,
        organizationId,
        gating.releaseSetId,
      ),
    );
  }

  return c.json(updated);
});

scansRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
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
// opt-in, so it takes owner/admin, not plain membership.
scansRoutes.post("/:id/share", async (c) => {
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
    return c.json({ error: "only completed scans can be shared publicly" }, 409);
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
      );
      share = updated;
    }
  }
  return c.json({ share: publicShareResponse(c, share) });
});

scansRoutes.delete("/:id/share", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManagePublicShares(role)) return c.json({ error: "forbidden" }, 403);

  const { revoked, publicPackageKey } = await revokePublicShare(db, {
    scanId: c.req.param("id"),
    organizationId,
    actorUserId: session.userId,
  });
  if (!revoked) {
    const existing = await getScanStatus(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
  } else {
    purgePublicFeedCache(optionalWorkerExecutionContext(c), canonicalOrigin(c), publicPackageKey);
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

scansRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScan(db, c.req.param("id"), organizationId, scanArtifactReadBucket(c.env), {
    files: "list",
  });
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({
    ...scan,
    scan: {
      ...scan.scan,
      publicShareUrl: scan.scan.publicShareToken
        ? `${canonicalOrigin(c)}/reports/${scan.scan.publicShareToken}`
        : null,
    },
  });
});

scansRoutes.get("/:id/status", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanStatus(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({ scan });
});

scansRoutes.get("/:id/file", async (c) => {
  const path = c.req.query("path") || "";
  if (!path) return c.json({ error: "path is required" }, 400);
  const db = createDb(c.env.DB);
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

scansRoutes.get("/:id/report.json", async (c) => {
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

scansRoutes.get("/:id/versions", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanStatus(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  if (!scan.packageName) {
    return c.json({
      packageName: null,
      stagedVersion: scan.stagedVersion ?? null,
      defaultPreviousVersion: scan.previousVersion ?? null,
      versions: [],
    });
  }

  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(db, {
        key: `compare-versions:${session.userId}`,
        limit: 60,
        windowMs: 60 * 1000,
      }),
      getOrganizationNpmToken(db, c.env, organizationId).catch((err) => {
        emitOperationalEvent("warn", "npm_connection.token_retrieval_failed", {
          organizationId,
          error: describeOperationalError(err),
        });
        return null;
      }),
    ]);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "rate limit exceeded", err);
    }
    throw err;
  }

  const registryUrl = connection?.registryUrl || c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  const metadata = await fetchPackageMetadataCached(c, {
    packageName: scan.packageName,
    registryUrl,
    cacheScope: `org:${organizationId}`,
    npmToken: connection?.token,
  }).catch((err) => {
    emitOperationalEvent("warn", "registry.metadata_fetch_failed", {
      packageName: scan.packageName,
      error: describeOperationalError(err),
    });
    return null;
  });
  if (!metadata) {
    return c.json({
      packageName: scan.packageName,
      stagedVersion: scan.stagedVersion ?? null,
      defaultPreviousVersion: scan.previousVersion ?? null,
      versions: [],
    });
  }

  const tagsByVersion = new Map<string, string[]>();
  for (const [tag, version] of Object.entries(metadata["dist-tags"] ?? {})) {
    if (!version) continue;
    const list = tagsByVersion.get(version) ?? [];
    list.push(tag);
    tagsByVersion.set(version, list);
  }
  const times = metadata.time ?? {};
  const stagedVersion = scan.stagedVersion ?? null;
  const versions = Object.keys(metadata.versions ?? {})
    .filter((version) => version !== stagedVersion)
    .sort((a, b) => compareSemver(b, a))
    .map((version) => ({
      version,
      distTags: (tagsByVersion.get(version) ?? []).sort(),
      publishedAt: typeof times[version] === "string" ? times[version] : undefined,
    }));

  return c.json({
    packageName: scan.packageName,
    stagedVersion,
    defaultPreviousVersion:
      scan.previousVersion ?? (stagedVersion ? pickPreviousVersion(metadata, stagedVersion) : null),
    versions,
  });
});

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

async function resolveCompareContext(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
) {
  const version = c.req.query("version") || "";
  if (!version) return { error: c.json({ error: "version is required" }, 400) } as const;
  if (!VERSION_RE.test(version))
    return { error: c.json({ error: "invalid version" }, 400) } as const;

  const scanId = c.req.param("id") ?? "";
  if (!scanId) return { error: c.json({ error: "missing scan id" }, 400) } as const;

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanCompareData(db, scanId, organizationId, scanArtifactReadBucket(c.env));
  if (!scan) return { error: c.json({ error: "not found" }, 404) } as const;
  if (!scan.scan.packageName)
    return { error: c.json({ error: "scan has no package name" }, 400) } as const;

  return {
    version,
    db,
    session,
    organizationId,
    scan,
    packageName: scan.scan.packageName,
  } as const;
}

scansRoutes.get("/:id/compare", async (c) => {
  const ctx = await resolveCompareContext(c);
  if ("error" in ctx) return ctx.error;

  const loaded = await loadCompareArchive(c, ctx, {
    rateLimitKey: `compare-fetch:${ctx.session.userId}`,
    rateLimit: 30,
  });
  if ("error" in loaded) return loaded.error;

  return c.json(
    {
      version: loaded.cached.version,
      files: stripTextSamples(loaded.cached.files),
      packageJson: loaded.cached.packageJson,
      findingAnnotations: buildCompareFindingAnnotations(ctx.scan, loaded.cached.files),
      cachedAt: loaded.cached.cachedAt,
    },
    200,
    { "cache-control": "private, max-age=300" },
  );
});

type CompareContext = Extract<
  Awaited<ReturnType<typeof resolveCompareContext>>,
  { version: string }
>;

async function loadCompareArchive(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
  ctx: CompareContext,
  options: { rateLimitKey: string; rateLimit: number },
) {
  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(ctx.db, {
        key: options.rateLimitKey,
        limit: options.rateLimit,
        windowMs: 60 * 1000,
      }),
      getOrganizationNpmToken(ctx.db, c.env, ctx.organizationId).catch((err) => {
        emitOperationalEvent("warn", "npm_connection.token_retrieval_failed", {
          organizationId: ctx.organizationId,
          error: describeOperationalError(err),
        });
        return null;
      }),
    ]);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        error: rateLimitResponse(c, "rate limit exceeded", err),
      } as const;
    }
    throw err;
  }

  const registryUrl = connection?.registryUrl || c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  const metadata = await fetchPackageMetadataCached(c, {
    packageName: ctx.packageName,
    registryUrl,
    cacheScope: `org:${ctx.organizationId}`,
    npmToken: connection?.token,
  }).catch((err) => {
    emitOperationalEvent("warn", "registry.metadata_fetch_failed", {
      packageName: ctx.packageName,
      error: describeOperationalError(err),
    });
    return null;
  });
  const tarballUrl = metadata?.versions?.[ctx.version]?.dist?.tarball;
  if (!tarballUrl) return { error: c.json({ error: "unknown version" }, 404) } as const;

  const allowInsecureLocalhost = allowInsecureLocalRegistry(c.env);
  if (!isPublishedTarballUrlAllowed(tarballUrl, registryUrl, allowInsecureLocalhost)) {
    return {
      error: c.json({ error: "registry returned an unexpected tarball URL" }, 502),
    } as const;
  }

  const cached = await loadCompare(c.env, workerExecutionContext(c.executionCtx), ctx.version, {
    tarballUrl,
    registryUrl,
    npmToken: connection?.token,
    cacheScope: `org:${ctx.organizationId}`,
    allowInsecureLocalhost,
  });

  return { cached } as const;
}

async function fetchPackageMetadataCached(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
  input: {
    packageName: string;
    registryUrl: string;
    cacheScope: string;
    npmToken?: string;
  },
): Promise<RegistryMetadata> {
  const key = await computeCompareMetadataCacheKey(input);
  const cached = await readCompareMetadataCache(c.env, key);
  if (cached) return cached;

  const metadata = await fetchPackageMetadata(c.env, input.packageName, {
    npmToken: input.npmToken,
    npmRegistry: input.registryUrl,
  });
  await writeCompareMetadataCache(c.env, workerExecutionContext(c.executionCtx), key, metadata);
  return metadata;
}

function buildCompareFindingAnnotations(
  scan: NonNullable<Awaited<ReturnType<typeof getScanCompareData>>>,
  previousFiles: FileRecord[],
) {
  const stagedFiles = scanFilesToFileRecords(scan.files);
  const diff = createPackageDiff(previousFiles, stagedFiles);
  return annotateFindingsWithDiffStatus(scan.findings, diff, {
    previousFiles,
    stagedFiles,
  }).map((finding) => ({
    id: finding.id,
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));
}

function scanFilesToFileRecords(
  files: Array<{
    path: string;
    size: number | null;
    sha256: string | null;
    flagsJson: unknown;
    textSample: string | null;
  }>,
): FileRecord[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size ?? 0,
    sha256: file.sha256 ?? "",
    textSample: file.textSample ?? undefined,
    flags: Array.isArray(file.flagsJson)
      ? file.flagsJson.filter((flag): flag is string => typeof flag === "string")
      : [],
  }));
}

scansRoutes.get("/:id/compare/file", async (c) => {
  const ctx = await resolveCompareContext(c);
  if ("error" in ctx) return ctx.error;
  const path = c.req.query("path") || "";
  if (!path) return c.json({ error: "path is required" }, 400);

  const loaded = await loadCompareArchive(c, ctx, {
    rateLimitKey: `compare-file:${ctx.session.userId}`,
    rateLimit: 240,
  });
  if ("error" in loaded) return loaded.error;

  const file = loaded.cached.files.find((entry) => entry.path === path);
  if (!file) return c.json({ error: "file not found in version" }, 404);

  return c.json({ version: loaded.cached.version, file }, 200, {
    "cache-control": "private, max-age=300",
  });
});
