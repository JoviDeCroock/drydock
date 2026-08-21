/**
 * Release targets: the repo/environment pairs Drydock gates.
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
import {} from "../../lib/platform/execution-context";
import {} from "../../lib/workflow-gate-job";
import { fetchRepository } from "../../lib/github-app/api";
import {
  type GithubAppConfig,
  SUPPORTED_ECOSYSTEMS,
  type SupportedEcosystem,
  readGithubAppConfig,
} from "../../lib/github-app/config";
import {} from "../../lib/github-app/oauth";
import {
  type ReleaseTargetRecord,
  createReleaseTarget,
  deleteReleaseTarget,
  listReleaseTargetsForOrganization,
} from "../../lib/github-app/persistence";
import {} from "../../lib/github-app/webhook-gates";
import type { Bindings, Variables } from "../../types";
import { ensureInstallationOwnedBy, configErrorResponse, validationErrorResponse } from "./shared";

export const releaseTargetRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

releaseTargetRoutes.get("/release-targets", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const targets = await listReleaseTargetsForOrganization(db, organizationId);
  return c.json({ releaseTargets: targets.map(publicReleaseTarget) });
});

releaseTargetRoutes.post("/release-targets", async (c) => {
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
    await enforceRateLimit(c.env, {
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

releaseTargetRoutes.delete("/release-targets/:id", async (c) => {
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
