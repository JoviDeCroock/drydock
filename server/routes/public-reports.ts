import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  listBadgeCandidateScans,
  listThreatFeedScans,
  resolvePublicShareToken,
} from "../db/scan-share";
import { getScan } from "../db/scans";
import {
  buildBadgePayload,
  buildThreatFeedEntry,
  pickBadgeScan,
  PUBLIC_ECOSYSTEMS,
  scanEcosystem,
  THREAT_FEED_SCHEMA,
  type PublicEcosystem,
} from "../lib/public-feed";
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
// declare max-age=300), so they read through the colo cache (caches.default) —
// the same pattern as the published-tarball byte cache. Report/attestation
// reads are deliberately NOT cached: revocation must be immediate. Runs before
// the rate limiter so cache hits never cost a D1 round trip.
const COLO_CACHED_PATHS = [/^\/badge\//, /^\/threat-feed\.json$/];

// The Workers runtime exposes the colo cache as `caches.default`, but the DOM
// lib wins the global CacheStorage type in this repo's single tsconfig and
// doesn't know the property.
function coloCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

publicReportsRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const routePath = new URL(c.req.url).pathname.replace(/^\/public/, "");
  if (!COLO_CACHED_PATHS.some((re) => re.test(routePath))) return next();
  // The feed body embeds report URLs built from canonicalOrigin, which falls
  // back to the request origin when BETTER_AUTH_URL is unset — a cached copy
  // of a request-derived origin would be a Host-header poisoning vector, so
  // only cache the feed when the origin is pinned by config.
  if (routePath.startsWith("/threat-feed") && !c.env.BETTER_AUTH_URL) return next();
  // Key on the path only: responses never vary by query, so a cache-busting
  // query string can never force a D1 read-through.
  const cacheKey = new Request(new URL(c.req.path, c.req.url).origin + c.req.path);
  let cached: Response | undefined;
  try {
    cached = await coloCache().match(cacheKey);
  } catch {
    cached = undefined;
  }
  if (cached) return cached;
  await next();
  if (c.res?.status === 200 && !c.res.headers.get("cache-control")?.includes("no-store")) {
    const copy = c.res.clone();
    c.executionCtx.waitUntil(
      coloCache()
        .put(cacheKey, copy)
        .catch(() => {}),
    );
  }
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
      // addresses. Preserve the endpoint-badge contract under throttling and
      // keep this fallback out of the colo cache so it cannot mask a real review.
      if (isBadgeRequest) {
        return c.json(buildBadgePayload(null), 200, {
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
  const rows = await listThreatFeedScans(db);
  const origin = canonicalOrigin(c);
  return c.json(
    {
      schema: THREAT_FEED_SCHEMA,
      generatedAt: new Date().toISOString(),
      entries: rows.map((row) => buildThreatFeedEntry(row, origin)),
    },
    200,
    { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  );
});

// shields.io endpoint badge for a package's latest publicly shared review.
// npm names contain slashes (@scope/name), so the route is a wildcard and the
// name is everything after the ecosystem segment.
publicReportsRoutes.get("/badge/:ecosystem/*", async (c) => {
  const ecosystem = c.req.param("ecosystem") as PublicEcosystem;
  if (!PUBLIC_ECOSYSTEMS.includes(ecosystem)) {
    return c.json({ error: "unknown ecosystem" }, 404);
  }
  const marker = `/badge/${ecosystem}/`;
  const markerIndex = c.req.path.indexOf(marker);
  const rawName = markerIndex >= 0 ? c.req.path.slice(markerIndex + marker.length) : "";
  let packageName: string;
  try {
    packageName = decodeURIComponent(rawName);
  } catch {
    return c.json({ error: "invalid package name" }, 400);
  }
  if (!packageName || packageName.length > 214) {
    return c.json({ error: "invalid package name" }, 400);
  }

  const db = createDb(c.env.DB);
  // Feed-listed scans only (a share link alone never makes a scan
  // name-queryable), the SQL pre-filter re-checked through scanEcosystem, and
  // registry-verified identity preferred over manifest claims.
  const rows = await listBadgeCandidateScans(db, packageName, ecosystem);
  const match = pickBadgeScan(rows.filter((row) => scanEcosystem(row.summaryJson) === ecosystem));
  // Always 200: shields renders the payload either way, and "not reviewed"
  // must not read as an error to badge proxies.
  return c.json(buildBadgePayload(match), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
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
