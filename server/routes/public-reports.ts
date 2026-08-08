import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  encodeThreatFeedCursor,
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
  buildThreatFeedEntry,
  buildUnavailableBadgePayload,
  pickBadgeScan,
  PUBLIC_ECOSYSTEMS,
  publicFeedCacheKey,
  publicPackageNameMax,
  scanEcosystem,
  THREAT_FEED_SCHEMA,
  type PublicEcosystem,
} from "../lib/public-feed";
import { coloCacheMatch, coloCachePut } from "../lib/platform/colo-cache";
import { optionalWorkerExecutionContext } from "../lib/platform/execution-context";
import {
  buildAttestationStatement,
  loadAttestationKey,
  sha256Hex,
  signAttestation,
} from "../lib/attestation";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
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

// Unauthenticated, capability-based report access. These routes are mounted
// before the Better Auth middleware (like /webhooks): the unguessable share
// token IS the trust boundary. Everything served here is the canonical report
// export an org member explicitly opted into sharing — never file samples,
// events, or org/user identifiers beyond what the export itself carries.
export const publicReportsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Report/key reads share a bucket per address. Badge misses use a separate
// bucket because shields.io multiplexes unrelated packages through its egress.
// Both remain tight enough to blunt enumeration and cache-busting traffic.
const PUBLIC_READ_RATE = { bucket: "public-report", limit: 120, windowMs: 60 * 1000 };
const PUBLIC_BADGE_READ_RATE = { bucket: "public-badge", limit: 120, windowMs: 60 * 1000 };

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

// CORS on *every* response, not just the 200s. docs/public-reports.md tells
// consumers to fetch the report and its attestation from the browser and
// re-fetch on digest mismatch; without these headers on the failure paths a
// revoked link is an opaque network error indistinguishable from the service
// being down, and a throttled verifier cannot read `retry-after` to back off.
// Registered ahead of the rate limiter so the 429 it returns is covered too.
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

// The badge and feed are hot, anonymous, and staleness-tolerant (both already
// declare max-age=300), so they read through the colo cache — the same pattern
// as the published-tarball byte cache. Report/attestation reads are
// deliberately NOT cached: revocation must be immediate. Runs before the rate
// limiter so cache hits never cost a D1 round trip.
const COLO_CACHED_PATHS = [/^\/badge\//, /^\/threat-feed\.json$/];

// Internal marker: a handler sets it to opt one response out of the colo cache
// while keeping its downstream `cache-control`. Stripped before the response
// leaves the Worker.
const COLO_CACHE_SKIP_HEADER = "x-drydock-colo-cache-skip";

publicReportsRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const routePath = new URL(c.req.url).pathname.replace(/^\/public/, "");
  if (!COLO_CACHED_PATHS.some((re) => re.test(routePath))) return next();
  if (routePath.startsWith("/threat-feed")) {
    // The feed body embeds report URLs built from canonicalOrigin, which falls
    // back to the request origin when BETTER_AUTH_URL is unset — a cached copy
    // of a request-derived origin would be a Host-header poisoning vector, so
    // only cache the feed when the origin is pinned by config.
    if (!c.env.BETTER_AUTH_URL) return next();
    // The cache key is the path alone, and the feed *does* vary by `?after=`.
    // Only the first page is cacheable; a cursored page must never be served
    // from, or written into, the entry that page one occupies. Backfill pages
    // are rare by nature — a consumer walks them once to catch up.
    if (new URL(c.req.url).search) return next();
  }
  // Key on the *canonical* origin and path only. Everything still cacheable at
  // this point ignores its query string, so a cache-busting query can't force a
  // D1 read-through, and folding badge URLs onto their lookup key means one
  // package has one entry per colo however the embedder encoded the name. The
  // origin has to be canonicalOrigin — the same value purgePublicFeedCache uses
  // from a *dashboard* request — or a deploy bound to a second hostname
  // (workers.dev, a preview alias) writes entries the purge never visits.
  const cacheKey = publicFeedCacheKey(canonicalOrigin(c), routePath);
  const cached = await coloCacheMatch(cacheKey);
  if (cached) return cached;
  await next();
  const skip = c.res?.headers.has(COLO_CACHE_SKIP_HEADER);
  if (c.res?.status === 200 && !skip && !c.res.headers.get("cache-control")?.includes("no-store")) {
    coloCachePut(optionalWorkerExecutionContext(c), cacheKey, c.res.clone());
  }
  // Mutate in place rather than rebuilding: Hono's `c.res` setter copies the
  // previous response's headers onto the replacement, so a delete-then-reassign
  // would put the marker straight back.
  if (skip) c.res.headers.delete(COLO_CACHE_SKIP_HEADER);
});

