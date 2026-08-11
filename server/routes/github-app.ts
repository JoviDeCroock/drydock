import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { organizationRequiresTwoFactorForReleaseDecisions } from "../db/organizations";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import { getScan, recordGatePackageDecision } from "../db/scans";
import { badgeLookupKey } from "../db/scan-share";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { userHasTwoFactor, verifyTotpStepUp } from "../lib/auth";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../lib/platform/execution-context";
import { purgePublicFeedCache, scanDistTag } from "../lib/public-feed";
import { recordProductEvent } from "../lib/platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import { scanArtifactReadBucket } from "../lib/scan/artifacts";
import {
  buildHumanDecisionComment,
  buildReportUrl,
  executeWorkflowGateJob,
} from "../lib/workflow-gate-job";
import {
  fetchInstallationMetadata,
  fetchRepository,
  listInstallationRepositories,
  listRepositoryEnvironments,
} from "../lib/github-app/api";
import {
  type GithubAppConfig,
  GithubAppConfigError,
  type GithubAppValidationCode,
  GithubAppValidationError,
  SUPPORTED_ECOSYSTEMS,
  type SupportedEcosystem,
  isGithubAppConfigured,
  readGithubAppConfig,
} from "../lib/github-app/config";
import {
  buildInstallUrl,
  signOAuthState,
  verifyOAuthState,
  verifyUserCanAccessInstallation,
} from "../lib/github-app/oauth";
import {
  type InstallationRecord,
  type ReleaseTargetRecord,
  createReleaseTarget,
  deleteReleaseTarget,
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
  upsertInstallation,
} from "../lib/github-app/persistence";
import {
  type GatePackageScan,
  type WorkflowGateRecord,
  getGateByScanId,
  getGateForOrganization,
  listGatePackageScans,
  markGateDecidedForPackageAggregate,
  resetGateReviewForRetry,
} from "../lib/github-app/webhook-gates";
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
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
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
    artifactName?: unknown;
    repositoryFullName?: unknown;
    environment?: unknown;
  };

  const installationRowId =
    typeof body.installationRowId === "string" ? body.installationRowId.trim() : "";
  // Null/"auto"/absent pins nothing: the runner auto-detects each package's
  // ecosystem from the uploaded artifacts (the monorepo-friendly default). A
  // non-empty string must name a supported ecosystem.
  const ecosystemRaw = typeof body.ecosystem === "string" ? body.ecosystem.trim() : "";
  const ecosystem: SupportedEcosystem | null =
    ecosystemRaw === "" || ecosystemRaw === "auto" ? null : (ecosystemRaw as SupportedEcosystem);
  const artifactName =
    typeof body.artifactName === "string" && body.artifactName.trim()
      ? body.artifactName.trim()
      : null;
  const repositoryFullName =
    typeof body.repositoryFullName === "string" ? body.repositoryFullName.trim() : "";
  const environment = typeof body.environment === "string" ? body.environment.trim() : "";

  if (!installationRowId) return c.json({ error: "installationRowId is required" }, 400);
  if (!repositoryFullName) return c.json({ error: "repositoryFullName is required" }, 400);
  if (!environment) return c.json({ error: "environment is required" }, 400);
  if (ecosystem !== null && !SUPPORTED_ECOSYSTEMS.includes(ecosystem)) {
    return c.json({ error: `unsupported ecosystem: ${ecosystem}` }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
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
      artifactName,
      repositoryId: repo.id,
      repositoryFullName: repo.fullName,
      environment,
      createdByUserId: session.userId,
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "github_app_release_target.created",
      metadata: {
        ecosystem: record.ecosystem ?? "auto",
        artifactName: record.artifactName,
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
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
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
  const packages = await listGatePackageScans(db, organizationId, gate.id);
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );
  return c.json({ gate: publicWorkflowGate(gate, packages, orgRequiresTwoFactor) });
});

