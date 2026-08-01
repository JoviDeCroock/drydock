import { Hono } from "hono";
import { createDb } from "./db/client";
import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "./db/audit-log";
import { pruneExpiredAuthRows } from "./db/auth-retention";
import {
  RateLimitError,
  enforceRateLimit,
  pruneExpiredRateLimitBuckets,
} from "./lib/platform/rate-limit";
import { createAuth, getAuthSession } from "./lib/auth";
import { UnauthorizedError } from "./lib/platform/errors";
import { rateLimitResponse } from "./lib/platform/http";
import { isPackageDiffDetailPath, rewritePackageDiffMetadata } from "./lib/public-diff/page";
import {
  API_CSP,
  DOCUMENT_CSP,
  SECURITY_HEADERS,
  securityHeadersDisabled,
} from "./lib/platform/security-headers";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./lib/platform/observability";
import {
  classifyScanError,
  executeScanJob,
  isScanQueueMessage,
  isWorkflowGateMessage,
  MAX_SCAN_JOB_ATTEMPTS,
  retryDelaySeconds,
  type QueueMessage,
} from "./lib/scan/job";
import { executeWorkflowGateJob } from "./lib/workflow-gate-job";
import {
  DISCOVERY_SWEEP_QUEUE_NAME,
  enqueueDiscoverySweeps,
  isDiscoverySweepMessage,
  runDiscoverySweep,
  type DiscoverySweepQueueMessage,
} from "./lib/discovery/sweep-queue";
import { auditRoutes } from "./routes/audit";
import { githubAppRoutes } from "./routes/github-app";
import { githubWebhookRoutes } from "./routes/github-webhooks";
import { publicReportsRoutes } from "./routes/public-reports";
import { npmConnectionRoutes } from "./routes/npm-connection";
import { organizationMembersRoutes } from "./routes/organization-members";
import { ogRoutes } from "./routes/og";
import { organizationsRoutes } from "./routes/organizations";
import { publicDiffRoutes } from "./routes/public-diff";
import { slackRoutes } from "./routes/slack";
import { scansRoutes } from "./routes/scans";
import { stagedPublishesRoutes } from "./routes/staged-publishes";
import type { Bindings, Variables } from "./types";

export { NpmStageGateway } from "./lib/sandbox";
export { NpmAdapterBroker } from "./lib/ecosystems/npm";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const CANONICAL_HOSTNAME = "drydock.org";
const LEGACY_HOSTNAME = "drydock.resynapse.dev";
const SERVER_OWNED_PATH_PREFIXES = ["/api", "/webhooks", "/og", "/public"];
const DASHBOARD_STATIC_ASSET_PATHS = new Set([
  "/dashboard",
  "/dashboard/",
  "/dashboard/account",
  "/dashboard/account/",
  "/dashboard/invite",
  "/dashboard/invite/",
  "/dashboard/settings",
  "/dashboard/settings/",
  "/dashboard/settings/github-app/callback",
  "/dashboard/settings/github-app/callback/",
]);

function canonicalDomainRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== LEGACY_HOSTNAME) return null;
  url.hostname = CANONICAL_HOSTNAME;
  return Response.redirect(url.toString(), 308);
}

function isServerOwnedPath(path: string): boolean {
  return SERVER_OWNED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function assetFallbackRequest(request: Request): Request {
  const url = new URL(request.url);
  if (isPackageDiffDetailPath(url.pathname)) {
    url.pathname = "/diff/";
    url.search = "";
    return new Request(url, request);
  }
  if (url.pathname.startsWith("/reports/")) {
    url.pathname = "/reports/";
    url.search = "";
    return new Request(url, request);
  }
  if (
    (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) &&
    !DASHBOARD_STATIC_ASSET_PATHS.has(url.pathname)
  ) {
    url.pathname = "/dashboard/";
    url.search = "";
    return new Request(url, request);
  }
  return request;
}

// A share link's capability *is* its token, so the raw path must never reach a
// log line. Cloudflare's own invocation logs still capture the full URL — that
// is inherent to capability URLs and is why revocation is immediate — but
// nothing Drydock writes should widen that exposure.
// Both spellings carry the token: /public/reports/:token is the API read, and
// /reports/:token is the browser-facing page that wraps it. Redacting only the
// former leaves the document request — the one a human actually pastes around,
// and the one whose asset fallback can throw — logging the capability in full.
export function redactCapabilityPath(path: string): string {
  return path.replace(/^(\/public)?\/reports\/[^/]+/, "$1/reports/:token");
}

function applySecurityHeaders(c: { res: Response; req: { path: string } }) {
  const headers = new Headers(c.res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // Worker-owned routes carry the locked-down API policy; static asset responses
  // fetched through the ASSETS binding keep the document policy.
  headers.set(
    "Content-Security-Policy",
    c.req.path.startsWith("/api/") || c.req.path.startsWith("/public/") ? API_CSP : DOCUMENT_CSP,
  );

  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
}

app.use("*", async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status > 599) return;
  // Local-dev escape hatch: the strict CSP breaks Vite's HMR client and HSTS
  // would pin the loopback origin to HTTPS. Gated behind a `.dev.vars`-only flag
  // that is absent from every deployed config, so production fails closed.
  if (securityHeadersDisabled(c.env)) return;
  applySecurityHeaders(c);
});

