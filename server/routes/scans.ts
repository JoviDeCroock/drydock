import { Hono } from "hono";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  RateLimitError,
  SCAN_DECISIONS,
  SCAN_DECISION_FILTERS,
  type ScanDecision,
  type ScanDecisionFilter,
  createDb,
  createScanJob,
  enforceRateLimit,
  getNpmConnection,
  getScan,
  listScans,
  recordScanDecision,
  recordScanEvent,
} from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { loadCompare, stripTextSamples } from "../lib/compare-cache";
import {
  allowInsecureLocalRegistry,
  getOrganizationNpmToken,
  registryProtocolAllowed,
} from "../lib/npm-connection";
import { compareSemver, fetchPackageMetadata, pickPreviousVersion } from "../lib/registry";
import { annotateFindingsWithDiffStatus, createPackageDiff, type FileRecord } from "../lib/review";
import { executeScanJob, type ScanQueueMessage } from "../lib/scan-job";
import type { Bindings, ScanInput, Variables } from "../types";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scansRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  if (body.maxFiles !== undefined || body.maxBytesPerFile !== undefined) {
    return c.json({ error: "scan limits are controlled by the server" }, 400);
  }
  const input: ScanInput = {
    stageId: String(body.stageId || ""),
  };
  if (!STAGE_ID_RE.test(input.stageId)) return c.json({ error: "invalid stageId" }, 400);

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
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "scan rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
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

  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(db, {
        key: `compare-versions:${session.userId}`,
        limit: 60,
        windowMs: 60 * 1000,
      }),
      getOrganizationNpmToken(db, c.env, organizationId).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const metadata = await fetchPackageMetadata(c.env, scan.scan.packageName, {
    npmToken: connection?.token,
    npmRegistry: connection?.registryUrl,
  }).catch(() => null);
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

function isTarballUrlAllowed(
  tarballUrl: string,
  registryUrl: string,
  allowInsecureLocalhost: boolean,
): boolean {
  try {
    const tarball = new URL(tarballUrl);
    const registry = new URL(registryUrl);
    return (
      tarball.origin === registry.origin &&
      registryProtocolAllowed(tarball, { allowInsecureLocalhost }) &&
      tarball.pathname.endsWith(".tgz") &&
      tarball.pathname.includes("/-/")
    );
  } catch {
    return false;
  }
}

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
  const { version, db, session, packageName } = ctx;

  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(db, {
        key: `compare-fetch:${session.userId}`,
        limit: 30,
        windowMs: 60 * 1000,
      }),
      getOrganizationNpmToken(db, c.env, ctx.organizationId).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const metadata = await fetchPackageMetadata(c.env, packageName, {
    npmToken: connection?.token,
    npmRegistry: connection?.registryUrl,
  }).catch(() => null);
  const tarballUrl = metadata?.versions?.[version]?.dist?.tarball;
  if (!tarballUrl) return c.json({ error: "unknown version" }, 404);

  const registryUrl = connection?.registryUrl || c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  if (!isTarballUrlAllowed(tarballUrl, registryUrl, allowInsecureLocalRegistry(c.env))) {
    return c.json({ error: "registry returned an unexpected tarball URL" }, 502);
  }

  const cached = await loadCompare(c.env, c.executionCtx, version, {
    tarballUrl,
    registryUrl,
    npmToken: connection?.token,
    cacheScope: `org:${ctx.organizationId}`,
  });

  return c.json(
    {
      version: cached.version,
      files: stripTextSamples(cached.files),
      packageJson: cached.packageJson,
      findingAnnotations: buildCompareFindingAnnotations(ctx.scan, cached.files),
      cachedAt: cached.cachedAt,
    },
    200,
    { "cache-control": "private, max-age=300" },
  );
});

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
  const { version, db, session, packageName } = ctx;
  const path = c.req.query("path") || "";
  if (!path) return c.json({ error: "path is required" }, 400);

  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(db, {
        key: `compare-file:${session.userId}`,
        limit: 240,
        windowMs: 60 * 1000,
      }),
      getOrganizationNpmToken(db, c.env, ctx.organizationId).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const metadata = await fetchPackageMetadata(c.env, packageName, {
    npmToken: connection?.token,
    npmRegistry: connection?.registryUrl,
  }).catch(() => null);
  const tarballUrl = metadata?.versions?.[version]?.dist?.tarball;
  if (!tarballUrl) return c.json({ error: "unknown version" }, 404);

  const registryUrl = connection?.registryUrl || c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  if (!isTarballUrlAllowed(tarballUrl, registryUrl, allowInsecureLocalRegistry(c.env))) {
    return c.json({ error: "registry returned an unexpected tarball URL" }, 502);
  }

  const cached = await loadCompare(c.env, c.executionCtx, version, {
    tarballUrl,
    registryUrl,
    npmToken: connection?.token,
    cacheScope: `org:${ctx.organizationId}`,
  });

  const file = cached.files.find((entry) => entry.path === path);
  if (!file) return c.json({ error: "file not found in version" }, 404);

  return c.json({ version: cached.version, file }, 200, {
    "cache-control": "private, max-age=300",
  });
});
