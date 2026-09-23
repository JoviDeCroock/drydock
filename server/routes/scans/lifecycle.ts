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
  getScan,
  getScanFile,
  getScanStatus,
  listScans,
} from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { deleteScanArtifacts, scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { canonicalOrigin, parseLimitQuery, readJsonObject } from "../../lib/platform/http";
import { allowInsecureLocalRegistry, decryptNpmToken } from "../../lib/ecosystems/npm/connection";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
} from "../../lib/ecosystems/npm/staged-publishes";
import { getPublicationMonitor } from "../../lib/ecosystems";
import { parseScanInput } from "../../lib/scan/input";
import { encodeListScansCursor, parseListScansCursor } from "../../lib/scan/list-cursor";
import {
  createPreparedScan,
  enqueuePreparedScan,
  preparePublishedScan,
  type PreparedScan,
} from "../../lib/scan/start";
import type { Bindings, ScanInput, Variables } from "../../types";

export const scanLifecycleRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanLifecycleRoutes.post("/", async (c) => {
  const body = await readJsonObject<ScanInput>(c);
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const db = c.var.db;
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const limited = await guardRateLimit(
    c,
    {
      key: `scan:${organizationId}`,
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
    ownerUserId: session.userId,
    prepared,
  });
  if (!detail) return c.json({ error: "failed to create scan" }, 500);
  await enqueuePreparedScan(c, db, {
    scanId,
    organizationId,
    actorUserId: session.userId,
    prepared,
  });

  return c.json({ scan: detail?.scan, queued: Boolean(c.env.SCAN_QUEUE) }, 202);
});

type ScanRouteContext = import("hono").Context<{ Bindings: Bindings; Variables: Variables }>;

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

  // Best-effort: staged metadata gives the scan a package label up front, so
  // a scan whose tarball never parses still shows which package it was for.
  const staged = await fetchStagedPublishDetails(npmConnection.registryUrl, token, input.stageId, {
    allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
  }).catch(() => null);

  if (staged) {
    await getPublicationMonitor("npm")?.registerStagedReleases(db, c.env, {
      organizationId,
      registryUrl: npmConnection.registryUrl,
      releases: [staged],
    });
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
    },
  });
});

scanLifecycleRoutes.get("/:id/status", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanStatus(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({ scan });
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
