import { Hono } from "hono";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  SCAN_DECISIONS,
  SCAN_DECISION_FILTERS,
  type ScanDecision,
  type ScanDecisionFilter,
  createDb,
  createScanJob,
  getScan,
  listScans,
  recordScanDecision,
  recordScanEvent,
} from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { loadCompare, stripTextSamples } from "../lib/compare-cache";
import { withRateLimit } from "../lib/http";
import {
  NpmConnectionError,
  allowInsecureLocalRegistry,
  getOrganizationNpmToken,
  requireValidNpmConnection,
} from "../lib/npm-connection";
import { isPublishedTarballUrlAllowed } from "../lib/published-tarball";
import { compareSemver, fetchPackageMetadata, pickPreviousVersion } from "../lib/registry";
import { annotateFindingsWithDiffStatus, createPackageDiff, type FileRecord } from "../lib/review";
import { describeOperationalError, emitOperationalEvent } from "../lib/observability";
import { parseScanInput } from "../lib/scan-input";
import { executeScanJob, type ScanQueueMessage } from "../lib/scan-job";
import type { Bindings, ScanInput, Variables } from "../types";

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scansRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { input } = parsed;

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const limited = await withRateLimit(
    c,
    db,
    { key: `scan:${organizationId}`, limit: 10, windowMs: 60 * 60 * 1000 },
    "scan rate limit exceeded",
  );
  if (limited) return limited;

  try {
    await requireValidNpmConnection(db, organizationId);
  } catch (err) {
    if (err instanceof NpmConnectionError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  const scanId = crypto.randomUUID();
  const detail = await createScanJob(db, {
    id: scanId,
    stageId: input.stageId,
    organizationId,
    ownerUserId: session.userId,
  });
  if (!detail) return c.json({ error: "failed to create scan" }, 500);
  const message: ScanQueueMessage = {
    ...input,
    scanId,
    organizationId,
    actorUserId: session.userId,
  };

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId,
    type: c.env.SCAN_QUEUE ? "scan.queued" : "scan.backgrounded",
    metadata: { stageId: input.stageId },
  });

  if (c.env.SCAN_QUEUE) {
    await c.env.SCAN_QUEUE.send(message);
  } else {
    c.executionCtx.waitUntil(
      executeScanJob(c.env, c.executionCtx, message, db, { finalAttempt: true }),
    );
  }

  return c.json({ scan: detail?.scan, queued: Boolean(c.env.SCAN_QUEUE) }, 202);
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

scansRoutes.post("/:id/decision", async (c) => {
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

  const updated = await recordScanDecision(db, {
    scanId: c.req.param("id"),
    organizationId,
    actorUserId: session.userId,
    decision: body.decision as ScanDecision,
    reason,
  });

  if (!updated) {
    const existing = await getScan(db, c.req.param("id"), organizationId);
    if (!existing) return c.json({ error: "not found" }, 404);
    return c.json({ error: "decision can only be set on completed scans" }, 409);
  }

  return c.json(updated);
});

scansRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScan(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  if (c.req.query("poll") !== "1") {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      scanId: scan.scan.id,
      type: "scan.viewed",
      metadata: { stageId: scan.scan.stageId },
    });
  }
  return c.json(scan);
});

scansRoutes.get("/:id/versions", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScan(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  if (!scan.scan.packageName) {
    return c.json({
      packageName: null,
      stagedVersion: scan.scan.stagedVersion ?? null,
      defaultPreviousVersion: scan.scan.previousVersion ?? null,
      versions: [],
    });
  }

  const [limited, connection] = await Promise.all([
    withRateLimit(
      c,
      db,
      { key: `compare-versions:${session.userId}`, limit: 60, windowMs: 60 * 1000 },
      "rate limit exceeded",
    ),
    getOrganizationNpmToken(db, c.env, organizationId).catch((err) => {
      emitOperationalEvent("warn", "npm_connection.token_retrieval_failed", {
        organizationId,
        error: describeOperationalError(err),
      });
      return null;
    }),
  ]);
  if (limited) return limited;

  const metadata = await fetchPackageMetadata(c.env, scan.scan.packageName, {
    npmToken: connection?.token,
    npmRegistry: connection?.registryUrl,
  }).catch((err) => {
    emitOperationalEvent("warn", "registry.metadata_fetch_failed", {
      packageName: scan.scan.packageName,
      error: describeOperationalError(err),
    });
    return null;
  });
  if (!metadata) {
    return c.json({
      packageName: scan.scan.packageName,
      stagedVersion: scan.scan.stagedVersion ?? null,
      defaultPreviousVersion: scan.scan.previousVersion ?? null,
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
  const stagedVersion = scan.scan.stagedVersion ?? null;
  const versions = Object.keys(metadata.versions ?? {})
    .filter((version) => version !== stagedVersion)
    .sort((a, b) => compareSemver(b, a))
    .map((version) => ({
      version,
      distTags: (tagsByVersion.get(version) ?? []).sort(),
      publishedAt: typeof times[version] === "string" ? times[version] : undefined,
    }));

  return c.json({
    packageName: scan.scan.packageName,
    stagedVersion,
    defaultPreviousVersion:
      scan.scan.previousVersion ??
      (stagedVersion ? pickPreviousVersion(metadata, stagedVersion) : null),
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
  const scan = await getScan(db, scanId, organizationId);
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
  const [limited, connection] = await Promise.all([
    withRateLimit(
      c,
      ctx.db,
      { key: options.rateLimitKey, limit: options.rateLimit, windowMs: 60 * 1000 },
      "rate limit exceeded",
    ),
    getOrganizationNpmToken(ctx.db, c.env, ctx.organizationId).catch((err) => {
      emitOperationalEvent("warn", "npm_connection.token_retrieval_failed", {
        organizationId: ctx.organizationId,
        error: describeOperationalError(err),
      });
      return null;
    }),
  ]);
  if (limited) return { error: limited } as const;

  const metadata = await fetchPackageMetadata(c.env, ctx.packageName, {
    npmToken: connection?.token,
    npmRegistry: connection?.registryUrl,
  }).catch((err) => {
    emitOperationalEvent("warn", "registry.metadata_fetch_failed", {
      packageName: ctx.packageName,
      error: describeOperationalError(err),
    });
    return null;
  });
  const tarballUrl = metadata?.versions?.[ctx.version]?.dist?.tarball;
  if (!tarballUrl) return { error: c.json({ error: "unknown version" }, 404) } as const;

  const registryUrl = connection?.registryUrl || c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  const allowInsecureLocalhost = allowInsecureLocalRegistry(c.env);
  if (!isPublishedTarballUrlAllowed(tarballUrl, registryUrl, allowInsecureLocalhost)) {
    return {
      error: c.json({ error: "registry returned an unexpected tarball URL" }, 502),
    } as const;
  }

  const cached = await loadCompare(c.env, c.executionCtx, ctx.version, {
    tarballUrl,
    registryUrl,
    npmToken: connection?.token,
    cacheScope: `org:${ctx.organizationId}`,
    allowInsecureLocalhost,
  });

  return { cached } as const;
}

function buildCompareFindingAnnotations(
  scan: NonNullable<Awaited<ReturnType<typeof getScan>>>,
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
