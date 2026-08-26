import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import {
  encodeThreatFeedCursor,
  findListedReviewScan,
  listBadgeCandidateScans,
  listThreatFeedScans,
  parseThreatFeedCursor,
  resolvePublicShareToken,
  threatFeedNextCursor,
  THREAT_FEED_MAX_ENTRIES,
} from "../db/scan-share";
import { getScan } from "../db/scans";
import {
  buildBadgePayload,
  buildListedReview,
  buildThreatFeedEntry,
  buildUnlistedReview,
  badgeTagMatches,
  buildUnavailableBadgePayload,
  isValidBadgeTag,
  pickBadgeScan,
  PUBLIC_ECOSYSTEMS,
  parseReviewedArtifactDigest,
  publicFeedCacheKey,
  publicPackageNameMax,
  resolveBadgeTag,
  scanDistTag,
  scanEcosystem,
  THREAT_FEED_SCHEMA,
  type PublicEcosystem,
} from "../lib/public-feed";
import { coloCacheMatch, coloCachePut } from "../lib/platform/colo-cache";
import { optionalWorkerExecutionContext } from "../lib/platform/execution-context";
import { buildAttestationStatement, loadAttestationKey, signAttestation } from "../lib/attestation";
import { sha256Hex } from "../lib/platform/crypto-utils";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import { RateLimitError, enforceRateLimit } from "../lib/platform/rate-limit";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import {
  buildReportExport,
  REPORT_EXPORT_SCHEMA,
  reportExportFilename,
  serializeReportExport,
  serializeReportExportDocument,
} from "../lib/scan/report-export";
import { scanArtifactReadBucket } from "../lib/scan/artifacts";
import type { Bindings, Variables } from "../types";

// The unguessable share token is the authentication boundary for report routes.
export const publicReportsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const PUBLIC_READ_RATE = { bucket: "public-report", limit: 120, windowMs: 60 * 1000 };
const PUBLIC_BADGE_READ_RATE = { bucket: "public-badge", limit: 120, windowMs: 60 * 1000 };

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

publicReportsRoutes.use("*", async (c, next) => {
  await next();
  const headers = new Headers(c.res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "content-disposition, retry-after");
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

const COLO_CACHED_PATHS = [/^\/badge\//, /^\/threat-feed\.json$/];

const COLO_CACHE_SKIP_HEADER = "x-drydock-colo-cache-skip";

publicReportsRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);
  const routePath = url.pathname.replace(/^\/public/, "");
  if (!COLO_CACHED_PATHS.some((re) => re.test(routePath))) return next();
  if (routePath.startsWith("/threat-feed")) {
    // Do not cache report URLs derived from an unpinned request origin.
    if (!c.env.BETTER_AUTH_URL) return next();
    if (url.search) return next();
  }
  const cacheKey = publicFeedCacheKey(canonicalOrigin(c), routePath, url.search);
  const cached = await coloCacheMatch(cacheKey);
  if (cached) return cached;
  await next();
  const skip = c.res?.headers.has(COLO_CACHE_SKIP_HEADER);
  if (c.res?.status === 200 && !skip && !c.res.headers.get("cache-control")?.includes("no-store")) {
    coloCachePut(optionalWorkerExecutionContext(c), cacheKey, c.res.clone());
  }
  if (skip) c.res.headers.delete(COLO_CACHE_SKIP_HEADER);
});

