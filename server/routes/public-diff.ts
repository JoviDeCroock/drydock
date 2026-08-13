import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { enforceRateLimit, RateLimitError } from "../db/rate-limit";
import { getPublicDiffAdapter } from "../lib/ecosystems";
import { PUBLIC_NPM_REGISTRY } from "../lib/ecosystems/npm/public-diff";
import { rateLimitResponse } from "../lib/platform/http";
import { workerExecutionContext } from "../lib/platform/execution-context";
import { recordProductEvent } from "../lib/platform/analytics";
import {
  computePublicDiffCacheKey,
  loadPublicPackageDiff,
  PublicDiffError,
  readPublicDiffCache,
  type PublicPackageDiff,
} from "../lib/public-diff";
import type { PublicDiffAdapter } from "../lib/public-diff/types";
import type { Bindings, Variables } from "../types";

// Anonymous by design: these endpoints serve only data derived from public
// registry artifacts and public pkg.pr.new preview tarballs (no organization
// resources, no credentials, no D1 persistence) and are the marketing-facing
// "diff any npm, PyPI, or atpm package" surface. Abuse control is per-IP rate limiting
// plus the KV cache for immutable version pairs; the sandbox's archive caps
// bound the work a request can ask for. Everything else under /api/* keeps
// requiring a Better Auth session.
export const publicDiffRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type PublicDiffContext = Context<{ Bindings: Bindings; Variables: Variables }>;

// A custom NPM_REGISTRY signals a private/self-hosted deployment, so the whole
// anonymous surface stays off there — including PyPI and atpm, which would
// otherwise still reach out to the public internet from a private install.
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

// The ecosystem registry is the authority on which ecosystems /diff serves: an
// ecosystem appears here exactly when its module declares a `publicDiff`
// capability, so adding one needs no change in this file.
function requestedEcosystem(c: PublicDiffContext): PublicDiffAdapter | Response {
  const ecosystem = c.req.query("ecosystem")?.trim() || "npm";
  const adapter = getPublicDiffAdapter(ecosystem);
  if (!adapter) {
    return c.json({ error: "invalid ecosystem" }, 400);
  }
  return adapter;
}

function requestedPackageName(c: PublicDiffContext, adapter: PublicDiffAdapter): string | Response {
  const packageName = c.req.query("package")?.trim() ?? "";
  if (!adapter.isValidPackageName(packageName)) {
    return c.json({ error: "invalid package name" }, 400);
  }
  // Canonicalize once at the request boundary so the cache key, cache-tag, and
  // payload identity all agree — on PyPI "Django" and "django" must share one
  // entry AND one purge tag.
  return adapter.normalizePackageName(packageName);
}