// Record a maintainer's decision on one package of a gate and, once the whole
// release resolves, release or block the held GitHub Actions job.
//
// A monorepo gate fans out into one scan per package. Each call decides a single
// package (`scanId`): the per-package decision is persisted, then the gate is
// finalized only when the release as a whole resolves — `approved` once every
// package is approved, `rejected` the moment any one is rejected. Until then the
// gate stays pending and the held deployment waits.
//
// The aggregate CAS is the single transition out of `pending`, so a
// double-submit (or a race with the fail-closed artifact reject) returns 409.
// Posting the decision to GitHub is delegated to the gate job, which sees the
// now-decided gate and delivers its stored decision — either over the queue or
// inline when no queue is bound.
githubAppRoutes.post("/workflow-gates/:gateId/decision", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    comment: string;
    totpCode: string;
    scanId: string;
  }>;
  if (!GATE_DECISION_SET.has(body.decision as GateDecision)) {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }
  const decision = body.decision as GateDecision;
  const packageScanId = typeof body.scanId === "string" ? body.scanId.trim() : "";
  if (!packageScanId) {
    return c.json({ error: "scanId of the package being decided is required" }, 400);
  }
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

  // Org-wide policy: when on, the step-up below is mandatory for every member
  // and an unenrolled member cannot decide at all. Looked up once so every gate
  // returned from this handler carries a consistent flag for the dialog.
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );

  const gateId = c.req.param("gateId");
  const existing = await getGateForOrganization(db, organizationId, gateId);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: "gate has already been decided" }, 409);
  }

  // The decision targets one package scan that has reached a human decision
  // point. A completed review gives the maintainer the full diff; a failed
  // package can still be rejected by the human, or retried through the retry
  // endpoint before deciding. Approval additionally requires the batch to have
  // reached review-ready (`gate.scanId` attached), so a partial failed batch
  // cannot be approved as if every package had been reviewed.
  const scan = await getScan(db, packageScanId, organizationId);
  const scanReachedDecisionPoint =
    scan?.scan.status === "complete" || scan?.scan.status === "failed";
  if (
    !scan ||
    scan.scan.source !== "workflow_gate" ||
    scan.scan.gateId !== gateId ||
    !scanReachedDecisionPoint
  ) {
    return c.json({ error: "scanId is not a reviewable package of this gate" }, 409);
  }
  if (decision === "approved" && !existing.scanId) {
    const packages = await listGatePackageScans(db, organizationId, gateId);
    return c.json(
      {
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  // 2FA step-up. Releasing or blocking a held deployment is a high-trust action
  // — approval immediately releases the GitHub job and publishing proceeds via
  // Trusted Publishing/OIDC, which can't be reversed. So a maintainer who has
  // enrolled in two-factor auth must prove a *fresh* second factor here; an
  // existing session is not enough. On top of that, an org can require 2FA for
  // every release decision: then an unenrolled member is blocked outright (must
  // enroll first) and enrolled members still step up. With the policy off, only
  // enrolled members step up and others decide as before. This runs only after
  // the decision is confirmed actionable above, so a maintainer is never
  // prompted for a code (or blocked for enrollment) on a decision that would 409
  // anyway. (The staged-publish decision in scans.ts is an audit record only —
  // it never publishes or cancels anything — and deliberately never requires
  // this.)
  let twoFactorVerified = false;
  const userEnrolledInTwoFactor = await userHasTwoFactor(db, session.userId);
  if (orgRequiresTwoFactor && !userEnrolledInTwoFactor) {
    return c.json(
      {
        error:
          "your organization requires two-factor authentication to decide release gates — enable it in Settings, then try again",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  if (orgRequiresTwoFactor || userEnrolledInTwoFactor) {
    try {
      await enforceRateLimit(db, {
        key: `github-app:gate-decision-2fa:${session.userId}`,
        limit: 10,
        windowMs: 15 * 60 * 1000,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return rateLimitResponse(c, "too many two-factor attempts", err);
      }
      throw err;
    }
    const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
    if (!totpCode) {
      return c.json(
        { error: "two-factor verification required", code: "two_factor_required" },
        401,
      );
    }
    if (!(await verifyTotpStepUp(c.get("auth"), c.req.raw, totpCode))) {
      return c.json({ error: "invalid two-factor code", code: "two_factor_invalid" }, 401);
    }
    twoFactorVerified = true;
  }

  // Persist the per-package decision while the gate is still pending.
  // `recordGatePackageDecision` also writes the `scan.decided` audit event and
  // keeps the workbench decision filters consistent (approved → publish,
  // rejected → no_publish).
  const decidedPackage = await recordGatePackageDecision(
    db,
    {
      scanId: packageScanId,
      organizationId,
      gateId,
      actorUserId: session.userId,
      decision: decision === "approved" ? "publish" : "no_publish",
      reason: comment || null,
    },
    scanArtifactReadBucket(c.env),
    c.env,
  );
  if (!decidedPackage) {
    const current = await getGateForOrganization(db, organizationId, gateId);
    const currentPackages = await listGatePackageScans(db, organizationId, gateId);
    return c.json(
      {
        gate: current ? publicWorkflowGate(current, currentPackages, orgRequiresTwoFactor) : null,
        error:
          current?.status === "pending"
            ? "package has already been decided"
            : "gate has already been decided",
      },
      409,
    );
  }

  // A decision changes what a listed scan's cached badge and feed entry
  // assert ("reviewed · risk" → "approved"/"blocked"); drop both so the
  // change is not delayed by the colo TTL in at least this region. Same
  // canonical-origin purge as the staged decision route and (un)listing.
  if (decidedPackage.scan.publicFeedListedAt) {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      badgeLookupKey({
        source: decidedPackage.scan.source,
        packageName: decidedPackage.scan.packageName,
        summaryJson: decidedPackage.scan.summaryJson,
      }),
      // Gate scans carry no dist-tag today, so this resolves to the default
      // entry — passed explicitly so it stays correct if they ever do.
      scanDistTag(decidedPackage.scan.summaryJson),
    );
  }

  // Aggregate over every package: release only when all are approved; block the
  // moment any one is rejected.
  const packages = await listGatePackageScans(db, organizationId, gateId);
  const anyRejected = packages.some((pkg) => pkg.decision === "no_publish");
  const allApproved = packages.length > 0 && packages.every((pkg) => pkg.decision === "publish");
  if (!anyRejected && !allApproved) {
    // Other packages still need a decision; keep the deployment held.
    return c.json({ gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor) });
  }
  if (allApproved && !existing.scanId) {
    return c.json(
      {
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  const gateDecision: GateDecision = anyRejected ? "rejected" : "approved";
  const reportUrl = buildReportUrl(c.env, existing.scanId);
  const decided = await markGateDecidedForPackageAggregate(db, {
    gateId,
    organizationId,
    decision: gateDecision,
    comment: comment || buildHumanDecisionComment(gateDecision, reportUrl),
    reportUrl,
  });
  if (!decided) {
    // Lost a race to a concurrent finalize or a fail-closed artifact reject.
    const current = await getGateForOrganization(db, organizationId, gateId);
    return c.json(
      {
        gate: current ? publicWorkflowGate(current, packages, orgRequiresTwoFactor) : null,
        error: "gate has already been decided",
      },
      409,
    );
  }

  // Schedule delivery immediately after the CAS. Everything below is
  // bookkeeping; if it throws, the durable gate decision still has a path to
  // GitHub instead of getting stuck behind a future 409.
  const message = { kind: "workflow_gate" as const, organizationId, gateId };
  c.executionCtx.waitUntil(deliverGateDecisionJob(c, db, message));

  // Counted separately from the automatic block below, so approval rate stays
  // measurable against reviews instead of being diluted by auto-rejections.
  recordProductEvent(c.env, {
    name: "workflow_gate.decided",
    organizationId,
    surface: "human",
    decision: gateDecision,
    packageCount: packages.length,
  });

  try {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      scanId: decided.scanId,
      type:
        gateDecision === "approved"
          ? "github_workflow_gate.approved"
          : "github_workflow_gate.rejected",
      metadata: {
        gateId,
        decidedBy: "human",
        reportUrl,
        packageCount: packages.length,
        twoFactor: twoFactorVerified,
        twoFactorMethod: twoFactorVerified ? "totp" : null,
        twoFactorRequiredByOrg: orgRequiresTwoFactor,
      },
    });
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.decision_bookkeeping_failed", {
      organizationId,
      gateId,
      decision: gateDecision,
      error: describeOperationalError(err),
    });
  }

  return c.json({ gate: publicWorkflowGate(decided, packages, orgRequiresTwoFactor) });
});

// Re-run a failed workflow-gate review batch. The retry is intentionally scoped
// to pending gates whose package scans have no recorded decisions: once a human
// has accepted or rejected a package, retrying must not replace that decision.
githubAppRoutes.post("/workflow-gates/:gateId/retry", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(db, {
      key: `github-app:gate-retry:${organizationId}`,
      limit: 20,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "gate retry rate limit exceeded", err);
    }
    throw err;
  }

  const gateId = c.req.param("gateId");
  const existing = await getGateForOrganization(db, organizationId, gateId);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: "gate has already been decided" }, 409);
  }

  const reset = await resetGateReviewForRetry(db, { gateId, organizationId });
  const packages = await listGatePackageScans(db, organizationId, gateId);
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );
  if (!reset) {
    return c.json(
      {
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
        error: "gate review is not retryable",
      },
      409,
    );
  }

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId: existing.scanId,
    type: "github_workflow_gate.retry_requested",
    metadata: { gateId, packageCount: packages.length },
  });

  const message = { kind: "workflow_gate" as const, organizationId, gateId };
  c.executionCtx.waitUntil(runWorkflowGateJob(c, db, message));

  const gate = await getGateForOrganization(db, organizationId, gateId);
  return c.json(
    {
      gate: publicWorkflowGate(gate ?? existing, packages, orgRequiresTwoFactor),
      queued: Boolean(c.env.SCAN_QUEUE),
    },
    202,
  );
});