publicReportsRoutes.use("*", async (c, next) => {
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return next();
  const routePath = new URL(c.req.url).pathname.replace(/^\/public/, "");
  const isBadgeRequest = routePath.startsWith("/badge/");
  const rate = isBadgeRequest ? PUBLIC_BADGE_READ_RATE : PUBLIC_READ_RATE;
  try {
    await enforceRateLimit(c.env, {
      key: `${rate.bucket}:${ip}`,
      limit: rate.limit,
      windowMs: rate.windowMs,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (isBadgeRequest) {
        return c.json(buildUnavailableBadgePayload(resolveBadgeTag(c.req.query("tag"))), 200, {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "retry-after": String(err.retryAfterSeconds),
        });
      }
      return rateLimitResponse(c, "too many public report requests", err);
    }
    throw err;
  }
  return next();
});

publicReportsRoutes.get("/attestation-key", async (c) => {
  const key = await loadAttestationKey(c.env);
  if (!key) return c.json({ error: "attestations are not configured" }, 503);
  return c.json({ keyId: key.keyId, algorithm: "Ed25519", jwk: key.publicJwk }, 200, {
    "cache-control": "public, max-age=3600",
  });
});

publicReportsRoutes.get("/threat-feed.json", async (c) => {
  const db = createDb(c.env.DB);
  const after = parseThreatFeedCursor(c.req.query("after"));
  const requested = Number(c.req.query("limit"));
  const limit = Number.isFinite(requested)
    ? Math.min(THREAT_FEED_MAX_ENTRIES, Math.max(1, Math.floor(requested)))
    : THREAT_FEED_MAX_ENTRIES;
  const rows = await listThreatFeedScans(db, { limit, after });
  const origin = canonicalOrigin(c);
  return c.json(
    {
      schema: THREAT_FEED_SCHEMA,
      generatedAt: new Date().toISOString(),
      entries: rows.map((row) => buildThreatFeedEntry(row, origin)),
      nextCursor: encodeThreatFeedCursor(threatFeedNextCursor(rows, limit)),
    },
    200,
    { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  );
});

const BADGE_ERROR_HEADERS = { "access-control-allow-origin": "*" } as const;

publicReportsRoutes.get("/badge/:ecosystem/*", async (c) => {
  const ecosystem = c.req.param("ecosystem") as PublicEcosystem;
  if (!PUBLIC_ECOSYSTEMS.includes(ecosystem)) {
    return c.json({ error: "unknown ecosystem" }, 404, BADGE_ERROR_HEADERS);
  }
  const marker = `/badge/${ecosystem}/`;
  const markerIndex = c.req.path.indexOf(marker);
  const rawName = markerIndex >= 0 ? c.req.path.slice(markerIndex + marker.length) : "";
  let packageName: string;
  try {
    packageName = decodeURIComponent(rawName);
  } catch {
    return c.json({ error: "invalid package name" }, 400, BADGE_ERROR_HEADERS);
  }
  if (!packageName || packageName.length > publicPackageNameMax(ecosystem)) {
    return c.json({ error: "invalid package name" }, 400, BADGE_ERROR_HEADERS);
  }
  const rawTag = c.req.query("tag")?.trim();
  if (rawTag !== undefined && !isValidBadgeTag(rawTag)) {
    return c.json({ error: "invalid tag" }, 400, BADGE_ERROR_HEADERS);
  }
  const tag = resolveBadgeTag(rawTag);

  const db = createDb(c.env.DB);
  const rows = await listBadgeCandidateScans(db, packageName, ecosystem, tag);
  const match = pickBadgeScan(
    rows.filter(
      (row) =>
        scanEcosystem(row.source, row.summaryJson) === ecosystem &&
        badgeTagMatches(scanDistTag(row.summaryJson), tag),
    ),
  );
  return c.json(buildBadgePayload(match, tag), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
    ...(match ? {} : { [COLO_CACHE_SKIP_HEADER]: "1" }),
  });
});

// Artifact-exact lookup for consumer tooling. npm names may contain a slash, so
// the package name is the wildcard suffix and coordinates stay in the query.
// Misses are intentionally uniform: never scanned, shared-but-private,
// unlisted, revoked, wrong-version, and wrong-byte packages all return the same
// successful result. A policy can then distinguish "not listed" from an outage.
publicReportsRoutes.get("/reviews/:ecosystem/*", async (c) => {
  const ecosystem = c.req.param("ecosystem") as PublicEcosystem;
  if (!PUBLIC_ECOSYSTEMS.includes(ecosystem)) {
    return c.json({ error: "not found" }, 404, { "cache-control": "no-store" });
  }
  const marker = `/reviews/${ecosystem}/`;
  const markerIndex = c.req.path.indexOf(marker);
  const rawName = markerIndex >= 0 ? c.req.path.slice(markerIndex + marker.length) : "";
  let packageName: string;
  try {
    packageName = decodeURIComponent(rawName);
  } catch {
    return c.json({ error: "invalid package name" }, 400, { "cache-control": "no-store" });
  }
  if (!packageName || packageName.length > publicPackageNameMax(ecosystem)) {
    return c.json({ error: "invalid package name" }, 400, { "cache-control": "no-store" });
  }
  const version = c.req.query("version");
  if (!version) {
    return c.json({ error: "version is required" }, 400, { "cache-control": "no-store" });
  }
  // Ecosystem versions are not one grammar (PEP 440 includes an epoch `!`),
  // so keep this boundary structural: exact, bounded, and free of controls.
  // eslint-disable-next-line no-control-regex -- controls are the boundary being rejected
  if (version.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(version)) {
    return c.json({ error: "invalid version" }, 400, { "cache-control": "no-store" });
  }

  const artifactDigest = parseReviewedArtifactDigest(c.req.query("digest"));
  if (!artifactDigest) {
    return c.json({ error: "valid digest is required" }, 400, { "cache-control": "no-store" });
  }

  const row = await findListedReviewScan(
    createDb(c.env.DB),
    packageName,
    ecosystem,
    version,
    artifactDigest,
  );
  const review = row ? buildListedReview(row, ecosystem, artifactDigest, canonicalOrigin(c)) : null;
  if (!review) return c.json(buildUnlistedReview(), 200, { "cache-control": "no-store" });
  return c.json(review, 200, { "cache-control": "no-store" });
});

publicReportsRoutes.get("/reports/:token", async (c) => {
  const loaded = await loadSharedScanDetail(c);
  if ("error" in loaded) return loaded.error;
  emitOperationalEvent("info", "public_report.viewed", {
    scanId: loaded.detail.scan.id,
    organizationId: loaded.detail.scan.organizationId,
  });
  return new Response(serializeReportExport(loaded.detail), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

publicReportsRoutes.get("/reports/:token/attestation", async (c) => {
  const loaded = await loadSharedScanDetail(c);
  if ("error" in loaded) return loaded.error;
  const key = await loadAttestationKey(c.env);
  if (!key) return c.json({ error: "attestations are not configured" }, 503);

  const { detail } = loaded;
  const document = buildReportExport(detail);
  const reportBytes = new TextEncoder().encode(serializeReportExportDocument(document));
  const subjectName =
    detail.scan.packageName && detail.scan.stagedVersion
      ? `${detail.scan.packageName}@${detail.scan.stagedVersion}`
      : detail.scan.id;
  const statement = buildAttestationStatement(
    { name: subjectName, reportSha256: await sha256Hex(reportBytes) },
    {
      scanId: detail.scan.id,
      packageName: detail.scan.packageName ?? null,
      stagedVersion: detail.scan.stagedVersion ?? null,
      previousVersion: detail.scan.previousVersion ?? null,
      risk: detail.scan.risk,
      decision: detail.scan.decision ?? null,
      findingCount: document.findings.length,
      reportSchema: REPORT_EXPORT_SCHEMA,
      reportDigest: detail.scan.reportDigest ?? null,
      completedAt:
        detail.scan.completedAt instanceof Date ? detail.scan.completedAt.toISOString() : null,
      issuedAt: new Date().toISOString(),
    },
  );

  try {
    const envelope = await signAttestation(key, statement);
    emitOperationalEvent("info", "public_report.attestation_issued", {
      scanId: detail.scan.id,
      organizationId: detail.scan.organizationId,
      keyId: key.keyId,
    });
    const filename = reportExportFilename(detail.scan).replace(/\.json$/, ".attestation.json");
    return c.json(envelope, 200, {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${filename}"`,
    });
  } catch (err) {
    emitOperationalEvent("error", "public_report.attestation_failed", {
      scanId: detail.scan.id,
      error: describeOperationalError(err),
    });
    return c.json({ error: "failed to sign attestation" }, 500);
  }
});

async function loadSharedScanDetail(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  const token = c.req.param("token") ?? "";
  if (!SHARE_TOKEN_RE.test(token)) return { error: c.json({ error: "not found" }, 404) } as const;
  const db = createDb(c.env.DB);
  const resolved = await resolvePublicShareToken(db, token);
  if (!resolved) return { error: c.json({ error: "not found" }, 404) } as const;
  // Preserve report and diff bytes used by the attestation; omit only file samples.
  const detail = await getScan(
    db,
    resolved.scanId,
    resolved.organizationId,
    scanArtifactReadBucket(c.env),
    { files: "omit" },
  );
  if (!detail || detail.scan.status !== "complete") {
    return { error: c.json({ error: "not found" }, 404) } as const;
  }
  return { detail } as const;
}
