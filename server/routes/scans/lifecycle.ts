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
  type ScanSource,
  createScanJob,
  deleteFailedScan,
  getScan,
  getScanFile,
  getScanStatus,
  listScans,
} from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { deleteScanArtifacts, scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin, rateLimitResponse } from "../../lib/platform/http";
import { workerExecutionContext } from "../../lib/platform/execution-context";
import { allowInsecureLocalRegistry, decryptNpmToken } from "../../lib/ecosystems/npm/connection";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
} from "../../lib/ecosystems/npm/staged-publishes";
import { getPublishedAdapter } from "../../lib/ecosystems";
import { publishedPairStageId } from "../../lib/ecosystems/published-pair";
import { PublicDiffError } from "../../lib/public-diff/error";
import { parseScanInput, type PublishedScanRequest } from "../../lib/scan/input";
import { executeScanJob, type ScanQueueMessage } from "../../lib/scan/job";
import { recordProductEvent } from "../../lib/platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import type { Bindings, ScanInput, Variables } from "../../types";

export const scanLifecycleRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanLifecycleRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    await enforceRateLimit(c.env, {
      key: `scan:${organizationId}`,
      limit: ORGANIZATION_SCAN_LIMIT,
      windowMs: ORGANIZATION_SCAN_WINDOW_MS,
    });

    const prepared =
      parsed.kind === "published"
        ? await preparePublishedScan(c, parsed.request)
        : await prepareStagedScan(c, db, organizationId, parsed.input);
    if ("error" in prepared) return prepared.error;

    const scanId = crypto.randomUUID();
    const detail = await createScanJob(db, {
      id: scanId,
      stageId: prepared.input.stageId,
      organizationId,
      ownerUserId: session.userId,
      source: prepared.source,
      packageName: prepared.packageName,
      stagedVersion: prepared.version,
      registryUrl: prepared.registryUrl,
    });
    if (!detail) return c.json({ error: "failed to create scan" }, 500);
    const message: ScanQueueMessage = {
      ...prepared.input,
      scanId,
      organizationId,
      actorUserId: session.userId,
      source: prepared.source,
    };

    // Counted at creation, not completion, so the queued → completed drop-off
    // is visible: a scan that never reaches a terminal state emits neither
    // `scan.completed` nor `scan.failed` and would otherwise vanish.
    recordProductEvent(c.env, {
      name: "scan.queued",
      organizationId,
      ecosystem: prepared.ecosystem,
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

type ScanRouteContext = import("hono").Context<{ Bindings: Bindings; Variables: Variables }>;

interface PreparedScan {
  input: ScanInput;
  source: ScanSource;
  ecosystem: string;
  packageName: string | null;
  version: string | null;
  /**
   * Only a staged npm scan captures one. A published-pair review must leave it
   * null: `createScanJob` uses it to claim the registry coordinates a staged
   * release owns, and a review of an already-public version has no claim on them.
   */
  registryUrl: string | null;
}

async function prepareStagedScan(
  c: ScanRouteContext,
  db: ReturnType<typeof createDb>,
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

  // Best-effort: staged metadata gives the scan a package label up front, so
  // a scan whose tarball never parses still shows which package it was for.
  const staged = await fetchStagedPublishDetails(npmConnection.registryUrl, token, input.stageId, {
    allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
  }).catch(() => null);

  return {
    input,
    source: "manual",
    ecosystem: "npm",
    packageName: staged?.packageName ?? null,
    version: staged?.version ?? null,
    registryUrl: npmConnection.registryUrl,
  };
}

/**
 * Resolve a published `package@version` against its public registry before any
 * scan row exists, so an unpublished version is a request error rather than a
 * scan that fails minutes later, and the queued message names an exact pair.
 *
 * No npm credential is read, decrypted, or attached here: acquisition reuses
 * the same public brokers the anonymous `/diff` surface uses.
 */
async function preparePublishedScan(
  c: ScanRouteContext,
  request: PublishedScanRequest,
): Promise<PreparedScan | { error: Response }> {
  const adapter = getPublishedAdapter(request.ecosystem);
  if (!adapter) return { error: c.json({ error: "unsupported ecosystem" }, 400) };

  let resolved: Awaited<ReturnType<typeof adapter.resolvePair>>;
  try {
    resolved = await adapter.resolvePair(c.env, workerExecutionContext(c.executionCtx), request);
  } catch (err) {
    emitOperationalEvent("warn", "scan.published_pair.resolve_failed", {
      ecosystem: request.ecosystem,
      error: describeOperationalError(err),
    });
    // The public-diff loaders already classify their own failures (unknown
    // package, oversized archive, registry unreachable) with a public-safe
    // message and status; anything else is ours and stays opaque.
    if (err instanceof PublicDiffError) {
      return { error: c.json({ error: err.message }, err.status) };
    }
    return { error: c.json({ error: "could not reach the registry for that package" }, 502) };
  }
  if (!resolved.ok) return { error: c.json({ error: resolved.error }, resolved.status) };

  const pair = resolved.pair;
  return {
    input: { stageId: publishedPairStageId(pair), published: pair },
    source: "published",
    ecosystem: pair.ecosystem,
    packageName: pair.packageName,
    version: pair.version,
    registryUrl: null,
  };
}

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
      publicShareIncludesFiles: scan.scan.publicShareIncludesFiles,
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
