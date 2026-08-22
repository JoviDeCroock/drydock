/**
 * Scan lifecycle: start one, list them, read one back, delete a failed one.
 *
 * Everything here is organization-scoped; a scan is only ever visible to the
 * organization that created it. `POST /` is rate limited per organization
 * because starting a scan spends registry egress and queue budget.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { getNpmConnection } from "../../db/npm-connections";
import { recordScanEvent } from "../../db/events";
import {
  ORGANIZATION_SCAN_LIMIT,
  ORGANIZATION_SCAN_WINDOW_MS,
  RateLimitError,
  enforceRateLimit,
} from "../../lib/platform/rate-limit";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  SCAN_DECISION_FILTERS,
  type ScanDecisionFilter,
  createScanJob,
  deleteFailedScan,
  getScan,
  getScanFile,
  getScanStatus,
  listScans,
} from "../../db/scans";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../../lib/auth/active-organization";
import { backfillScanArtifactsBatch } from "../../lib/scan/artifact-backfill";
import { deleteScanArtifacts, scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin, rateLimitResponse } from "../../lib/platform/http";
import { workerExecutionContext } from "../../lib/platform/execution-context";
import { allowInsecureLocalRegistry, decryptNpmToken } from "../../lib/ecosystems/npm/connection";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
} from "../../lib/ecosystems/npm/staged-publishes";
import { parseScanInput } from "../../lib/scan/input";
import { executeScanJob, type ScanQueueMessage } from "../../lib/scan/job";
import { roleCanManageIntegrations } from "../../lib/auth/roles";
import { recordProductEvent } from "../../lib/platform/analytics";
import type { Bindings, ScanInput, Variables } from "../../types";

export const scanLifecycleRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanLifecycleRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { input } = parsed;

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    await enforceRateLimit(c.env, {
      key: `scan:${organizationId}`,
      limit: ORGANIZATION_SCAN_LIMIT,
      windowMs: ORGANIZATION_SCAN_WINDOW_MS,
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

const DECISION_FILTER_SET = new Set<ScanDecisionFilter>(SCAN_DECISION_FILTERS);

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

scanLifecycleRoutes.get("/", async (c) => {
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

scanLifecycleRoutes.post("/artifacts/backfill", async (c) => {
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
    await enforceRateLimit(c.env, {
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

scanLifecycleRoutes.delete("/:id", async (c) => {
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

scanLifecycleRoutes.get("/:id", async (c) => {
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

scanLifecycleRoutes.get("/:id/status", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanStatus(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({ scan });
});

scanLifecycleRoutes.get("/:id/file", async (c) => {
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
