/**
 * Installing the GitHub App and browsing what it can see.
 *
 * The install handshake (redirect + OAuth callback) and the read-only proxies
 * a maintainer uses to pick a repository and environment. The proxies are
 * separately rate limited: they spend the installation's GitHub API budget on
 * behalf of a browser.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { RateLimitError, enforceRateLimit } from "../../lib/platform/rate-limit";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../../lib/auth/roles";
import { rateLimitResponse } from "../../lib/platform/http";
import {} from "../../lib/platform/execution-context";
import { recordProductEvent } from "../../lib/platform/analytics";
import {} from "../../lib/workflow-gate-job";
import {
  fetchInstallationMetadata,
  listInstallationRepositories,
  listRepositoryEnvironments,
} from "../../lib/github-app/api";
import {
  type GithubAppConfig,
  isGithubAppConfigured,
  readGithubAppConfig,
} from "../../lib/github-app/config";
import {
  buildInstallUrl,
  signOAuthState,
  verifyOAuthState,
  verifyUserCanAccessInstallation,
} from "../../lib/github-app/oauth";
import {
  type InstallationRecord,
  listInstallationsForOrganization,
  upsertInstallation,
} from "../../lib/github-app/persistence";
import {} from "../../lib/github-app/webhook-gates";
import type { Bindings, Variables } from "../../types";
import { ensureInstallationOwnedBy, configErrorResponse, validationErrorResponse } from "./shared";

export const installationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const GITHUB_APP_PROXY_LIMIT = 60;
const GITHUB_APP_PROXY_WINDOW_MS = 60 * 1000;

installationRoutes.get("/config", (c) => {
  const configured = isGithubAppConfigured(c.env);
  if (!configured) {
    return c.json({ configured: false });
  }
  const config = readGithubAppConfig(c.env);
  return c.json({ configured: true, appSlug: config.appSlug });
});

installationRoutes.post("/install", async (c) => {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return configErrorResponse(c, err);
  }
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  try {
    await enforceRateLimit(c.env, {
      key: `github-app:install:${organizationId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "install rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const state = await signOAuthState(config.stateSecret, {
    organizationId,
    userId: session.userId,
  });
  const installUrl = buildInstallUrl(config, state);
  return c.json({ installUrl, state, expiresInSeconds: 15 * 60 });
});

installationRoutes.post("/install/callback", async (c) => {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return configErrorResponse(c, err);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    state?: unknown;
    code?: unknown;
    installationId?: unknown;
    setupAction?: unknown;
  };
  const state = typeof body.state === "string" ? body.state.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const installationId = typeof body.installationId === "string" ? body.installationId.trim() : "";
  const setupAction =
    typeof body.setupAction === "string" ? body.setupAction.trim().toLowerCase() : "install";

  if (!state) return c.json({ error: "state is required" }, 400);
  if (!code) return c.json({ error: "code is required" }, 400);
  if (!installationId) return c.json({ error: "installationId is required" }, 400);
  if (!/^\d+$/.test(installationId)) {
    return c.json({ error: "installationId must be the numeric GitHub installation id" }, 400);
  }

  const claims = await verifyOAuthState(config.stateSecret, state);
  if (!claims) {
    return c.json({ error: "state token is invalid or expired" }, 400);
  }
  const session = c.get("authSession");
  if (claims.userId !== session.userId) {
    return c.json({ error: "state token does not belong to this user" }, 403);
  }

  const db = createDb(c.env.DB);
  // Confirm the caller still has access to the org the state was issued for.
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (organizationId !== claims.organizationId) {
    return c.json({ error: "state token does not match active organization" }, 403);
  }
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await verifyUserCanAccessInstallation(config, { code, installationId });
    const metadata = await fetchInstallationMetadata(config, installationId);
    if (setupAction === "request" || metadata.installationId !== installationId) {
      return c.json({ error: "installation not yet active on GitHub" }, 409);
    }
    const record = await upsertInstallation(db, {
      organizationId,
      installationId: metadata.installationId,
      accountLogin: metadata.accountLogin,
      accountType: metadata.accountType,
      targetType: metadata.targetType,
      status: metadata.suspended ? "suspended" : "active",
      createdByUserId: session.userId,
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "github_app_installation.linked",
      metadata: {
        installationId: record.installationId,
        accountLogin: record.accountLogin,
        accountType: record.accountType,
        status: record.status,
      },
    });
    recordProductEvent(c.env, {
      name: "integration.connected",
      organizationId,
      kind: "github",
      outcome: record.status,
    });
    return c.json({ installation: publicInstallation(record) }, 201);
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

installationRoutes.get("/installations", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const installations = await listInstallationsForOrganization(db, organizationId);
  return c.json({ installations: installations.map(publicInstallation) });
});

installationRoutes.get("/installations/:installationRowId/repositories", async (c) => {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return configErrorResponse(c, err);
  }
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const installationRowId = c.req.param("installationRowId");
  try {
    const installation = await ensureInstallationOwnedBy(db, organizationId, installationRowId);
    try {
      await enforceRateLimit(c.env, {
        key: `github-app:repositories:${organizationId}:${installation.id}`,
        limit: GITHUB_APP_PROXY_LIMIT,
        windowMs: GITHUB_APP_PROXY_WINDOW_MS,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return rateLimitResponse(c, "GitHub repository lookup rate limit exceeded", err);
      }
      throw err;
    }
    const repositories = await listInstallationRepositories(config, installation.installationId);
    return c.json({
      repositories: repositories.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch ?? null,
      })),
    });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

installationRoutes.get(
  "/installations/:installationRowId/repositories/:owner/:repo/environments",
  async (c) => {
    let config: GithubAppConfig;
    try {
      config = readGithubAppConfig(c.env);
    } catch (err) {
      return configErrorResponse(c, err);
    }
    const db = createDb(c.env.DB);
    const organizationId = await requireActiveOrganization(c, db);
    const installationRowId = c.req.param("installationRowId");
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    if (!owner || !repo) {
      return c.json({ error: "owner and repo are required" }, 400);
    }
    try {
      const installation = await ensureInstallationOwnedBy(db, organizationId, installationRowId);
      try {
        await enforceRateLimit(c.env, {
          key: `github-app:environments:${organizationId}:${installation.id}:${owner}/${repo}`,
          limit: GITHUB_APP_PROXY_LIMIT,
          windowMs: GITHUB_APP_PROXY_WINDOW_MS,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          return rateLimitResponse(c, "GitHub environment lookup rate limit exceeded", err);
        }
        throw err;
      }
      const environments = await listRepositoryEnvironments(
        config,
        installation.installationId,
        `${owner}/${repo}`,
      );
      return c.json({
        environments: environments.map((environment) => ({ name: environment.name })),
      });
    } catch (err) {
      return validationErrorResponse(c, err);
    }
  },
);

function publicInstallation(record: InstallationRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    installationId: record.installationId,
    accountLogin: record.accountLogin,
    accountType: record.accountType,
    targetType: record.targetType,
    status: record.status,
    installedAt: record.installedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