// What a version side may be is the ecosystem's call: npm accepts a published
// version or a pkg.pr.new preview URL, PyPI has no preview form but allows PEP
// 440 epoch markers ("1!2.0").
function requestedVersion(
  c: PublicDiffContext,
  adapter: PublicDiffAdapter,
  param: string,
): string | Response {
  const version = c.req.query(param)?.trim() ?? "";
  if (!adapter.isValidVersion(version)) {
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
  // `countView` is off for the `/file` route. Both routes funnel through here,
  // and `/file` is called once per file the visitor opens — counting it would
  // report one page view as thirty, and skew the cache column toward `hit`
  // because only the first request can miss.
  options: { limitColdComputation?: boolean; countView?: boolean } = {},
): Promise<{ payload: PublicPackageDiff } | { error: Response }> {
  const adapter = requestedEcosystem(c);
  if (adapter instanceof Response) return { error: adapter };
  const packageName = requestedPackageName(c, adapter);
  if (packageName instanceof Response) return { error: packageName };
  const fromVersion = requestedVersion(c, adapter, "from");
  if (fromVersion instanceof Response) return { error: fromVersion };
  const toVersion = requestedVersion(c, adapter, "to");
  if (toVersion instanceof Response) return { error: toVersion };
  if (fromVersion === toVersion) {
    return { error: c.json({ error: "from and to must differ" }, 400) };
  }

  const input = {
    ecosystem: adapter.ecosystem,
    packageName,
    fromVersion,
    toVersion,
    registryUrl: adapter.registryUrl,
  };

  const startedAtMs = Date.now();
  let cacheHit: boolean | null = null;
  try {
    if (options.limitColdComputation) {
      const cacheKey = await computePublicDiffCacheKey(input);
      const cached = await readPublicDiffCache(c.env, cacheKey);
      if (cached) {
        if (options.countView) recordPublicDiffView(c, cached, true, startedAtMs);
        return { payload: cached };
      }

      const limited = await enforcePublicRateLimit(c, "fetch", 10);
      if (limited) return { error: limited };
    }

    const payload = await loadPublicPackageDiff(
      c.env,
      workerExecutionContext(c.executionCtx),
      input,
      {
        onCacheOutcome: (hit) => {
          cacheHit = hit;
        },
      },
    );
    if (options.countView) recordPublicDiffView(c, payload, cacheHit, startedAtMs);
    return { payload };
  } catch (err) {
    return { error: publicDiffErrorResponse(c, err) };
  }
}

// The growth loop's only measurement. Anonymous by construction: the package
// name is already public in the request URL, the cache key, and the page's own
// Open Graph metadata, and nothing about the visitor is recorded — no IP, no
// user agent, no session, no cookie. See server/lib/platform/analytics.ts.
function recordPublicDiffView(
  c: PublicDiffContext,
  payload: PublicPackageDiff,
  cacheHit: boolean | null,
  startedAtMs: number,
): void {
  recordProductEvent(c.env, {
    name: "public_diff.viewed",
    ecosystem: payload.ecosystem,
    packageName: payload.packageName,
    cache: cacheHit === null ? "unknown" : cacheHit ? "hit" : "miss",
    risk: payload.risk?.artifactRisk ?? "unknown",
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });
}

publicDiffRoutes.get("/versions", async (c) => {
  const limited = await enforcePublicRateLimit(c, "versions", 30);
  if (limited) return limited;
  const adapter = requestedEcosystem(c);
  if (adapter instanceof Response) return adapter;
  const packageName = requestedPackageName(c, adapter);
  if (packageName instanceof Response) return packageName;

  let listing;
  try {
    listing = await adapter.listVersions(
      c.env,
      workerExecutionContext(c.executionCtx),
      packageName,
    );
  } catch (err) {
    return publicDiffErrorResponse(c, err);
  }

  return c.json(
    {
      ecosystem: adapter.ecosystem,
      packageName: listing.packageName,
      versions: listing.versions,
      suggested: listing.suggested,
    },
    200,
    {
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
      "cache-tag": adapter.cacheTag(packageName),
    },
  );
});

// Package bytes are immutable, but findings and risk change with the deployed
// analysis version. Revalidate response payloads at the origin; the versioned
// colo/KV result cache keeps that revalidation cheap.
function analyzedPairHeaders(ecosystem: string, packageName: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=0, must-revalidate",
    "cache-tag": publicDiffCacheTag(ecosystem, packageName),
  };
}

// Cache-tag shape is the ecosystem's own (npm keeps the historical un-prefixed
// tag so existing purge tooling works); fall back to a namespaced tag if a
// payload ever names an ecosystem the registry no longer serves.
function publicDiffCacheTag(ecosystem: string, packageName: string): string {
  return (
    getPublicDiffAdapter(ecosystem)?.cacheTag(packageName) ??
    `public-diff:${ecosystem}:${packageName}`
  );
}

publicDiffRoutes.get("/", async (c) => {
  const limited = await enforcePublicRateLimit(c, "fetch", 10);
  if (limited) return limited;
  // The version-pair route is the page view; `/file` below is not.
  const loaded = await loadRequestedDiff(c, { countView: true });
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
      provenance: payload.provenance ?? [],
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
