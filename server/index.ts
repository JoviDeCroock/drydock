import { Hono } from "hono";
import {
  createDb,
  enforceRateLimit,
  getOrganizationOwnerUserId,
  listAutoDiscoveryNpmConnections,
  RateLimitError,
} from "./db";
import { createAuth, getAuthSession } from "./lib/auth";
import { rateLimitResponse } from "./lib/http";
import { allowInsecureLocalRegistry } from "./lib/npm-connection";
import {
  API_CSP,
  DOCUMENT_CSP,
  SECURITY_HEADERS,
  securityHeadersDisabled,
} from "./lib/security-headers";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./lib/observability";
import {
  classifyScanError,
  executeScanJob,
  isWorkflowGateMessage,
  MAX_SCAN_JOB_ATTEMPTS,
  retryDelaySeconds,
  type QueueMessage,
} from "./lib/scan-job";
import { executeWorkflowGateJob } from "./lib/workflow-gate-job";
import {
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
  isNpmConnectionAuthFailure,
  recordExpiredNpmConnection,
  StagedPublishesFetchError,
} from "./lib/staged-publishes-discovery";
import { apiTokensRoutes } from "./routes/api-tokens";
import { githubAppRoutes } from "./routes/github-app";
import { githubWebhookRoutes } from "./routes/github-webhooks";
import { mcpRoutes } from "./routes/mcp";
import { npmConnectionRoutes } from "./routes/npm-connection";
import { organizationMembersRoutes } from "./routes/organization-members";
import { organizationsRoutes } from "./routes/organizations";
import { slackRoutes } from "./routes/slack";
import { scansRoutes } from "./routes/scans";
import { stagedPublishesRoutes } from "./routes/staged-publishes";
import type { Bindings, Variables } from "./types";

export { NpmStageGateway } from "./lib/sandbox";
export { NpmAdapterBroker } from "./lib/adapters/npm";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const CANONICAL_HOSTNAME = "drydock.org";
const LEGACY_HOSTNAME = "drydock.resynapse.dev";
const SERVER_OWNED_PATH_PREFIXES = ["/api", "/webhooks", "/mcp"];
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

