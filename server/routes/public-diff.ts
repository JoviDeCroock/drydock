import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { enforceRateLimit, RateLimitError } from "../db/rate-limit";
import { rateLimitResponse } from "../lib/http";
import {
  computePublicDiffCacheKey,
  fetchPublicPackageMetadata,
  loadPublicPackageDiff,
  PublicDiffError,
  readPublicDiffCache,
  type PublicPackageDiff,
} from "../lib/public-diff";
import { isPkgPrNewUrl } from "../../src/lib/pkg-pr-new";
import { compareSemver, isValidNpmPackageName } from "../lib/registry";
import type { Bindings, Variables } from "../types";

// Anonymous by design: these endpoints serve only data derived from public
// registry artifacts and public pkg.pr.new preview tarballs (no organization
// resources, no credentials, no D1 persistence) and are the marketing-facing
// "diff any npm package" surface.
// Abuse control is per-IP rate limiting plus the KV cache for immutable
// version pairs; the sandbox's archive caps bound the work a request can ask
// for. Everything else under /api/* keeps requiring a Better Auth session.
export const publicDiffRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

type PublicDiffContext = Context<{ Bindings: Bindings; Variables: Variables }>;

publicDiffRoutes.use("*", async (c, next) => {
  const configuredRegistry = (c.env.NPM_REGISTRY || PUBLIC_NPM_REGISTRY).replace(/\/+$/, "");
  if (configuredRegistry !== PUBLIC_NPM_REGISTRY) {
    return c.json({ error: "public package diff is disabled for custom registries" }, 404);
  }
  await next();
});

function clientIp(c: PublicDiffContext): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function enforcePublicRateLimit(
  c: PublicDiffContext,
  bucket: string,
  limit: number,
): Promise<Response | null> {
  try {
    await enforceRateLimit(createDb(c.env.DB), {
      key: `public-diff:${bucket}:${clientIp(c)}`,
      limit,
      windowMs: 60 * 1000,
    });
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "rate limit exceeded", err);
    }
    throw err;
  }
}

function requestedPackageName(c: PublicDiffContext): string | Response {
  const packageName = c.req.query("package")?.trim() ?? "";
  if (!isValidNpmPackageName(packageName)) {
    return c.json({ error: "invalid package name" }, 400);
  }
  return packageName;
}

// A version side is either a published registry version or a pkg.pr.new
// preview URL (validated and origin-pinned by the shared parser).
function requestedVersion(c: PublicDiffContext, param: string): string | Response {
  const version = c.req.query(param)?.trim() ?? "";
  if (!VERSION_RE.test(version) && !isPkgPrNewUrl(version)) {
    return c.json({ error: `invalid ${param} version` }, 400);
  }
  return version;
}

function publicDiffErrorResponse(c: PublicDiffContext, err: unknown): Response {
  if (err instanceof PublicDiffError) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}

async function loadRequestedDiff(
  c: PublicDiffContext,
  options: { limitColdComputation?: boolean } = {},
): Promise<{ payload: PublicPackageDiff } | { error: Response }> {
  const packageName = requestedPackageName(c);
  if (packageName instanceof Response) return { error: packageName };
  const fromVersion = requestedVersion(c, "from");
  if (fromVersion instanceof Response) return { error: fromVersion };
  const toVersion = requestedVersion(c, "to");
  if (toVersion instanceof Response) return { error: toVersion };
  if (fromVersion === toVersion) {
    return { error: c.json({ error: "from and to must differ" }, 400) };
  }

  const input = {
    packageName,
    fromVersion,
    toVersion,
    registryUrl: PUBLIC_NPM_REGISTRY,
  };

  try {
    if (options.limitColdComputation) {
      const cacheKey = await computePublicDiffCacheKey(input);
      const cached = await readPublicDiffCache(c.env, cacheKey);
      if (cached) return { payload: cached };

      const limited = await enforcePublicRateLimit(c, "fetch", 10);
      if (limited) return { error: limited };
    }

    const payload = await loadPublicPackageDiff(c.env, c.executionCtx, input);
    return { payload };
  } catch (err) {
    return { error: publicDiffErrorResponse(c, err) };
  }
}

