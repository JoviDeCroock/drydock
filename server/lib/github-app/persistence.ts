import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import {
  dependencyReviews,
  githubAppInstallations,
  githubReleaseTargets,
  githubWorkflowGates,
  publisherSetupJobs,
  scanEvents,
} from "../../db/schema";
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
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseTargetRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  // Null means "auto-detect the ecosystem from the uploaded artifacts" so one
  // gate can cover every package a monorepo publishes from the environment.
  ecosystem: SupportedEcosystem | null;
  // Null inspects every non-expired workflow artifact; non-null narrows to one
  // GitHub Actions artifact name.
  artifactName: string | null;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  // Who mapped the target. Null once that user leaves the organization, which
  // is why the discovery sweep falls back to the organization owner.
  createdByUserId: string | null;
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
      // Moving it is `transferInstallation`'s job, after the ownership check.
      throw new GithubAppValidationError(
        "installation_conflict",
        `installation ${input.installationId} is already linked to a different organization`,
      );
    }
    await db
      .update(githubAppInstallations)
      .set({
        accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        status: input.status,
        suspendedAt: input.status === "suspended" ? now : null,
        uninstalledAt: input.status === "uninstalled" ? now : null,
        updatedAt: now,
      })
      .where(eq(githubAppInstallations.id, existing.id));
    return readInstallationRow({
      ...existing,
      accountLogin,
      accountType: input.accountType,
      targetType: input.targetType,
      status: input.status,
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
    createdAt: now,
    updatedAt: now,
  };
}

export interface TransferInstallationInput {
  installationRowId: string;
  fromOrganizationId: string;
  toOrganizationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  createdByUserId: string;
  /** The GitHub owner whose verified authorization moved the installation. */
  githubLogin: string;
}

/**
 * Moves an installation to another organization after its GitHub owner proved
 * ownership. One D1 batch re-points the row and strips the previous
 * organization of everything bound to it, so nothing it still holds can gate,
 * decide, review, or open PRs through the installation:
 *  - release targets and their workflow gates (pending ones included) go;
 *    GitHub keeps a pending deployment waiting until the new owner maps the
 *    environment and re-runs it, or GitHub times it out;
 *  - dependency reviews go, because they are keyed by installation row and
 *    the new organization's reviews of the same commits would match them;
 *  - publisher setup jobs fail and expire, so the cron prunes their private
 *    payloads; a running job also rechecks installation ownership before any
 *    GitHub write.
 * Both organizations get an audit event, written only when the row was still
 * the previous organization's at commit time.
 */
