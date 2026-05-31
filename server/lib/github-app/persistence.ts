import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../db";
import { githubAppInstallations, githubReleaseTargets } from "../../db/schema";
import {
  ACCOUNT_LOGIN_MAX,
  GithubAppValidationError,
  type InstallationStatus,
  type SupportedEcosystem,
} from "./config";
import { normalizeGithubEnvironmentName, validateReleaseTargetShape } from "./validation";

export interface InstallationRecord {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  installedAt: Date;
  lastFailureReason: string | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseTargetRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  ecosystem: SupportedEcosystem;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertInstallationInput {
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  createdByUserId: string | null;
}

export async function upsertInstallation(
  db: AppDb,
  input: UpsertInstallationInput,
): Promise<InstallationRecord> {
  const now = new Date();
  const accountLogin = input.accountLogin.slice(0, ACCOUNT_LOGIN_MAX);
  const [existing] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, input.installationId))
    .limit(1);

  if (existing) {
    if (existing.organizationId !== input.organizationId) {
      throw new GithubAppValidationError(
        "installation_missing",
        `installation ${input.installationId} is already linked to a different organization`,
      );
    }
    const clearHealth =
      input.status === "active" && !isRepositoryScopedHealthFailure(existing.lastFailureReason);
    await db
      .update(githubAppInstallations)
      .set({
        accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        status: input.status,
        suspendedAt: input.status === "suspended" ? now : null,
        uninstalledAt: input.status === "uninstalled" ? now : null,
        lastFailureReason: clearHealth ? null : existing.lastFailureReason,
        lastFailureAt: clearHealth ? null : existing.lastFailureAt,
        updatedAt: now,
      })
      .where(eq(githubAppInstallations.id, existing.id));
    return readInstallationRow({
      ...existing,
      accountLogin,
      accountType: input.accountType,
      targetType: input.targetType,
      status: input.status,
      lastFailureReason: clearHealth ? null : existing.lastFailureReason,
      lastFailureAt: clearHealth ? null : existing.lastFailureAt,
      updatedAt: now,
    });
  }

  const id = crypto.randomUUID();
  await db.insert(githubAppInstallations).values({
    id,
    organizationId: input.organizationId,
    installationId: input.installationId,
    accountLogin,
    accountType: input.accountType,
    targetType: input.targetType,
    status: input.status,
    createdByUserId: input.createdByUserId,
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    organizationId: input.organizationId,
    installationId: input.installationId,
    accountLogin,
    accountType: input.accountType,
    targetType: input.targetType,
    status: input.status,
    installedAt: now,
    lastFailureReason: null,
    lastFailureAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listInstallationsForOrganization(
  db: AppDb,
  organizationId: string,
): Promise<InstallationRecord[]> {
  const rows = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.organizationId, organizationId));
  return rows.map(readInstallationRow);
}

export async function getInstallationByExternalId(
  db: AppDb,
  installationId: string,
): Promise<InstallationRecord | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);
  return row ? readInstallationRow(row) : null;
}

export async function getInstallationForOrganization(
  db: AppDb,
  organizationId: string,
  installationRowId: string,
): Promise<InstallationRecord | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, installationRowId),
        eq(githubAppInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? readInstallationRow(row) : null;
}

export async function markInstallationStatus(
  db: AppDb,
  installationId: string,
  status: InstallationStatus,
): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select({
      lastFailureReason: githubAppInstallations.lastFailureReason,
      lastFailureAt: githubAppInstallations.lastFailureAt,
    })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);
  const set: Record<string, unknown> = {
    status,
    suspendedAt: status === "suspended" ? now : null,
    uninstalledAt: status === "uninstalled" ? now : null,
    updatedAt: now,
  };
  if (status === "active") {
    const clearHealth = !isRepositoryScopedHealthFailure(existing?.lastFailureReason);
    set.lastFailureReason = clearHealth ? null : existing?.lastFailureReason;
    set.lastFailureAt = clearHealth ? null : existing?.lastFailureAt;
  }
  await db
    .update(githubAppInstallations)
    .set(set)
    .where(eq(githubAppInstallations.installationId, installationId));
}

/**
 * Record that a GitHub App installation failed during use (e.g. minting an
 * installation access token was rejected). The installation status is left
 * untouched — a transient auth failure should not flip an otherwise-active
 * install to inactive — but the reason is surfaced in the UI so the operator
 * can re-authorize. Keyed by the internal row id because the gate path already
 * resolves the installation record.
 */
export async function recordInstallationHealthFailure(
  db: AppDb,
  installationRowId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubAppInstallations)
    .set({ lastFailureReason: reason, lastFailureAt: now, updatedAt: now })
    .where(eq(githubAppInstallations.id, installationRowId));
}

/** Clear a recorded health failure after the installation works again. */
export async function clearInstallationHealth(db: AppDb, installationRowId: string): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ lastFailureReason: null, lastFailureAt: null, updatedAt: new Date() })
    .where(eq(githubAppInstallations.id, installationRowId));
}

const REPOSITORY_HEALTH_FAILURE_PREFIX = "Drydock's GitHub App can no longer access repository ";
const REPOSITORY_HEALTH_FAILURE_SUFFIX = " — check its repository access.";

