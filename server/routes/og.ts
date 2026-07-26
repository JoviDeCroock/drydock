import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { enforceRateLimit, RateLimitError } from "../db/rate-limit";
import { getPublicDiffAdapter } from "../lib/ecosystems";
import { PUBLIC_NPM_REGISTRY } from "../lib/ecosystems/npm/public-diff";
import { coloCache } from "../lib/platform/http";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import {
  renderOgCardSvg,
  type OgCardStats,
  type OgRiskLevel,
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
} from "../lib/public-diff/card";
import { renderSvgToPng } from "../lib/public-diff/card-render";
import {
  computePublicDiffCacheKey,
  readPublicDiffCache,
  type PublicPackageDiff,
} from "../lib/public-diff";
import type { PublicDiffAdapter } from "../lib/public-diff/types";
import {
  packageDiffCardPath,
  parsePackageDiffCardPath,
  type DiffEcosystem,
} from "../../src/lib/package-diff-path";
import { diffRefLabel } from "../../src/lib/pkg-pr-new";
import type { Bindings, Variables } from "../types";

// Share-card renderer for the anonymous public diff. Social clients unfurl one
// image per URL, and a single site-wide card makes every shared diff look
// identical in a timeline; this route names the package and the version pair on
// the card itself.
//
// Deliberately read-only with respect to analysis: it serves numbers only when
// the diff is already in the public-diff cache and never triggers a cold
// computation. Rendering is CPU work reachable without a session, so an
// unauthenticated request must never be able to make us download and parse a
// tarball.
export const ogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type OgContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const STATIC_FALLBACK_PATH = "/og-image.png";
// Findings and risk move with the deployed ruleset, so cards are refreshable
// rather than immutable. The edge holds them long enough that a post going
// around does not re-render per crawler.
const CARD_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
const FALLBACK_CACHE_CONTROL = "public, max-age=60";

// Same killswitch as the diff API: a custom NPM_REGISTRY signals a private
// deployment, which has no business rendering cards for public packages.
ogRoutes.use("*", async (c, next) => {
  const configuredRegistry = (c.env.NPM_REGISTRY || PUBLIC_NPM_REGISTRY).replace(/\/+$/, "");
  if (configuredRegistry !== PUBLIC_NPM_REGISTRY) return c.notFound();
  await next();
});

interface CardSpec {
  // Both: the adapter owns validation, registry, and cache identity; the parsed
  // path's own ecosystem is what the shared URL builder and the card label take.
  ecosystem: DiffEcosystem;
  adapter: PublicDiffAdapter;
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

// The path shape is shared with the diff page (see packageDiffCardPath), so a
// scoped name or a pkg.pr.new ref can never be encoded one way in the page's
// og:image and another way here. Validation is the ecosystem adapter's call,
// exactly as it is for the JSON API.
function parseCardSpec(pathname: string): CardSpec | null {
  const spec = parsePackageDiffCardPath(pathname);
  if (!spec) return null;
  const adapter = getPublicDiffAdapter(spec.ecosystem);
  if (!adapter) return null;
  const { fromVersion, toVersion } = spec;
  if (!adapter.isValidPackageName(spec.packageName)) return null;
  if (!adapter.isValidVersion(fromVersion)) return null;
  if (!adapter.isValidVersion(toVersion)) return null;
  if (fromVersion === toVersion) return null;

  return {
    ecosystem: spec.ecosystem,
    adapter,
    packageName: adapter.normalizePackageName(spec.packageName),
    fromVersion,
    toVersion,
  };
}

// The colo cache is keyed by URL, so a trailing query string or a non-canonical
// PyPI spelling would fragment it into separate entries for the same card.
// Rebuild the canonical path from the parsed spec instead of caching on the
// request's own URL.
function cardCacheKey(requestUrl: string, spec: CardSpec): Request {
  const path = packageDiffCardPath(
    spec.ecosystem,
    spec.packageName,
    spec.fromVersion,
    spec.toVersion,
  );
  return new Request(new URL(path, requestUrl), { method: "GET" });
}

function highestSeverityRisk(payload: PublicPackageDiff): OgRiskLevel {
  const risk = payload.risk.releaseRisk;
  return risk === "critical" || risk === "high" || risk === "medium" ? risk : "low";
}

// Only the release delta is summarized: `risk.releaseRisk` describes what this
// version pair actually changed, while `artifactRisk` folds in standing context
// about the package. A card headlining context risk would put a red number on a
// release whose diff is clean.
function cardStats(payload: PublicPackageDiff): OgCardStats {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const entry of payload.diff) {
    if (entry.status === "added") added++;
    else if (entry.status === "removed") removed++;
    else if (entry.status === "modified") modified++;
  }
  return {
    filesChanged: added + removed + modified,
    added,
    removed,
    modified,
    findingCount: payload.risk.releaseFindingCount,
    risk: highestSeverityRisk(payload),
  };
}

