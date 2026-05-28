import { Hono, type Context } from "hono";
import { RateLimitError, createDb, enforceRateLimit, recordScanEvent } from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import {
  GithubAppConfigError,
  GithubAppValidationError,
  SUPPORTED_ECOSYSTEMS,
  type GithubAppConfig,
  type GithubAppValidationCode,
  type InstallationRecord,
  type ReleaseTargetRecord,
  type SupportedEcosystem,
  buildInstallUrl,
  createReleaseTarget,
  deleteReleaseTarget,
  fetchInstallationMetadata,
  fetchRepository,
  isGithubAppConfigured,
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
  readGithubAppConfig,
  signOAuthState,
  upsertInstallation,
  verifyUserCanAccessInstallation,
  verifyOAuthState,
} from "../lib/github-app";
import type { Bindings, Variables } from "../types";

type RouteContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export const githubAppRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

githubAppRoutes.get("/config", (c) => {
  const configured = isGithubAppConfigured(c.env);
  if (!configured) {
    return c.json({ configured: false });
  }
  const config = readGithubAppConfig(c.env);
  return c.json({ configured: true, appSlug: config.appSlug });
});

githubAppRoutes.post("/install", async (c) => {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return configErrorResponse(c, err);
  }
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(db, {
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

githubAppRoutes.post("/install/callback", async (c) => {
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
  const organizationId = await requireActiveOrganization(c, db);
  if (organizationId !== claims.organizationId) {
    return c.json({ error: "state token does not match active organization" }, 403);
  }

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
    return c.json({ installation: publicInstallation(record) }, 201);
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

githubAppRoutes.get("/installations", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const installations = await listInstallationsForOrganization(db, organizationId);
  return c.json({ installations: installations.map(publicInstallation) });
});

githubAppRoutes.get("/release-targets", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const targets = await listReleaseTargetsForOrganization(db, organizationId);
  return c.json({ releaseTargets: targets.map(publicReleaseTarget) });
});

githubAppRoutes.post("/release-targets", async (c) => {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return configErrorResponse(c, err);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    installationRowId?: unknown;
    ecosystem?: unknown;
    packageName?: unknown;
    repositoryFullName?: unknown;
    workflowFilename?: unknown;
    environment?: unknown;
    pypiTrustedPublisherEnvironment?: unknown;
  };

  const installationRowId =
    typeof body.installationRowId === "string" ? body.installationRowId.trim() : "";
  const ecosystem =
    typeof body.ecosystem === "string" ? (body.ecosystem.trim() as SupportedEcosystem) : "pypi";
  const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
  const repositoryFullName =
    typeof body.repositoryFullName === "string" ? body.repositoryFullName.trim() : "";
  const workflowFilename =
    typeof body.workflowFilename === "string" ? body.workflowFilename.trim() : null;
  const environment = typeof body.environment === "string" ? body.environment.trim() : "";
  const pypiTrustedPublisherEnvironment =
    typeof body.pypiTrustedPublisherEnvironment === "string"
      ? body.pypiTrustedPublisherEnvironment.trim()
      : "";

  if (!installationRowId) return c.json({ error: "installationRowId is required" }, 400);
  if (!packageName) return c.json({ error: "packageName is required" }, 400);
  if (!repositoryFullName) return c.json({ error: "repositoryFullName is required" }, 400);
  if (!environment) return c.json({ error: "environment is required" }, 400);
  if (!pypiTrustedPublisherEnvironment) {
    return c.json({ error: "pypiTrustedPublisherEnvironment is required" }, 400);
  }
  if (!SUPPORTED_ECOSYSTEMS.includes(ecosystem)) {
    return c.json({ error: `unsupported ecosystem: ${ecosystem}` }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(db, {
      key: `github-app:release-target:${organizationId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "release target rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  try {
    const installation = await ensureInstallationOwnedBy(db, organizationId, installationRowId);
    const repo = await fetchRepository(config, installation.installationId, repositoryFullName);
    const record = await createReleaseTarget(db, {
      organizationId,
      installationRowId: installation.id,
      ecosystem,
      packageName,
      repositoryId: repo.id,
      repositoryFullName: repo.fullName,
      workflowFilename,
      environment,
      pypiTrustedPublisherEnvironment,
      createdByUserId: session.userId,
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "github_app_release_target.created",
      metadata: {
        ecosystem: record.ecosystem,
        packageName: record.packageName,
        repositoryFullName: record.repositoryFullName,
        repositoryId: record.repositoryId,
        environment: record.environment,
      },
    });
    return c.json({ releaseTarget: publicReleaseTarget(record) }, 201);
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

githubAppRoutes.delete("/release-targets/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const id = c.req.param("id");
  const removed = await deleteReleaseTarget(db, organizationId, id);
  if (!removed) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "github_app_release_target.deleted",
    metadata: { releaseTargetId: id },
  });
  return c.json({ ok: true });
});

async function ensureInstallationOwnedBy(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  installationRowId: string,
) {
  const installations = await listInstallationsForOrganization(db, organizationId);
  const match = installations.find((row) => row.id === installationRowId);
  if (!match) {
    throw new GithubAppValidationError(
      "installation_missing",
      "no GitHub App installation matches this organization",
    );
  }
  if (match.status !== "active") {
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation ${match.installationId} is ${match.status}`,
    );
  }
  return match;
}

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

function publicReleaseTarget(record: ReleaseTargetRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    installationRowId: record.installationRowId,
    ecosystem: record.ecosystem,
    packageName: record.packageName,
    repositoryId: record.repositoryId,
    repositoryFullName: record.repositoryFullName,
    workflowFilename: record.workflowFilename,
    environment: record.environment,
    pypiTrustedPublisherEnvironment: record.pypiTrustedPublisherEnvironment,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function configErrorResponse(c: RouteContext, err: unknown) {
  if (err instanceof GithubAppConfigError) {
    return c.json({ error: err.message, code: "github_app_not_configured" }, 503);
  }
  throw err;
}

function validationErrorResponse(c: RouteContext, err: unknown) {
  if (err instanceof GithubAppValidationError) {
    return c.json({ error: err.message, code: err.code }, statusForCode(err.code));
  }
  console.error("github app route error", err);
  return c.json({ error: "internal error" }, 500);
}

function statusForCode(code: GithubAppValidationCode): 400 | 403 | 404 | 409 {
  switch (code) {
    case "installation_missing":
      return 404;
    case "installation_not_authorized":
      return 403;
    case "installation_inactive":
      return 409;
    case "repository_not_accessible":
      return 403;
    case "package_already_mapped":
    case "environment_already_mapped":
      return 409;
    case "environment_mismatch":
    case "environment_unmapped":
    case "unsupported_ecosystem":
    case "invalid_input":
      return 400;
  }
}