function isRepositoryScopedHealthFailure(reason: string | null | undefined): boolean {
  return (
    typeof reason === "string" &&
    reason.startsWith(REPOSITORY_HEALTH_FAILURE_PREFIX) &&
    reason.endsWith(REPOSITORY_HEALTH_FAILURE_SUFFIX)
  );
}

export interface CreateReleaseTargetInput {
  organizationId: string;
  installationRowId: string;
  ecosystem: SupportedEcosystem;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  createdByUserId: string | null;
}

export async function createReleaseTarget(
  db: AppDb,
  input: CreateReleaseTargetInput,
): Promise<ReleaseTargetRecord> {
  validateReleaseTargetShape(input);
  const environment = normalizeGithubEnvironmentName(input.environment);
  const installation = await getInstallationForOrganization(
    db,
    input.organizationId,
    input.installationRowId,
  );
  if (!installation) {
    throw new GithubAppValidationError(
      "installation_missing",
      "no GitHub App installation matches this organization",
    );
  }
  if (installation.status !== "active") {
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation ${installation.installationId} is ${installation.status}`,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(githubReleaseTargets).values({
      id,
      organizationId: input.organizationId,
      installationRowId: input.installationRowId,
      ecosystem: input.ecosystem,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      environment,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (isUniqueEnvironmentConflict(err)) {
      throw new GithubAppValidationError(
        "environment_already_mapped",
        `a release target already exists for ${input.repositoryFullName} environment ${environment} in this organization`,
      );
    }
    throw err;
  }
  return {
    id,
    organizationId: input.organizationId,
    installationRowId: input.installationRowId,
    ecosystem: input.ecosystem,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    environment,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listReleaseTargetsForOrganization(
  db: AppDb,
  organizationId: string,
): Promise<ReleaseTargetRecord[]> {
  const rows = await db
    .select()
    .from(githubReleaseTargets)
    .where(eq(githubReleaseTargets.organizationId, organizationId));
  return rows.map(readReleaseTargetRow);
}

export async function deleteReleaseTarget(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .delete(githubReleaseTargets)
    .where(
      and(eq(githubReleaseTargets.id, id), eq(githubReleaseTargets.organizationId, organizationId)),
    )
    .returning({ id: githubReleaseTargets.id });
  return result.length > 0;
}

// ── Webhook resolution ───────────────────────────────────────────────────────

export interface ResolveDeploymentProtectionInput {
  installationId: string;
  repositoryId: number;
  environment: string;
}

export interface ResolvedDeploymentProtectionTarget {
  installation: InstallationRecord;
  releaseTarget: ReleaseTargetRecord;
}

/**
 * Given a `deployment_protection_rule` webhook payload, find the organization +
 * release-target it belongs to. Returns null when no mapping exists — the caller
 * decides whether that's a soft-fail (ignore unknown installs) or an error.
 */
export async function resolveDeploymentProtectionTarget(
  db: AppDb,
  input: ResolveDeploymentProtectionInput,
): Promise<ResolvedDeploymentProtectionTarget | null> {
  const installation = await getInstallationByExternalId(db, input.installationId);
  if (!installation) return null;
  if (installation.status !== "active") return null;
  const environment = normalizeGithubEnvironmentName(input.environment);
  if (!environment) return null;
  const rows = await db
    .select()
    .from(githubReleaseTargets)
    .where(
      and(
        eq(githubReleaseTargets.organizationId, installation.organizationId),
        eq(githubReleaseTargets.installationRowId, installation.id),
        eq(githubReleaseTargets.repositoryId, input.repositoryId),
        eq(githubReleaseTargets.environment, environment),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { installation, releaseTarget: readReleaseTargetRow(row) };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function readInstallationRow(row: {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: string;
  installedAt: Date | string | number;
  lastFailureReason?: string | null;
  lastFailureAt?: Date | string | number | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): InstallationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.targetType,
    status: normalizeInstallationStatus(row.status),
    installedAt: new Date(row.installedAt),
    lastFailureReason: row.lastFailureReason ?? null,
    lastFailureAt:
      row.lastFailureAt === null || row.lastFailureAt === undefined
        ? null
        : new Date(row.lastFailureAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readReleaseTargetRow(row: {
  id: string;
  organizationId: string;
  installationRowId: string;
  ecosystem: string;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): ReleaseTargetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    ecosystem: row.ecosystem as SupportedEcosystem,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    environment: row.environment,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function isUniqueEnvironmentConflict(err: unknown): boolean {
  return isUniqueConflict(
    err,
    "github_release_targets_org_repo_env_unique_idx",
    "github_release_targets.environment",
  );
}

function isUniqueConflict(err: unknown, indexName: string, columnName: string): boolean {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      current = null;
    }
  }
  const combined = messages.join(" | ");
  if (!/UNIQUE/i.test(combined)) return false;
  return (
    combined.includes(indexName) ||
    (combined.includes("github_release_targets.organization_id") && combined.includes(columnName))
  );
}

function normalizeInstallationStatus(value: string): InstallationStatus {
  if (value === "suspended" || value === "uninstalled" || value === "active") return value;
  return "active";
}