// A miss is the normal cold state, not an error: the card still names the
// package and version pair, and the numbers appear once someone has actually
// opened the diff and warmed the cache.
async function readCachedStats(c: OgContext, spec: CardSpec): Promise<OgCardStats | undefined> {
  try {
    const key = await computePublicDiffCacheKey({
      ecosystem: spec.adapter.ecosystem,
      packageName: spec.packageName,
      fromVersion: spec.fromVersion,
      toVersion: spec.toVersion,
      registryUrl: spec.adapter.registryUrl,
    });
    const cached = await readPublicDiffCache(c.env, key);
    return cached ? cardStats(cached) : undefined;
  } catch {
    return undefined;
  }
}

async function staticFallback(c: OgContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return c.json({ error: "not found" }, 404);
  const response = await assets.fetch(new URL(STATIC_FALLBACK_PATH, c.req.url));
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/png",
      "cache-control": FALLBACK_CACHE_CONTROL,
    },
  });
}

// Wildcard rather than named params: a scoped npm name spans two path segments
// (/og/diff/@scope/name/1.0.0/1.1.0/card.png), so segment counting belongs in
// the shared parser.
ogRoutes.get("/diff/*", async (c) => {
  const spec = parseCardSpec(c.req.path);
  if (!spec) return c.json({ error: "invalid card request" }, 400);

  const cacheKey = cardCacheKey(c.req.url, spec);
  const cached = await coloCache().match(cacheKey);
  if (cached) return cached;

  // Rate limiting sits behind the cache read: the render is the expensive part,
  // and repeat crawler fetches of a card that is already warm should not be
  // charged against the limit (or write a D1 row).
  try {
    await enforceRateLimit(createDb(c.env.DB), {
      key: `og-card:${c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return staticFallback(c);
    throw err;
  }

  const stats = await readCachedStats(c, spec);
  const svg = renderOgCardSvg({
    ecosystem: spec.ecosystem,
    packageName: spec.packageName,
    fromVersion: diffRefLabel(spec.fromVersion),
    toVersion: diffRefLabel(spec.toVersion),
    stats,
  });

  let png: Uint8Array;
  try {
    png = await renderSvgToPng(c.env, c.req.url, svg);
  } catch (err) {
    emitOperationalEvent("error", "og_card.render_failed", {
      ecosystem: spec.adapter.ecosystem,
      packageName: spec.packageName,
      error: describeOperationalError(err),
    });
    return staticFallback(c);
  }

  const response = new Response(png as unknown as BodyInit, {
    headers: {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      "cache-control": CARD_CACHE_CONTROL,
      "cache-tag": spec.adapter.cacheTag(spec.packageName),
      "x-og-card-size": `${OG_CARD_WIDTH}x${OG_CARD_HEIGHT}`,
      "x-og-card-stats": stats ? "cached" : "unavailable",
    },
  });
  c.executionCtx.waitUntil(coloCache().put(cacheKey, response.clone()));
  return response;
});