app.use("*", async (c, next) => canonicalDomainRedirect(c.req.raw) ?? next());

// GitHub App webhooks are signed by GitHub itself, not Better Auth, and arrive
// without an Origin/Referer header. They must be mounted before the auth and
// CSRF middleware below — the signature verification inside the handler is the
// trust boundary.
app.route("/webhooks", githubWebhookRoutes);

// The public package-diff endpoints are anonymous by design: they serve only
// data derived from public release artifacts and public pkg.pr.new preview
// tarballs, touch no organization resources, and are abuse-controlled by
// per-IP rate limits plus the KV cache for version pairs. They must stay
// mounted before the auth middleware below; every other /api/* endpoint keeps
// requiring a session.
app.route("/api/public/v1/package-diff", publicDiffRoutes);

// Share cards for the same anonymous surface. Mounted outside /api so social
// crawlers fetch a plain image URL, and before the auth middleware for the same
// reason the diff API is: an unfurl has no session and must not need one.
app.route("/og", ogRoutes);

// Publicly shared scan reports are capability-URLs: the unguessable share
// token (opted into by an org owner/admin) is the trust boundary, so these
// mount before the auth middleware too. Rate-limited per IP inside the routes.
app.route("/public", publicReportsRoutes);

app.use("/api/*", async (c, next) => {
  try {
    c.set("auth", createAuth(c.env));
  } catch (err) {
    emitOperationalEvent("error", "auth.initialization_failed", {
      error: describeOperationalError(err),
    });
    return c.json({ error: "auth is not configured" }, 503);
  }
  await next();
});

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("/api/*", async (c, next) => {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) return next();
  const expected = c.env.BETTER_AUTH_URL;
  if (!expected) return next();
  const expectedOrigin = (() => {
    try {
      return new URL(expected).origin;
    } catch {
      return null;
    }
  })();
  if (!expectedOrigin) return next();
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  const sourceOrigin =
    origin ||
    (referer
      ? (() => {
          try {
            return new URL(referer).origin;
          } catch {
            return null;
          }
        })()
      : null);
  if (!sourceOrigin || sourceOrigin !== expectedOrigin) {
    return c.json({ error: "request origin not allowed" }, 403);
  }
  return next();
});

app.use("/api/auth/*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const path = c.req.path;
  const limit = authIpLimit(path);
  if (!limit) return next();
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return next();
  try {
    await enforceRateLimit(c.env, {
      key: `auth:${limit.bucket}:${ip}`,
      limit: limit.max,
      windowMs: limit.windowMs,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "too many authentication attempts", err);
    }
    throw err;
  }
  return next();
});

app.all("/api/auth/*", (c) => {
  const auth = c.get("auth");
  return (auth as { handler(request: Request): Promise<Response> }).handler(c.req.raw);
});