publicReportsRoutes.use("*", async (c, next) => {
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  // Fail-open without a client IP, mirroring the /api/auth limiter: Cloudflare
  // always sets cf-connecting-ip, so this only relaxes non-Cloudflare deploys
  // (unsupported per docs/self-hosting.md).
  if (!ip) return next();
  const routePath = new URL(c.req.url).pathname.replace(/^\/public/, "");
  const isBadgeRequest = routePath.startsWith("/badge/");
  const rate = isBadgeRequest ? PUBLIC_BADGE_READ_RATE : PUBLIC_READ_RATE;
  try {
    await enforceRateLimit(createDb(c.env.DB), {
      key: `${rate.bucket}:${ip}`,
      limit: rate.limit,
      windowMs: rate.windowMs,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Shields proxies many unrelated package badges through shared egress
      // addresses. Preserve the endpoint-badge contract under throttling (200,
      // or proxies render an error) but say "unavailable", never "not
      // reviewed" — the latter is an assertion about the package that shields
      // would cache for minutes over a review that may say "blocked". Kept out
      // of the colo cache for the same reason.
      if (isBadgeRequest) {
        return c.json(buildUnavailableBadgePayload(), 200, {
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
  return c.json(
    { keyId: key.keyId, algorithm: "Ed25519", jwk: key.publicJwk },
    200,
    // The key rotates rarely; consumers cache it and match envelopes by keyid.
    // (CORS comes from the route-wide middleware above.)
    { "cache-control": "public, max-age=3600" },
  );
});

// Discoverable index of reports whose org opted into feed listing on top of
// sharing. Entries link back to the public report; nothing here is served that
// isn't already reachable through those links.
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
      // Present whenever more listings exist behind this page. A poller that
      // reads only page one after a burst of listings misses everything the
      // burst displaced, so the continuation has to be in the payload rather
      // than something a consumer has to know to ask for.
      nextCursor: encodeThreatFeedCursor(threatFeedNextCursor(rows, limit)),
    },
    200,
    { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  );
});

// shields.io endpoint badge for a package's latest publicly shared review.
// Badge errors are fetched cross-origin by the same proxies as the 200s, so
// they carry the same CORS header; without it the proxy reports an opaque
// network failure instead of the actual status.
const BADGE_ERROR_HEADERS = { "access-control-allow-origin": "*" } as const;

// npm names contain slashes (@scope/name), so the route is a wildcard and the
// name is everything after the ecosystem segment.
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

  const db = createDb(c.env.DB);
  // Feed-listed scans only (a share link alone never makes a scan
  // name-queryable), the SQL pre-filter re-checked through scanEcosystem, and
  // registry-verified identity preferred over manifest claims.
  const rows = await listBadgeCandidateScans(db, packageName, ecosystem);
  const match = pickBadgeScan(
    rows.filter((row) => scanEcosystem(row.source, row.summaryJson) === ecosystem),
  );
  // Always 200: shields renders the payload either way, and "not reviewed"
  // must not read as an error to badge proxies.
  return c.json(buildBadgePayload(match), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
    // Misses stay out of the colo cache. The "not reviewed" body is identical
    // for every package, so a per-name entry buys nothing on a repeat view that
    // the downstream `max-age` would not already absorb — while every distinct
    // name an anonymous client invents writes another entry into the same
    // `caches.default` namespace that holds the published-tarball bytes. Hits
    // are the ones worth keeping.
    ...(match ? {} : { [COLO_CACHE_SKIP_HEADER]: "1" }),
  });
});

publicReportsRoutes.get("/reports/:token", async (c) => {
  const loaded = await loadSharedScanDetail(c);
  if ("error" in loaded) return loaded.error;
  emitOperationalEvent("info", "public_report.viewed", {
    scanId: loaded.detail.scan.id,
    organizationId: loaded.detail.scan.organizationId,
  });
  // Serve the canonical bytes — the attestation's subject digest is computed
  // over exactly this serialization, so the two endpoints must never diverge.
  return new Response(serializeReportExport(loaded.detail), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Revocation must be immediate (the UI and docs promise it), so shared
      // caches may never hold a copy past the revoke.
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
  // Build the document once and sign *its* bytes, so every predicate field is
  // read off the same object the digest covers.
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
      // The export's findings[], not the scan's finding rows: those also carry
      // the AI reviewer's findings, which the export deliberately routes through
      // `aiReview.findings` instead. A verifier comparing this against the
      // attested document must not see two different numbers.
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
  // Shape-check before the DB roundtrip; also keeps arbitrary junk out of the
  // unique-index lookup. Tokens are 43 chars today; the range leaves headroom.
  if (!SHARE_TOKEN_RE.test(token)) return { error: c.json({ error: "not found" }, 404) } as const;
  const db = createDb(c.env.DB);
  const resolved = await resolvePublicShareToken(db, token);
  if (!resolved) return { error: c.json({ error: "not found" }, 404) } as const;
  // `omit` — not `list` — is load-bearing. The export's `findings[].diffStatus`
  // is derived from the diff artifact, so anything that changes whether the
  // artifacts are read changes the serialized bytes, and the attestation's
  // subject digest is computed over exactly those bytes. `omit` keeps the
  // report and diff artifacts (identical output to the authenticated export)
  // and drops only the file-samples payload, which this route never reads.
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
