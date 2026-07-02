import { Hono, type Context } from "hono";
import {
  RateLimitError,
  createDb,
  enforceRateLimit,
  getScan,
  getScanReportShareByTokenHash,
} from "../db";
import { rateLimitResponse } from "../lib/http";
import { buildReportExport } from "../lib/report-export";
import { REPORT_SHARE_TOKEN_RE, hashReportShareToken } from "../lib/report-share-token";
import { scanArtifactReadBucket } from "../lib/scan-artifacts";
import type { Bindings, Variables } from "../types";

// Unauthenticated report access, gated only by an unguessable bearer token in
// the URL. These routes are mounted before the Better Auth session middleware;
// they must never expose anything beyond the redacted canonical report export
// and must never write scan state.
export const publicReportsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function resolveSharedScan(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<{ detail: NonNullable<Awaited<ReturnType<typeof getScan>>> } | { error: Response }> {
  const token = c.req.param("token") ?? "";
  if (!REPORT_SHARE_TOKEN_RE.test(token)) {
    return { error: c.json({ error: "not found" }, 404) };
  }

  const db = createDb(c.env.DB);
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) {
    try {
      await enforceRateLimit(db, {
        key: `public-report:${ip}`,
        limit: 60,
        windowMs: 60 * 1000,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return { error: rateLimitResponse(c, "rate limit exceeded", err) };
      }
      throw err;
    }
  }

  const share = await getScanReportShareByTokenHash(db, await hashReportShareToken(token));
  if (!share) return { error: c.json({ error: "not found" }, 404) };

  const detail = await getScan(
    db,
    share.scanId,
    share.organizationId,
    scanArtifactReadBucket(c.env),
  );
  if (!detail || detail.scan.status !== "complete") {
    return { error: c.json({ error: "not found" }, 404) };
  }
  return { detail };
}

publicReportsRoutes.get("/:token", async (c) => {
  const resolved = await resolveSharedScan(c);
  if ("error" in resolved) return resolved.error;
  // Same redacted canonical shape as the authenticated report.json export;
  // organization identity and audit events are not part of the export.
  return c.json(buildReportExport(resolved.detail), 200, { "cache-control": "no-store" });
});

const BADGE_COLORS: Record<string, string> = {
  none: "brightgreen",
  low: "green",
  medium: "yellow",
  high: "orange",
  critical: "red",
};

// Shields endpoint-badge JSON. Consumers embed it with
// https://img.shields.io/endpoint?url=<this route>, which keeps badge
// rendering out of the Worker entirely.
publicReportsRoutes.get("/:token/badge", async (c) => {
  const resolved = await resolveSharedScan(c);
  if ("error" in resolved) return resolved.error;
  const { scan } = resolved.detail;
  const risk = resolved.detail.riskSummary?.releaseRisk ?? scan.risk;
  return c.json(
    {
      schemaVersion: 1,
      label: "drydock",
      message: `${risk} risk`,
      color: BADGE_COLORS[risk] ?? "lightgrey",
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
});