function authIpLimit(path: string): { bucket: string; max: number; windowMs: number } | null {
  if (path.startsWith("/api/auth/two-factor")) {
    return { bucket: "two-factor", max: 10, windowMs: 15 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/sign-in")) {
    return { bucket: "sign-in", max: 10, windowMs: 15 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/sign-up")) {
    return { bucket: "sign-up", max: 5, windowMs: 60 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/forget-password") || path.startsWith("/api/auth/reset-password")) {
    return { bucket: "password-reset", max: 5, windowMs: 60 * 60 * 1000 };
  }
  return null;
}

app.use("/api/*", async (c, next) => {
  const session = await getAuthSession(c.get("auth"), c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("authSession", session);
  await next();
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    auth: true,
    db: true,
  }),
);

app.get("/api", (c) =>
  c.json({
    name: "drydock",
    endpoints: {
      createScan: "POST /api/v1/scans { stageId }",
      scans: "GET /api/v1/scans",
      scanDetail: "GET /api/v1/scans/:id",
      stagedPublishes: "POST /api/v1/staged-publishes/scan",
      npmConnection: "GET/POST/DELETE /api/v1/npm-connection; POST /api/v1/npm-connection/validate",
      organizations:
        "GET /api/v1/organizations; POST /api/v1/organizations; PATCH /api/v1/organizations/:id",
      organizationMembers:
        "GET /api/v1/organizations/members; DELETE /api/v1/organizations/members/:userId; GET/POST /api/v1/organizations/invitations; DELETE /api/v1/organizations/invitations/:invitationId; POST /api/v1/organizations/invitations/accept",
      githubApp:
        "GET /api/v1/github-app/config; POST /api/v1/github-app/install; POST /api/v1/github-app/install/callback; GET /api/v1/github-app/installations; GET/POST /api/v1/github-app/release-targets; DELETE /api/v1/github-app/release-targets/:id; GET /api/v1/github-app/workflow-gates/by-scan/:scanId; POST /api/v1/github-app/workflow-gates/:gateId/decision",
      githubWebhooks: "POST /webhooks/github (signed by GitHub App webhook secret)",
      publicPackageDiff:
        "GET /api/public/v1/package-diff?package&from&to[&ecosystem=npm|pypi|atpm]; GET /api/public/v1/package-diff/versions?package[&ecosystem]; GET /api/public/v1/package-diff/file?package&from&to&path[&ecosystem] (anonymous, IP rate-limited, public release data only; on npm, from/to also accept pkg.pr.new preview URLs)",
      atpmStagedReview:
        "GET /api/public/v1/package-diff/atpm-stage?publisher&rkey — browser navigation redirects to the review; API requests receive the resolved review as JSON. Anonymous, IP rate-limited, public AT Protocol records only.",
      publicReports:
        "POST/DELETE /api/v1/scans/:id/share; GET /public/reports/:token; GET /public/reports/:token/attestation; GET /public/attestation-key (share token is the capability; no auth)",
      publicFeed:
        "GET /public/threat-feed.json (feed-listed shared reviews); GET /public/badge/:ecosystem/:package[?tag=] (shields.io endpoint badge; tag defaults to latest)",
      slack:
        "GET /api/v1/slack; POST /api/v1/slack/connect; GET /api/v1/slack/callback; GET /api/v1/slack/channels; PUT /api/v1/slack/channel; PATCH /api/v1/slack; DELETE /api/v1/slack; POST /api/v1/slack/test",
      health: "GET /api/health",
    },
    auth: "Better Auth is required for every non-auth API endpoint except the anonymous /api/public/* package-diff endpoints (public release data only) and /public/reports/* (a share token is the capability; the owning organization opted in per scan).",
    note: "Cloudflare Workers cannot spawn the npm CLI. This service performs the npm stage download equivalent inside a Dynamic Worker by fetching the staged tarball through a locked-down gateway.",
  }),
);

app.route("/api/v1/github-app", githubAppRoutes);
app.route("/api/v1/npm-connection", npmConnectionRoutes);
app.route("/api/v1/organizations", organizationsRoutes);
app.route("/api/v1/organizations", organizationMembersRoutes);
// Single scan-submit surface: POST /api/v1/scans creates a pending scan,
// returns 202, and runs the pipeline on SCAN_QUEUE (or a waitUntil() fallback
// in local/dev). The UI polls GET /api/v1/scans/:id. The automated paths don't
// go through this HTTP route: scheduled discovery (the cron +
// /staged-publishes/scan) and the GitHub gate enqueue onto the same SCAN_QUEUE
// directly. Running the full pipeline inline in a request handler is a Workers
// CPU-timeout risk, so no synchronous submit route exists.
app.route("/api/v1/scans", scansRoutes);
app.route("/api/v1/slack", slackRoutes);
app.route("/api/v1/staged-publishes", stagedPublishesRoutes);
app.route("/api/v1/audit-events", auditRoutes);

app.notFound(async (c) => {
  if (!isServerOwnedPath(c.req.path) && c.env.ASSETS) {
    const response = await c.env.ASSETS.fetch(assetFallbackRequest(c.req.raw));
    return rewritePackageDiffMetadata(response, c.req.path, c.env);
  }
  return c.json({ error: "not found" }, 404);
});

app.onError((err, c) => {
  // A session that resolved from the cookie cache can outlive its user by up to
  // the cache lifetime. Helpers that discover the missing principal raise this
  // instead of threading a nullable identity through every return type.
  if (err instanceof UnauthorizedError) return c.json({ error: "unauthorized" }, 401);
  emitOperationalEvent("error", "request.unhandled_error", {
    method: c.req.method,
    path: redactCapabilityPath(c.req.path),
    error: describeOperationalError(err),
  });
  return c.json({ error: "internal error" }, 500);
});

// Flat-window retention for the organization audit log. Runs each tick; a
// bounded DELETE keeps the sweep cheap. Never let pruning failures abort the
// discovery cron.
async function pruneStaleAuditEvents(env: Cloudflare.Env) {
  const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await pruneAuditEventsOlderThan(createDb(env.DB), cutoff);
    emitOperationalEvent("info", "audit_events.pruned", {
      retentionDays: AUDIT_LOG_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    });
  } catch (err) {
    emitOperationalEvent("error", "audit_events.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

// Better Auth never removes its own expired rows, so `session` grows with every
// sign-in and holds each dead session's IP address and user agent forever. Sweep
// them on the same tick as the audit log, and on the same terms: a prune failure
// is logged, never thrown, so it can't take the cron down with it.
async function pruneStaleAuthRows(env: Cloudflare.Env) {
  try {
    const pruned = await pruneExpiredAuthRows(createDb(env.DB));
    if (pruned.sessions > 0 || pruned.verifications > 0) {
      emitOperationalEvent("info", "auth_rows.pruned", {
        sessions: pruned.sessions,
        verifications: pruned.verifications,
      });
    }
  } catch (err) {
    emitOperationalEvent("error", "auth_rows.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

// Only the windows the native Rate Limiting binding cannot express (the hourly
// and 15-minute budgets on human-initiated actions) still write D1 buckets, so
// this sweep is small. It used to run on whichever request happened to cross a
// per-isolate 5-minute timer, which put an unbounded DELETE on the hot path.
async function pruneStaleRateLimitBuckets(env: Cloudflare.Env) {
  try {
    await pruneExpiredRateLimitBuckets(createDb(env.DB), new Date());
  } catch (err) {
    emitOperationalEvent("error", "rate_limits.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    // The tick is a producer: it enumerates sweep-eligible organizations and
    // fans one message per organization onto DISCOVERY_QUEUE, so its CPU cost
    // no longer scales with the number of organizations swept. Its D1
    // enumeration still runs outside any per-organization handler, so a
    // transient D1 failure here must not skip audit pruning — log and move on.
    try {
      await enqueueDiscoverySweeps(env, ctx);
    } catch (err) {
      emitOperationalEvent("error", "staged_publishes.cron.failed", {
        error: describeOperationalError(err),
      });
    }
    await pruneStaleAuditEvents(env);
    await pruneStaleAuthRows(env);
    await pruneStaleRateLimitBuckets(env);
  },
  async queue(
    batch: MessageBatch<QueueMessage | DiscoverySweepQueueMessage>,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ) {
    // Discovery sweeps have their own queue so a discovery burst cannot starve
    // scan execution. The pairing is enforced in both directions: a sweep body
    // is only honored on the discovery queue, and the discovery queue only
    // carries sweep bodies. Anything else — including a body with an
    // unrecognized `kind` from a future or rolled-back deploy — is dropped by
    // the guard below instead of falling through to the scan handler, which
    // would run `executeScanJob` with undefined ids.
    const isDiscoveryQueue = batch.queue === DISCOVERY_SWEEP_QUEUE_NAME;
    const dropUnroutableMessage = (
      body: unknown,
      attempts: number,
      startedAtMs: number,
      reason: string,
    ) => {
      emitOperationalEvent("error", "queue.message.unknown_kind", {
        queue: batch.queue ?? null,
        kind:
          typeof body === "object" && body !== null && "kind" in body
            ? String((body as { kind: unknown }).kind)
            : null,
        reason,
        attempt: attempts,
        durationMs: durationMsSince(startedAtMs),
      });
      // Acked, not retried: redelivering a message no handler claims only burns
      // the consumer, and on the discovery queue (no dead-letter queue) it would
      // be dropped anyway — with no record of why.
    };

    for (const message of batch.messages) {
      const messageStartedAtMs = Date.now();
      if (isDiscoverySweepMessage(message.body)) {
        if (!isDiscoveryQueue) {
          dropUnroutableMessage(
            message.body,
            message.attempts,
            messageStartedAtMs,
            "sweep_off_discovery_queue",
          );
          continue;
        }
        const sweepMessage = message.body;
        // runDiscoverySweep classifies and logs every failure itself, so the
        // message always acks: a broken token or a flaky registry is re-swept
        // by the next tick, not by a queue retry.
        await runDiscoverySweep(env, ctx, sweepMessage);
        emitOperationalEvent("info", "staged_publishes.sweep.queue.message.completed", {
          organizationId: sweepMessage.organizationId,
          attempt: message.attempts,
          durationMs: durationMsSince(messageStartedAtMs),
        });
        continue;
      }
      if (isDiscoveryQueue) {
        dropUnroutableMessage(
          message.body,
          message.attempts,
          messageStartedAtMs,
          "non_sweep_on_discovery_queue",
        );
        continue;
      }
      if (isWorkflowGateMessage(message.body)) {
        const gateMessage = message.body;
        try {
          await executeWorkflowGateJob(env, ctx, gateMessage);
          emitOperationalEvent("info", "workflow_gate.queue.message.completed", {
            organizationId: gateMessage.organizationId,
            gateId: gateMessage.gateId,
            attempt: message.attempts,
            durationMs: durationMsSince(messageStartedAtMs),
          });
        } catch (err) {
          if (message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
            message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
            emitOperationalEvent("warn", "workflow_gate.queue.retry_scheduled", {
              organizationId: gateMessage.organizationId,
              gateId: gateMessage.gateId,
              attempt: message.attempts,
              nextDelaySeconds: retryDelaySeconds(message.attempts),
              durationMs: durationMsSince(messageStartedAtMs),
              error: describeOperationalError(err),
            });
          } else {
            emitOperationalEvent("error", "workflow_gate.queue.message_failed", {
              organizationId: gateMessage.organizationId,
              gateId: gateMessage.gateId,
              attempt: message.attempts,
              durationMs: durationMsSince(messageStartedAtMs),
              error: describeOperationalError(err),
            });
            throw err;
          }
        }
        continue;
      }
      if (!isScanQueueMessage(message.body)) {
        dropUnroutableMessage(
          message.body,
          message.attempts,
          messageStartedAtMs,
          "unrecognized_body",
        );
        continue;
      }
      const scanMessage = message.body;
      try {
        await executeScanJob(env, ctx, scanMessage, undefined, {
          attempt: message.attempts,
          finalAttempt: message.attempts >= MAX_SCAN_JOB_ATTEMPTS,
        });
        emitOperationalEvent("info", "scan.queue.message.completed", {
          scanId: scanMessage.scanId,
          organizationId: scanMessage.organizationId,
          stageId: scanMessage.stageId,
          source: scanMessage.source ?? "manual",
          attempt: message.attempts,
          durationMs: durationMsSince(messageStartedAtMs),
        });
      } catch (err) {
        const safe = classifyScanError(err);
        if (safe.retryable && message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          emitOperationalEvent("warn", "scan.queue.retry_scheduled", {
            scanId: scanMessage.scanId,
            organizationId: scanMessage.organizationId,
            stageId: scanMessage.stageId,
            source: scanMessage.source ?? "manual",
            attempt: message.attempts,
            nextDelaySeconds: retryDelaySeconds(message.attempts),
            durationMs: durationMsSince(messageStartedAtMs),
            error: safe,
          });
        } else {
          emitOperationalEvent("error", "scan.queue.message_failed", {
            scanId: scanMessage.scanId,
            organizationId: scanMessage.organizationId,
            stageId: scanMessage.stageId,
            source: scanMessage.source ?? "manual",
            attempt: message.attempts,
            exhausted: safe.retryable,
            durationMs: durationMsSince(messageStartedAtMs),
            error: safe,
          });
          if (safe.retryable) throw err;
        }
      }
    }
  },
};