export async function transferInstallation(
  db: AppDb,
  input: TransferInstallationInput,
): Promise<InstallationRecord> {
  const now = new Date();
  const accountLogin = input.accountLogin.slice(0, ACCOUNT_LOGIN_MAX);
  const rowOwnedByPrevious = sql`${githubAppInstallations.id} = ${input.installationRowId}
    and ${githubAppInstallations.organizationId} = ${input.fromOrganizationId}`;
  const fromSetupJobs = and(
    eq(publisherSetupJobs.organizationId, input.fromOrganizationId),
    eq(publisherSetupJobs.installationRowId, input.installationRowId),
  );
  const [, , , , updated] = await db.batch([
    transferEventStatement(db, now, rowOwnedByPrevious, {
      organizationId: input.fromOrganizationId,
      actorUserId: null,
      type: "github_app_installation.moved_away",
      metadata: { accountLogin, githubLogin: input.githubLogin },
    }),
    transferEventStatement(db, now, rowOwnedByPrevious, {
      organizationId: input.toOrganizationId,
      actorUserId: input.createdByUserId,
      type: "github_app_installation.moved_here",
      metadata: { accountLogin, githubLogin: input.githubLogin },
    }),
    db
      .delete(githubWorkflowGates)
      .where(
        and(
          eq(githubWorkflowGates.organizationId, input.fromOrganizationId),
          eq(githubWorkflowGates.installationRowId, input.installationRowId),
        ),
      ),
    db
      .delete(githubReleaseTargets)
      .where(
        and(
          eq(githubReleaseTargets.organizationId, input.fromOrganizationId),
          eq(githubReleaseTargets.installationRowId, input.installationRowId),
        ),
      ),
    db
      .update(githubAppInstallations)
      .set({
        organizationId: input.toOrganizationId,
        accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        status: input.status,
        suspendedAt: input.status === "suspended" ? now : null,
        uninstalledAt: input.status === "uninstalled" ? now : null,
        createdByUserId: input.createdByUserId,
        updatedAt: now,
      })
      .where(rowOwnedByPrevious)
      .returning(),
    db
      .delete(dependencyReviews)
      .where(
        and(
          eq(dependencyReviews.organizationId, input.fromOrganizationId),
          eq(dependencyReviews.installationRowId, input.installationRowId),
        ),
      ),
    db
      .update(publisherSetupJobs)
      .set({
        status: "failed",
        failureJson: {
          code: "installation_moved",
          message: "The GitHub App installation moved to another organization.",
        },
      })
      .where(and(fromSetupJobs, inArray(publisherSetupJobs.status, ["queued", "running"]))),
    db.update(publisherSetupJobs).set({ expiresAt: now, updatedAt: now }).where(fromSetupJobs),
  ]);
  const row = updated[0];
  if (!row) {
    throw new GithubAppValidationError(
      "installation_conflict",
      "the installation changed organization while it was being linked; try again",
    );
  }
  return readInstallationRow(row);
}

function transferEventStatement(
  db: AppDb,
  now: Date,
  guard: SQL,
  event: {
    organizationId: string;
    actorUserId: string | null;
    type: string;
    metadata: Record<string, unknown>;
  },
) {
  return db.insert(scanEvents).select(
    sql`select ${crypto.randomUUID()}, ${event.organizationId}, ${event.actorUserId}, null,
      ${event.type}, ${JSON.stringify(event.metadata)}, ${now.getTime()}
      from ${githubAppInstallations} where ${guard}`,
  );
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

async function getInstallationForOrganization(
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

/**
 * The GitHub installation id behind one of our installation rows, scoped to
 * the organization so a gate can never post a decision through another
 * organization's installation.
 */
export async function getInstallationExternalId(
  db: AppDb,
  installationRowId: string,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ installationId: githubAppInstallations.installationId })
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, installationRowId),
        eq(githubAppInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.installationId ?? null;
}

export async function markInstallationStatus(
  db: AppDb,
  installationId: string,
  status: InstallationStatus,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubAppInstallations)
    .set({
      status,
      suspendedAt: status === "suspended" ? now : null,
      uninstalledAt: status === "uninstalled" ? now : null,
      updatedAt: now,
    })
    .where(eq(githubAppInstallations.installationId, installationId));
}

export interface CreateReleaseTargetInput {
  organizationId: string;
  installationRowId: string;
  /** Null = auto-detect the ecosystem from the uploaded artifacts. */
  ecosystem: SupportedEcosystem | null;
  /** Optional narrowing override for the GitHub Actions artifact name. */
  artifactName?: string | null;
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
  const artifactName = normalizeArtifactName(input.artifactName);
  try {
    await db.insert(githubReleaseTargets).values({
      id,
      organizationId: input.organizationId,
      installationRowId: input.installationRowId,
      ecosystem: input.ecosystem,
      artifactName,
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
    artifactName,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    environment,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeArtifactName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readReleaseTargetRow(row: {
  id: string;
  organizationId: string;
  installationRowId: string;
  ecosystem: string | null;
  artifactName: string | null;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  createdByUserId: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): ReleaseTargetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    ecosystem: row.ecosystem === null ? null : (row.ecosystem as SupportedEcosystem),
    artifactName: row.artifactName,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    environment: row.environment,
    createdByUserId: row.createdByUserId,
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
