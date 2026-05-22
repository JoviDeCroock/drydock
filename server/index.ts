import { Hono } from "hono";
import { createDb, enforceRateLimit, RateLimitError } from "./db";
import { createAuth, getAuthSession } from "./lib/auth";
import {
  classifyScanError,
  executeScanJob,
  MAX_SCAN_JOB_ATTEMPTS,
  retryDelaySeconds,
  type ScanQueueMessage,
} from "./lib/scan-job";
import { npmConnectionRoutes } from "./routes/npm-connection";
import { scanRoutes } from "./routes/scan";
import { scansRoutes } from "./routes/scans";
import { stagedPublishesRoutes } from "./routes/staged-publishes";
import type { Bindings, Variables } from "./types";

export { NpmStageGateway } from "./lib/sandbox";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function applySecurityHeaders(c: { res: Response; req: { path: string } }) {
  const headers = new Headers(c.res.headers);
  const apiResponse = c.req.path.startsWith("/api/");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set(
    "Content-Security-Policy",
    apiResponse
      ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
      : [
          "default-src 'self'",
          "base-uri 'self'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
        ].join("; "),
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
  applySecurityHeaders(c);
});

app.use("/api/*", async (c, next) => {
  try {
    c.set("auth", createAuth(c.env));
  } catch (err) {
    console.error("auth initialization failed", err);
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
      return c.json(
        { error: "too many authentication attempts", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
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
    userId: c.get("authSession").userId,
  }),
);

app.get("/api", (c) =>
  c.json({
    name: "staged-publish-review",
    endpoints: {
      createScan: "POST /api/v1/scans { stageId }",
      compatibilityScan: "POST /api/v1/scan { stageId }",
      scans: "GET /api/v1/scans",
      scanDetail: "GET /api/v1/scans/:id",
      stagedPublishes: "GET /api/v1/staged-publishes",
      npmConnection: "GET/POST/DELETE /api/v1/npm-connection; POST /api/v1/npm-connection/validate",
      health: "GET /api/health",
    },
    auth: "Better Auth is required for every non-auth API endpoint.",
    note: "Cloudflare Workers cannot spawn the npm CLI. This service performs the npm stage download equivalent inside a Dynamic Worker by fetching the staged tarball through a locked-down gateway.",
  }),
);

app.route("/api/v1/npm-connection", npmConnectionRoutes);
app.route("/api/v1/scan", scanRoutes);
app.route("/api/v1/scans", scansRoutes);
app.route("/api/v1/staged-publishes", stagedPublishesRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ScanQueueMessage>, env: Cloudflare.Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        await executeScanJob(env, ctx, message.body, undefined, {
          attempt: message.attempts,
          finalAttempt: message.attempts >= MAX_SCAN_JOB_ATTEMPTS,
        });
      } catch (err) {
        const safe = classifyScanError(err);
        if (safe.retryable && message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          console.warn("scan queue job scheduled for retry", {
            scanId: message.body.scanId,
            attempt: message.attempts,
            nextDelaySeconds: retryDelaySeconds(message.attempts),
            error: safe,
          });
        } else {
          console.error("scan queue job failed", {
            scanId: message.body.scanId,
            attempt: message.attempts,
            exhausted: safe.retryable,
            error: safe,
          });
          if (safe.retryable) throw err;
        }
      }
    }
  },
};
