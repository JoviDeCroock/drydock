/**
 * Version comparison for a scanned package.
 *
 * Lists the versions a scan can be diffed against and builds the diff itself.
 * The archive fetch here is the one path in this file that reaches a registry,
 * so it goes through the sandbox and the org's own npm credentials.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { RateLimitError, enforceRateLimit } from "../../lib/platform/rate-limit";
import { getScanCompareData, getScanStatus } from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { scanArtifactReadBucket } from "../../lib/scan/artifacts";
import { loadCompare, stripTextSamples } from "../../lib/compare-cache";
import { rateLimitResponse } from "../../lib/platform/http";
import { workerExecutionContext } from "../../lib/platform/execution-context";
import {
  allowInsecureLocalRegistry,
  getOrganizationNpmToken,
} from "../../lib/ecosystems/npm/connection";
import { isPublishedTarballUrlAllowed } from "../../lib/ecosystems/npm/published-tarball";
import { compareSemver, pickPreviousVersion } from "../../lib/ecosystems/npm/registry";
import { fetchPackageMetadataCached } from "../../lib/ecosystems/npm/registry-cache";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  type FileRecord,
} from "../../lib/review";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import type { Bindings, Variables } from "../../types";

export const scanCompareRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanCompareRoutes.get("/:id/versions", async (c) => {
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
      enforceRateLimit(c.env, {
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
  // Full packument: this response renders per-version publish dates, which
  // only the full document carries.
  const metadata = await fetchPackageMetadataCached(c.env, workerExecutionContext(c.executionCtx), {
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

scanCompareRoutes.get("/:id/compare", async (c) => {
  const ctx = await resolveCompareContext(c);
  if ("error" in ctx) return ctx.error;

  const loaded = await loadCompareArchive(c, ctx, {
    rateLimitKey: `compare-fetch:${ctx.session.userId}`,
    rateLimit: 30,
    requireCompleteFiles: true,
  });
  if ("error" in loaded) return loaded.error;

  return c.json(
    {
      version: loaded.cached.version,
      files: stripTextSamples(loaded.cached.files),
      packageJson: loaded.cached.packageJson,
      findingAnnotations: buildCompareFindingAnnotations(ctx.scan, loaded.comparisonFiles),
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
  options: { rateLimitKey: string; rateLimit: number; requireCompleteFiles?: boolean },
) {
  let connection: Awaited<ReturnType<typeof getOrganizationNpmToken>> = null;
  try {
    [, connection] = await Promise.all([
      enforceRateLimit(c.env, {
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
  const metadata = await fetchPackageMetadataCached(c.env, workerExecutionContext(c.executionCtx), {
    packageName: ctx.packageName,
    registryUrl,
    cacheScope: `org:${ctx.organizationId}`,
    npmToken: connection?.token,
    // Only the selected version's tarball URL is read here.
    abbreviated: true,
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

  const loaded = await loadCompare(c.env, workerExecutionContext(c.executionCtx), ctx.version, {
    tarballUrl,
    registryUrl,
    npmToken: connection?.token,
    cacheScope: `org:${ctx.organizationId}`,
    allowInsecureLocalhost,
    requireCompleteFiles: options.requireCompleteFiles,
  });

  return loaded;
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

scanCompareRoutes.get("/:id/compare/file", async (c) => {
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