async function deliverGateDecisionJob(
  c: RouteContext,
  db: ReturnType<typeof createDb>,
  message: { kind: "workflow_gate"; organizationId: string; gateId: string },
) {
  await runWorkflowGateJob(c, db, message);
}

async function runWorkflowGateJob(
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
  await executeWorkflowGateJob(c.env, workerExecutionContext(c.executionCtx), message, db);
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
    // Null = auto-detect the ecosystem from the uploaded artifacts.
    ecosystem: record.ecosystem,
    artifactName: record.artifactName,
    repositoryId: record.repositoryId,
    repositoryFullName: record.repositoryFullName,
    environment: record.environment,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

// Excludes the deployment callback URL (and other GitHub-internal identifiers)
// so the credentialed egress target is never exposed to the browser. `packages`
// is one entry per distinct package the release publishes (a monorepo fans out
// into several); the gate releases only once every package is approved.
// `organizationRequiresTwoFactor` surfaces the org policy so the decision dialog
// can prompt for a code (or block an unenrolled member) before submitting,
// matching what the route enforces server-side.
function publicWorkflowGate(
  record: WorkflowGateRecord,
  packages: GatePackageScan[] = [],
  organizationRequiresTwoFactor = false,
) {
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
    organizationRequiresTwoFactor,
    packages: packages.map((pkg) => ({
      scanId: pkg.scanId,
      packageName: pkg.packageName,
      version: pkg.stagedVersion,
      status: pkg.status,
      releaseRisk: pkg.releaseRisk,
      decision: pkg.decision,
    })),
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
  emitOperationalEvent("error", "github_app.route_error", {
    error: describeOperationalError(err),
  });
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
    case "environment_already_mapped":
      return 409;
    case "environment_unmapped":
    case "unsupported_ecosystem":
    case "invalid_input":
      return 400;
  }
}
