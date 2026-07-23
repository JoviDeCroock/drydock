import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { enforceRateLimit, RateLimitError } from "../db/rate-limit";
import { isValidPyPiProjectName, normalizePyPiProjectName } from "../lib/adapters/pypi/manifest";
import { SAFE_VERSION_RE } from "../lib/adapters/pypi/types";
import { rateLimitResponse } from "../lib/http";
import {
  computePublicDiffCacheKey,
  fetchPublicPackageMetadata,
  loadPublicPackageDiff,
  PublicDiffError,
  readPublicDiffCache,
  type PublicDiffEcosystem,
  type PublicPackageDiff,
} from "../lib/public-diff";
import { isPkgPrNewUrl } from "../../src/lib/pkg-pr-new";
import {
  fetchPublicPyPiProjectMetadata,
  listPublicPyPiVersions,
  PYPI_PUBLIC_REGISTRY,
} from "../lib/public-diff-pypi";
import { compareSemver, isValidNpmPackageName } from "../lib/registry";
import type { Bindings, Variables } from "../types";

// Anonymous by design: these endpoints serve only data derived from public
// registry artifacts and public pkg.pr.new preview tarballs (no organization
// resources, no credentials, no D1 persistence) and are the marketing-facing
// "diff any npm or PyPI package" surface. Abuse control is per-IP rate limiting
// plus the KV cache for immutable version pairs; the sandbox's archive caps
// bound the work a request can ask for. Everything else under /api/* keeps
// requiring a Better Auth session.
export const publicDiffRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const NPM_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

type PublicDiffContext = Context<{ Bindings: Bindings; Variables: Variables }>;

// A custom NPM_REGISTRY signals a private/self-hosted deployment, so the whole
// anonymous surface stays off there — including PyPI, which would otherwise
// still reach out to the public internet from a private install.
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

function requestedEcosystem(c: PublicDiffContext): PublicDiffEcosystem | Response {
  const ecosystem = c.req.query("ecosystem")?.trim() || "npm";
  if (ecosystem !== "npm" && ecosystem !== "pypi") {
    return c.json({ error: "invalid ecosystem" }, 400);
  }
  return ecosystem;
}

function requestedPackageName(
  c: PublicDiffContext,
  ecosystem: PublicDiffEcosystem,
): string | Response {
  const packageName = c.req.query("package")?.trim() ?? "";
  const valid =
    ecosystem === "pypi" ? isValidPyPiProjectName(packageName) : isValidNpmPackageName(packageName);
  if (!valid) {
    return c.json({ error: "invalid package name" }, 400);
  }
  // PyPI names are case/separator-insensitive (PEP 503); canonicalize once at
  // the request boundary so the cache key, cache-tag, and payload identity
  // all agree — "Django" and "django" must share one entry AND one purge tag.
  return ecosystem === "pypi" ? normalizePyPiProjectName(packageName) : packageName;
}

// An npm version side is either a published registry version or a pkg.pr.new
// preview URL (validated and origin-pinned by the shared parser). PyPI has no
// preview form, and its versions additionally allow PEP 440 epoch markers
// ("1!2.0").
function requestedVersion(
  c: PublicDiffContext,
  ecosystem: PublicDiffEcosystem,
  param: string,
): string | Response {
  const version = c.req.query(param)?.trim() ?? "";
  const versionRe = ecosystem === "pypi" ? SAFE_VERSION_RE : NPM_VERSION_RE;
  if (!versionRe.test(version) && !(ecosystem === "npm" && isPkgPrNewUrl(version))) {
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

function publicRegistryUrl(ecosystem: PublicDiffEcosystem): string {
  return ecosystem === "pypi" ? PYPI_PUBLIC_REGISTRY : PUBLIC_NPM_REGISTRY;
}

async function loadRequestedDiff(
  c: PublicDiffContext,
  options: { limitColdComputation?: boolean } = {},
): Promise<{ payload: PublicPackageDiff } | { error: Response }> {
  const ecosystem = requestedEcosystem(c);
  if (ecosystem instanceof Response) return { error: ecosystem };
  const packageName = requestedPackageName(c, ecosystem);
  if (packageName instanceof Response) return { error: packageName };
  const fromVersion = requestedVersion(c, ecosystem, "from");
  if (fromVersion instanceof Response) return { error: fromVersion };
  const toVersion = requestedVersion(c, ecosystem, "to");
  if (toVersion instanceof Response) return { error: toVersion };
  if (fromVersion === toVersion) {
    return { error: c.json({ error: "from and to must differ" }, 400) };
  }

  const input = {
    ecosystem,
    packageName,
    fromVersion,
    toVersion,
    registryUrl: publicRegistryUrl(ecosystem),
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
  const ecosystem = requestedEcosystem(c);
  if (ecosystem instanceof Response) return ecosystem;
  const packageName = requestedPackageName(c, ecosystem);
  if (packageName instanceof Response) return packageName;

  if (ecosystem === "pypi") {
    let metadata;
    try {
      metadata = await fetchPublicPyPiProjectMetadata(c.env, c.executionCtx, packageName);
    } catch (err) {
      return publicDiffErrorResponse(c, err);
    }
    const { versions, suggested } = listPublicPyPiVersions(metadata);
    return c.json(
      {
        ecosystem,
        packageName: metadata.info?.name ?? packageName,
        versions,
        suggested,
      },
      200,
      {
        "cache-control": "public, max-age=300, stale-while-revalidate=600",
        "cache-tag": publicDiffCacheTag(ecosystem, packageName),
      },
    );
  }

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
      ecosystem,
      packageName,
      versions,
      suggested: latest && previous ? { from: previous, to: latest } : null,
    },
    200,
    {
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
      "cache-tag": publicDiffCacheTag(ecosystem, packageName),
    },
  );
});

// Package bytes are immutable, but findings and risk change with the deployed
// analysis version. Revalidate response payloads at the origin; the versioned
// colo/KV result cache keeps that revalidation cheap.
function analyzedPairHeaders(
  ecosystem: PublicDiffEcosystem,
  packageName: string,
): Record<string, string> {
  return {
    "cache-control": "public, max-age=0, must-revalidate",
    "cache-tag": publicDiffCacheTag(ecosystem, packageName),
  };
}

function publicDiffCacheTag(ecosystem: PublicDiffEcosystem, packageName: string): string {
  // npm keeps the historical un-prefixed tag so existing purge tooling works.
  return ecosystem === "pypi" ? `public-diff:pypi:${packageName}` : `public-diff:${packageName}`;
}

publicDiffRoutes.get("/", async (c) => {
  const limited = await enforcePublicRateLimit(c, "fetch", 10);
  if (limited) return limited;
  const loaded = await loadRequestedDiff(c);
  if ("error" in loaded) return loaded.error;
  const { payload } = loaded;

  return c.json(
    {
      ecosystem: payload.ecosystem,
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
      notices: payload.notices ?? [],
      cachedAt: payload.cachedAt,
    },
    200,
    analyzedPairHeaders(payload.ecosystem, payload.packageName),
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
    analyzedPairHeaders(payload.ecosystem, payload.packageName),
  );
});