function applySecurityHeaders(c: { res: Response; req: { path: string } }) {
  const headers = new Headers(c.res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // Worker-owned routes carry the locked-down API policy; static asset responses
  // fetched through the ASSETS binding keep the document policy.
  const usesApiPolicy =
    c.req.path.startsWith("/api/") || c.req.path === "/mcp" || c.req.path.startsWith("/mcp/");
  headers.set("Content-Security-Policy", usesApiPolicy ? API_CSP : DOCUMENT_CSP);

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

// The read-only MCP server authenticates with org-scoped bearer tokens, not
// Better Auth cookies, and headless agents POST without an Origin header. Like
// the signed webhook route above it is mounted before the /api/* auth and CSRF
// middleware; the API-token hash lookup inside the handler is its trust
// boundary. See docs/mcp.md.
app.route("/mcp", mcpRoutes);

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
    await enforceRateLimit(createDb(c.env.DB), {
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
    name: "staged-publish-review",
    endpoints: {
      createScan: "POST /api/v1/scans { stageId }",
      scans: "GET /api/v1/scans",
      scanDetail: "GET /api/v1/scans/:id",
      stagedPublishes: "POST /api/v1/staged-publishes/scan",
      npmConnection: "GET/POST/DELETE /api/v1/npm-connection; POST /api/v1/npm-connection/validate",
      apiTokens: "GET/POST /api/v1/api-tokens; DELETE /api/v1/api-tokens/:id",
      mcp: "POST /mcp (JSON-RPC 2.0; org-scoped read-only bearer token; see docs/mcp.md)",
      organizations:
        "GET /api/v1/organizations; POST /api/v1/organizations; PATCH /api/v1/organizations/:id",
      organizationMembers:
        "GET /api/v1/organizations/members; DELETE /api/v1/organizations/members/:userId; GET/POST /api/v1/organizations/invitations; DELETE /api/v1/organizations/invitations/:invitationId; POST /api/v1/organizations/invitations/accept",
      githubApp:
        "GET /api/v1/github-app/config; POST /api/v1/github-app/install; POST /api/v1/github-app/install/callback; GET /api/v1/github-app/installations; GET/POST /api/v1/github-app/release-targets; DELETE /api/v1/github-app/release-targets/:id; GET /api/v1/github-app/workflow-gates/by-scan/:scanId; POST /api/v1/github-app/workflow-gates/:gateId/decision",
      githubWebhooks: "POST /webhooks/github (signed by GitHub App webhook secret)",
      slack:
        "GET /api/v1/slack; POST /api/v1/slack/connect; GET /api/v1/slack/callback; GET /api/v1/slack/channels; PUT /api/v1/slack/channel; PATCH /api/v1/slack; DELETE /api/v1/slack; POST /api/v1/slack/test",
      health: "GET /api/health",
    },
    auth: "Better Auth is required for every non-auth API endpoint.",
    note: "Cloudflare Workers cannot spawn the npm CLI. This service performs the npm stage download equivalent inside a Dynamic Worker by fetching the staged tarball through a locked-down gateway.",
  }),
);

app.route("/api/v1/github-app", githubAppRoutes);
app.route("/api/v1/api-tokens", apiTokensRoutes);
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

app.notFound((c) => {
  if (!isServerOwnedPath(c.req.path) && c.env.ASSETS) {
    return c.env.ASSETS.fetch(assetFallbackRequest(c.req.raw));
  }
  return c.json({ error: "not found" }, 404);
});

app.onError((err, c) => {
  emitOperationalEvent("error", "request.unhandled_error", {
    method: c.req.method,
    path: c.req.path,
    error: describeOperationalError(err),
  });
  return c.json({ error: "internal error" }, 500);
});

// A scheduled invocation gets a bounded CPU budget. Sweeping organizations
// sequentially is fine at ~10 orgs but approaches that budget around 50-100,
// after which the tick can be cut off and cycles drop silently. Five sweeps in
// flight keeps us comfortably under budget while still draining a large org
// count within a single 15-minute cycle. Raise only after measuring CPU time.
const DISCOVERY_CRON_CONCURRENCY = 5;

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

async function runStagedPublishesDiscoveryCron(env: Cloudflare.Env, ctx: ExecutionContext) {
  const startedAtMs = Date.now();
  const db = createDb(env.DB);
  const connections = await listAutoDiscoveryNpmConnections(db);
  emitOperationalEvent("info", "staged_publishes.cron.started", {
    organizations: connections.length,
  });
  const allowInsecureLocalhost = allowInsecureLocalRegistry(env);

  let orgsProcessed = 0;
  const sweepConnection = async (connection: (typeof connections)[number]) => {
    try {
      const notificationOwnerUserId = await getOrganizationOwnerUserId(
        db,
        connection.organizationId,
      );
      const actorUserId = connection.createdByUserId ?? notificationOwnerUserId;
      if (!notificationOwnerUserId || !actorUserId) {
        emitOperationalEvent("error", "staged_publishes.cron.skipped", {
          organizationId: connection.organizationId,
          reason: "organization_owner_missing",
        });
        return;
      }
      try {
        const usable = await ensureUsableNpmConnection({
          db,
          env,
          connection,
          actorUserId,
          allowInsecureLocalhost,
        });
        const result = await discoverAndQueueStagedPublishes(
          {
            db,
            env,
            executionCtx: ctx,
            organizationId: connection.organizationId,
            actorUserId,
            source: "auto_discovery",
            eventSource: "staged_publishes.cron",
            allowInsecureLocalhost,
          },
          usable,
        );
        emitOperationalEvent("info", "staged_publishes.cron.org_completed", {
          organizationId: connection.organizationId,
          ...result,
        });
      } catch (err) {
        if (isNpmConnectionAuthFailure(err)) {
          // The token can no longer reach the staging registry. Mark the
          // connection invalid, record it, and email the maintainer so reviews
          // don't silently stop. Never let the alerting itself break the sweep.
          try {
            await recordExpiredNpmConnection({
              db,
              env,
              connection,
              actorUserId,
              notificationOwnerUserId,
              error: err,
            });
          } catch (alertErr) {
            emitOperationalEvent("error", "npm_connection.token_expired_alert_failed", {
              organizationId: connection.organizationId,
              error: describeOperationalError(alertErr),
            });
          }
          return;
        }
        const detail =
          err instanceof StagedPublishesFetchError
            ? { status: err.status, detail: err.detail }
            : describeOperationalError(err);
        emitOperationalEvent("error", "staged_publishes.cron.org_failed", {
          organizationId: connection.organizationId,
          error: detail,
        });
      }
    } finally {
      orgsProcessed++;
    }
  };

  await runWithConcurrency(connections, DISCOVERY_CRON_CONCURRENCY, sweepConnection);

  emitOperationalEvent("info", "staged_publishes.cron.swept", {
    orgsProcessed,
    durationMs: durationMsSince(startedAtMs),
    concurrencyLimit: DISCOVERY_CRON_CONCURRENCY,
  });
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    await runStagedPublishesDiscoveryCron(env, ctx);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Cloudflare.Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      const messageStartedAtMs = Date.now();
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
      try {
        await executeScanJob(env, ctx, message.body, undefined, {
          attempt: message.attempts,
          finalAttempt: message.attempts >= MAX_SCAN_JOB_ATTEMPTS,
        });
        emitOperationalEvent("info", "scan.queue.message.completed", {
          scanId: message.body.scanId,
          organizationId: message.body.organizationId,
          stageId: message.body.stageId,
          source: message.body.source ?? "manual",
          attempt: message.attempts,
          durationMs: durationMsSince(messageStartedAtMs),
        });
      } catch (err) {
        const safe = classifyScanError(err);
        if (safe.retryable && message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          emitOperationalEvent("warn", "scan.queue.retry_scheduled", {
            scanId: message.body.scanId,
            organizationId: message.body.organizationId,
            stageId: message.body.stageId,
            source: message.body.source ?? "manual",
            attempt: message.attempts,
            nextDelaySeconds: retryDelaySeconds(message.attempts),
            durationMs: durationMsSince(messageStartedAtMs),
            error: safe,
          });
        } else {
          emitOperationalEvent("error", "scan.queue.message_failed", {
            scanId: message.body.scanId,
            organizationId: message.body.organizationId,
            stageId: message.body.stageId,
            source: message.body.source ?? "manual",
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
