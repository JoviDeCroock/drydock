import { Hono } from "hono";
import { createAuth, isAuthenticated } from "./lib/auth";
import { scanRoutes } from "./routes/scan";
import { scansRoutes } from "./routes/scans";
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
  c.set("auth", createAuth(c.env));
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = c.get("auth");
  if (!auth) return c.json({ error: "auth database is not configured" }, 503);
  return (auth as { handler(request: Request): Promise<Response> }).handler(c.req.raw);
});

app.use("/api/v1/*", async (c, next) => {
  if (c.env.AUTH_REQUIRED === "true") {
    const authed = await isAuthenticated(c.get("auth"), c.req.raw);
    if (!authed) return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, auth: Boolean(c.get("auth")), db: Boolean(c.env.DB) }));

app.get("/api", (c) =>
  c.json({
    name: "staged-publish-sandbox-prototype",
    endpoints: {
      scan: "POST /api/v1/scan { stageId }",
      scans: "GET /api/v1/scans",
      scanDetail: "GET /api/v1/scans/:id",
      health: "GET /api/health",
    },
    note: "Cloudflare Workers cannot spawn the npm CLI. This prototype performs the npm stage download equivalent inside a Dynamic Worker by fetching the staged tarball through a locked-down gateway.",
  }),
);

app.route("/api/v1/scan", scanRoutes);
app.route("/api/v1/scans", scansRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
