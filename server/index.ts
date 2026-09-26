import { Hono } from "hono";
import {
  createAuth,
  emailVerificationAvailable,
  getAuthSession,
  isGithubSignInEnabled,
} from "./lib/auth";
import { describeOperationalError, emitOperationalEvent } from "./lib/platform/observability";
import { authIpRateLimit } from "./middleware/auth-rate-limit";
import { canonicalHostRedirect, staticAssetFallback } from "./middleware/canonical-host";
import { csrfOriginCheck } from "./middleware/csrf-origin";
import { attachDb } from "./middleware/db";
import { handleAppError } from "./middleware/errors";
import { securityHeaders } from "./middleware/security-headers";
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
import { packagesRoutes } from "./routes/packages";
import { npmPackageClaimRoutes } from "./routes/npm-package-claims";
import { npmPublicationWatchRoutes } from "./routes/npm-publication-watches";
import { scansRoutes } from "./routes/scans";
import { stagedPublishesRoutes } from "./routes/staged-publishes";
import { queue } from "./queue";
import { scheduled } from "./scheduled";
import type { Bindings, Variables } from "./types";

export { NpmStageGateway } from "./lib/sandbox";
export { NpmAdapterBroker } from "./lib/ecosystems/npm";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

export { redactCapabilityPath } from "./middleware/errors";

app.use("*", securityHeaders);
app.use("*", canonicalHostRedirect);

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

app.use("/api/*", csrfOriginCheck);
app.use("/api/auth/*", authIpRateLimit);

// Which optional sign-in methods this deployment offers. Anonymous as part of
// the auth surface: the login and register pages need it before any session
// exists. Deployment configuration only — no user data, no secrets.
app.get("/api/auth/config", (c) =>
  c.json({
    githubSignIn: isGithubSignInEnabled(c.env),
    // Whether this deployment can verify an address at all. Without it the
    // dashboard would show every account a pending-verification banner it
    // could never clear.
    emailVerification: emailVerificationAvailable(c.env),
  }),
);

app.all("/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

app.use("/api/*", async (c, next) => {
  const session = await getAuthSession(c.get("auth"), c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("authSession", session);
  await next();
});

// Every session-bearing /api/* handler reads through `c.var.db`; the anonymous
// /public and /webhooks routers attach their own handle inside the router.
app.use("/api/*", attachDb);

// Session-gated, so it answers for the signed-in dashboard rather than an
// external monitor. The probe is one trivial statement: it proves the D1
// binding answers, not that any table is healthy.
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("select 1").first();
  } catch (err) {
    emitOperationalEvent("error", "health.db_probe_failed", {
      error: describeOperationalError(err),
    });
    return c.json({ ok: false, db: false }, 503);
  }
  return c.json({ ok: true, db: true });
});

app.get("/api", (c) =>
  c.json({
    name: "drydock",
    endpoints: {
      createScan: "POST /api/v1/scans { stageId }",
      scans: "GET /api/v1/scans",
      scanOverview: "GET /api/v1/scans/overview",
      scanDetail: "GET /api/v1/scans/:id",
      packageReleases:
        "GET /api/v1/packages/:name/releases[?ecosystem=npm|pypi|vscode|atpm&cursor&limit] (one organization's reviews of one package, newest first; scoped names keep their slash: /@scope/name/releases)",
      stagedPublishes: "POST /api/v1/staged-publishes/scan",
      publicationWatches:
        "GET/POST /api/v1/publication-watches; GET/DELETE /api/v1/publication-watches/:id; GET /api/v1/publication-watches/packages/:name; POST /api/v1/publication-watches/:id/check; POST /api/v1/publication-watches/:id/observations/:observationId/acknowledge (organization-scoped public npm publication monitoring)",
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
      authConfig:
        "GET /api/auth/config (anonymous; which optional sign-in methods are offered, and whether email verification can be enforced)",
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
app.route("/api/v1/packages", packagesRoutes);
app.route("/api/v1/publication-watches", npmPublicationWatchRoutes);
app.route("/api/v1/npm-package-claims", npmPackageClaimRoutes);
app.route("/api/v1/slack", slackRoutes);
app.route("/api/v1/staged-publishes", stagedPublishesRoutes);
app.route("/api/v1/audit-events", auditRoutes);

app.notFound(staticAssetFallback);

app.onError(handleAppError);

// The Worker's three entry points. `scheduled` and `queue` live in their own
// modules; wrangler.jsonc keeps this file as `main`.
export default { fetch: app.fetch, scheduled, queue };
