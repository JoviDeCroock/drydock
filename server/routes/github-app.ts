import { Hono, type Context } from "hono";
import {
  RateLimitError,
  createDb,
  enforceRateLimit,
  recordScanDecision,
  recordScanEvent,
} from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { rateLimitResponse } from "../lib/http";
import { describeOperationalError, emitOperationalEvent } from "../lib/observability";
import {
  buildHumanDecisionComment,
  buildReportUrl,
  executeWorkflowGateJob,
} from "../lib/workflow-gate-job";
import {
  GithubAppConfigError,
  GithubAppValidationError,
  SUPPORTED_ECOSYSTEMS,
  type GithubAppConfig,
  type GithubAppValidationCode,
  type InstallationRecord,
  type ReleaseTargetRecord,
  type SupportedEcosystem,
  type WorkflowGateRecord,
  buildInstallUrl,
  createReleaseTarget,
  deleteReleaseTarget,
  fetchInstallationMetadata,
  fetchRepository,
  getGateByScanId,
  getGateForOrganization,
  isGithubAppConfigured,
  listInstallationRepositories,
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
  listRepositoryEnvironments,
  markGateDecided,
  readGithubAppConfig,
  signOAuthState,
  upsertInstallation,
  verifyUserCanAccessInstallation,
  verifyOAuthState,
} from "../lib/github-app";
import type { Bindings, Variables } from "../types";

type RouteContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export const githubAppRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const GITHUB_APP_PROXY_LIMIT = 60;
const GITHUB_APP_PROXY_WINDOW_MS = 60 * 1000;

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

githubAppRoutes.get("/installations/:installationRowId/repositories", async (c) => {
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
      await enforceRateLimit(db, {
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

githubAppRoutes.get(
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
        await enforceRateLimit(db, {
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

const GATE_DECISIONS = ["approved", "rejected"] as const;
type GateDecision = (typeof GATE_DECISIONS)[number];
const GATE_DECISION_SET = new Set<GateDecision>(GATE_DECISIONS);
const GATE_DECISION_COMMENT_MAX = 500;

githubAppRoutes.get("/workflow-gates/by-scan/:scanId", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const scanId = c.req.param("scanId");
  const gate = await getGateByScanId(db, organizationId, scanId);
  if (!gate) return c.json({ error: "not found" }, 404);
  return c.json({ gate: publicWorkflowGate(gate) });
});

// Record a maintainer's decision and release/block the GitHub Actions job.
// The CAS in `markGateDecided` is the single transition out of `pending`, so a
// double-submit (or a race with the fail-closed artifact reject) returns 409.
// Posting the decision to GitHub is delegated to the gate job, which sees the
// now-decided gate and delivers its stored decision — either over the queue or
// inline when no queue is bound.
githubAppRoutes.post("/workflow-gates/:gateId/decision", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    comment: string;
  }>;
  if (!GATE_DECISION_SET.has(body.decision as GateDecision)) {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }
  const decision = body.decision as GateDecision;
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (comment.length > GATE_DECISION_COMMENT_MAX) {
    return c.json({ error: `comment must be <= ${GATE_DECISION_COMMENT_MAX} characters` }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(db, {
      key: `github-app:gate-decision:${organizationId}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "gate decision rate limit exceeded", err);
    }
    throw err;
  }

  const gateId = c.req.param("gateId");
  const existing = await getGateForOrganization(db, organizationId, gateId);
  if (!existing) return c.json({ error: "not found" }, 404);

  const reportUrl = buildReportUrl(c.env, existing.scanId);
  const decided = await markGateDecided(db, {
    gateId,
    decision,
    comment: comment || buildHumanDecisionComment(decision, reportUrl),
    reportUrl,
  });
  if (!decided) {
    return c.json({ error: "gate has already been decided" }, 409);
  }

  // Schedule delivery immediately after the CAS. Everything below is
  // bookkeeping; if it throws, the durable gate decision still has a path to
  // GitHub instead of getting stuck behind a future 409.
  const message = { kind: "workflow_gate" as const, organizationId, gateId };
  c.executionCtx.waitUntil(deliverGateDecisionJob(c, db, message));

  // Mirror the decision onto the underlying scan so the workbench audit trail
  // and decision filters stay consistent (approved → publish, rejected →
  // no_publish). Best effort: only applies once the review scan is complete.
  try {
    if (decided.scanId) {
      await recordScanDecision(db, {
        scanId: decided.scanId,
        organizationId,
        actorUserId: session.userId,
        decision: decision === "approved" ? "publish" : "no_publish",
        reason: comment || null,
      });
    }

    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      scanId: decided.scanId,
      type:
        decision === "approved" ? "github_workflow_gate.approved" : "github_workflow_gate.rejected",
      metadata: { gateId, decidedBy: "human", reportUrl },
    });
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.decision_bookkeeping_failed", {
      organizationId,
      gateId,
      decision,
      error: describeOperationalError(err),
    });
  }

  return c.json({ gate: publicWorkflowGate(decided) });
});

async function deliverGateDecisionJob(
  c: RouteContext,
  db: ReturnType<typeof createDb>,
  message: { kind: "workflow_gate"; organizationId: string; gateId: string },
) {
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send(message);
      return;
    } catch {
      // Fall back to an inline redelivery attempt so a transient queue-send
      // failure after markGateDecided does not leave the GitHub job held.
    }
  }
  await executeWorkflowGateJob(c.env, c.executionCtx, message, db);
}

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

// Excludes the deployment callback URL (and other GitHub-internal identifiers)
// so the credentialed egress target is never exposed to the browser.
function publicWorkflowGate(record: WorkflowGateRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    releaseTargetId: record.releaseTargetId,
    repositoryFullName: record.repositoryFullName,
    environment: record.environment,
    runId: record.runId,
    status: record.status,
    decision: record.decision,
    decisionComment: record.decisionComment,
    reportUrl: record.reportUrl,
    scanId: record.scanId,
    failureReason: record.failureReason,
    requestedAt: record.requestedAt.toISOString(),
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
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
