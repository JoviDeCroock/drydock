import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import { resolvePublicShareToken } from "../db/scan-share";
import { getScan } from "../db/scans";
import {
  buildAttestationStatement,
  loadAttestationKey,
  sha256Hex,
  signAttestation,
} from "../lib/attestation";
import { rateLimitResponse } from "../lib/platform/http";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import {
  REPORT_EXPORT_SCHEMA,
  reportExportFilename,
  serializeReportExport,
} from "../lib/scan/report-export";
import { scanArtifactReadBucket } from "../lib/scan/artifacts";
import type { Bindings, Variables } from "../types";

// Unauthenticated, capability-based report access. These routes are mounted
// before the Better Auth middleware (like /webhooks): the unguessable share
// token IS the trust boundary. Everything served here is the canonical report
// export an org member explicitly opted into sharing — never file samples,
// events, or org/user identifiers beyond what the export itself carries.
export const publicReportsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// One bucket for all public report reads from one address. Generous enough for
// a report page plus its attestation fetch, tight enough to blunt enumeration.
const PUBLIC_READ_RATE = { limit: 120, windowMs: 60 * 1000 };

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

publicReportsRoutes.use("*", async (c, next) => {
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  // Fail-open without a client IP, mirroring the /api/auth limiter: Cloudflare
  // always sets cf-connecting-ip, so this only relaxes non-Cloudflare deploys
  // (unsupported per docs/self-hosting.md).
  if (!ip) return next();
  try {
    await enforceRateLimit(createDb(c.env.DB), {
      key: `public-report:${ip}`,
      ...PUBLIC_READ_RATE,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
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
  const reportBytes = new TextEncoder().encode(serializeReportExport(detail));
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
      findingCount: detail.findings.length,
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