publicDiffRoutes.get("/versions", async (c) => {
  const limited = await enforcePublicRateLimit(c, "versions", 30);
  if (limited) return limited;
  const packageName = requestedPackageName(c);
  if (packageName instanceof Response) return packageName;

  let metadata;
  try {
    metadata = await fetchPublicPackageMetadata(
      c.env,
      c.executionCtx,
      packageName,
      PUBLIC_NPM_REGISTRY,
    );
  } catch (err) {
    return publicDiffErrorResponse(c, err);
  }

  const tagsByVersion = new Map<string, string[]>();
  for (const [tag, version] of Object.entries(metadata["dist-tags"] ?? {})) {
    if (!version) continue;
    const list = tagsByVersion.get(version) ?? [];
    list.push(tag);
    tagsByVersion.set(version, list);
  }
  const times = metadata.time ?? {};
  const versions = Object.keys(metadata.versions ?? {})
    .sort((a, b) => compareSemver(b, a))
    .map((version) => ({
      version,
      distTags: (tagsByVersion.get(version) ?? []).sort(),
      publishedAt: typeof times[version] === "string" ? times[version] : undefined,
    }));

  const latest = metadata["dist-tags"]?.latest ?? versions[0]?.version ?? null;
  const previous = latest
    ? (versions.find(
        (entry) => entry.version !== latest && compareSemver(entry.version, latest) < 0,
      )?.version ?? null)
    : null;

  return c.json(
    {
      packageName,
      versions,
      suggested: latest && previous ? { from: previous, to: latest } : null,
    },
    200,
    {
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
      "cache-tag": publicDiffCacheTag(packageName),
    },
  );
});

// Package bytes are immutable, but findings and risk change with the deployed
// analysis version. Revalidate response payloads at the origin; the versioned
// colo/KV result cache keeps that revalidation cheap.
function analyzedPairHeaders(packageName: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=0, must-revalidate",
    "cache-tag": publicDiffCacheTag(packageName),
  };
}

function publicDiffCacheTag(packageName: string): string {
  return `public-diff:${packageName}`;
}

publicDiffRoutes.get("/", async (c) => {
  const limited = await enforcePublicRateLimit(c, "fetch", 10);
  if (limited) return limited;
  const loaded = await loadRequestedDiff(c);
  if ("error" in loaded) return loaded.error;
  const { payload } = loaded;

  return c.json(
    {
      packageName: payload.packageName,
      fromVersion: payload.fromVersion,
      toVersion: payload.toVersion,
      fromPackageJson: payload.fromPackageJson,
      toPackageJson: payload.toPackageJson,
      diff: payload.diff,
      packageJsonDiff: payload.packageJsonDiff,
      findings: payload.findings,
      risk: payload.risk,
      textSamplesOmitted: payload.textSamplesOmitted ?? false,
      cachedAt: payload.cachedAt,
    },
    200,
    analyzedPairHeaders(payload.packageName),
  );
});

publicDiffRoutes.get("/file", async (c) => {
  const limited = await enforcePublicRateLimit(c, "file", 120);
  if (limited) return limited;
  const path = c.req.query("path") ?? "";
  if (!path) return c.json({ error: "path is required" }, 400);

  const loaded = await loadRequestedDiff(c, { limitColdComputation: true });
  if ("error" in loaded) return loaded.error;
  const { payload } = loaded;

  const before = payload.fromFiles.find((file) => file.path === path) ?? null;
  const after = payload.toFiles.find((file) => file.path === path) ?? null;
  if (!before && !after) return c.json({ error: "file not found in either version" }, 404);

  return c.json(
    {
      path,
      before,
      after,
      textSamplesOmitted: payload.textSamplesOmitted ?? false,
    },
    200,
    analyzedPairHeaders(payload.packageName),
  );
});
