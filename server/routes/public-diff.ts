import { Hono, type Context } from "hono";
import { enforceRateLimit, RateLimitError } from "../lib/platform/rate-limit";
import { getPublicDiffAdapter } from "../lib/ecosystems";
import { PUBLIC_NPM_REGISTRY } from "../lib/ecosystems/npm/public-diff";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import { workerExecutionContext } from "../lib/platform/execution-context";
import { resolveAtpmStagedReview } from "../lib/ecosystems/atpm/staged-review";
import { recordProductEvent } from "../lib/platform/analytics";
import {
  computePublicDiffCacheKey,
  loadPublicPackageDiff,
  PublicDiffError,
  readPublicDiffCache,
  remainingCacheTtlSeconds,
  type PublicPackageDiff,
} from "../lib/public-diff";
import type { PublicDiffAdapter } from "../lib/public-diff/types";
import type { Bindings, Variables } from "../types";

// Anonymous by design: these endpoints serve only data derived from public
// release artifacts and public pkg.pr.new preview tarballs (no organization
// resources, no credentials, no D1 persistence) and are the marketing-facing
// "diff any npm, PyPI, or atpm package" surface. Abuse control is per-IP rate limiting
// plus the KV cache for immutable version pairs; the sandbox's archive caps
// bound the work a request can ask for. Everything else under /api/* keeps
// requiring a Better Auth session.
export const publicDiffRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type PublicDiffContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const VERSION_LIST_CACHE_TTL_SECONDS = 5 * 60;
const VERSION_LIST_STALE_TTL_SECONDS = 10 * 60;

export function publicDiffVersionCacheControl(
  adapter: PublicDiffAdapter,
  cacheExpiresAt?: string,
): string {
  const maximum = Math.min(
    VERSION_LIST_CACHE_TTL_SECONDS,
    adapter.cacheTtlSeconds ?? VERSION_LIST_CACHE_TTL_SECONDS,
  );
  const maxAge = remainingCacheTtlSeconds(cacheExpiresAt, maximum);
  // Mutable identity metadata must stop being served when its adapter-defined
  // lifetime ends. Registry listings keep the existing stale revalidation
  // window because their package identity does not move between publishers.
  return adapter.cacheTtlSeconds !== undefined
    ? `public, max-age=${maxAge}`
    : `public, max-age=${maxAge}, stale-while-revalidate=${VERSION_LIST_STALE_TTL_SECONDS}`;
}

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
    await enforceRateLimit(c.env, {
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
        await adapter.validateCachedPair?.(c.env, workerExecutionContext(c.executionCtx), input);
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

/**
 * Resolve a staged atpm candidate to its review URL.
 *
 * This is the link atpm's own staged dashboard points at, and the contract is
 * that atpm can build it from what it already has in hand — the publishing
 * account and the record key — without asking Drydock anything first. Everything
 * that needs a lookup happens here: which package the candidate belongs to,
 * which published release it should be read against, and which revision of the
 * record is current.
 *
 * Anonymous, like the diff it redirects to. A staged candidate is a public
 * record in the publisher's own repository, so requiring an account to look at a
 * review of it would be asking people to sign in to read something they can
 * already `curl` — and it would put a login between a maintainer and the
 * decision this page exists to inform.
 *
 * A redirect rather than a page: the destination is the ordinary diff URL, so a
 * reviewer who shares what they are looking at shares something stable and
 * self-describing, and the review itself stays one surface rather than two.
 */
publicDiffRoutes.get("/atpm-stage", async (c) => {
  const limited = await enforcePublicRateLimit(c, "stage-link", 30);
  if (limited) return limited;

  const publisher = c.req.query("publisher")?.trim() ?? "";
  const rkey = c.req.query("rkey")?.trim() ?? "";
  if (!publisher || !rkey) {
    return c.json({ error: "publisher and rkey are required" }, 400);
  }

  const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;
  c.header("Vary", "Accept");
  try {
    const resolved = await resolveAtpmStagedReview(c.env, workerExecutionContext(c.executionCtx), {
      publisher,
      rkey,
    });
    if (wantsHtml) {
      // Temporary candidates are mutable and short-lived. A permanent redirect
      // would let a browser retain a stale record revision after it is replaced.
      return c.redirect(new URL(resolved.reviewPath, canonicalOrigin(c)).toString(), 302);
    }
    return c.json(resolved);
  } catch (err) {
    if (wantsHtml) {
      const status = err instanceof PublicDiffError ? err.status : 502;
      const message =
        err instanceof PublicDiffError ? err.message : "could not read that staged release";
      const candidateGone =
        err instanceof PublicDiffError &&
        err.status === 404 &&
        err.message === "staged release not found";
      return c.html(stagePlaceholder(message, candidateGone), status === 404 ? 404 : 502);
    }
    return publicDiffErrorResponse(c, err);
  }
});

function stagePlaceholder(message: string, candidateGone: boolean): string {
  const headline = candidateGone
    ? "That staged release is no longer waiting"
    : "Could not read that release";
  const detail = candidateGone
    ? "atpm removes a staged record once it is approved or withdrawn, so this link stops resolving as soon as the release is published. If it was published, the release itself can still be diffed."
    : escapeHtml(message);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(headline)} · Drydock</title><meta name="robots" content="noindex"></head>
<body><main><h1>${escapeHtml(headline)}</h1><p>${detail}</p>
<p><a href="/diff">Diff a published release</a></p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
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
      displayName: listing.displayName ?? null,
      versions: listing.versions,
      suggested: listing.suggested,
    },
    200,
    {
      "cache-control": publicDiffVersionCacheControl(adapter, listing.cacheExpiresAt),
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
      attestation: payload.attestation ?? null,
      displayName: payload.displayName ?? null,
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
