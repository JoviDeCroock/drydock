import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  dependencyReviewSettings,
  githubAppInstallations,
  githubReleaseTargets,
  githubWorkflowGates,
  scans,
  protectionHealth,
} from "./schema";
import { isRecord } from "../lib/platform/guards";
import {
  PROTECTION_HEALTH_FRESH_MS,
  PROTECTION_HEALTH_INTERVAL_MS,
  PROTECTION_HEALTH_LEASE_MS,
  protectionHealthStatus,
  type ProtectionHealthSnapshot,
  type ProtectionHealthTarget,
} from "../lib/github-app/protection-health-types";

const projection = {
  target: githubReleaseTargets,
  installation: githubAppInstallations,
  health: protectionHealth,
  dependencySettings: dependencyReviewSettings,
};
export async function listProtectionHealthRows(
  db: AppDb,
  organizationId?: string,
  dueAt?: Date,
  limit?: number,
) {
  const query = db
    .select(projection)
    .from(githubReleaseTargets)
    .innerJoin(
      githubAppInstallations,
      and(
        eq(githubAppInstallations.id, githubReleaseTargets.installationRowId),
        eq(githubAppInstallations.organizationId, githubReleaseTargets.organizationId),
      ),
    )
    .leftJoin(
      protectionHealth,
      and(
        eq(protectionHealth.releaseTargetId, githubReleaseTargets.id),
        eq(protectionHealth.organizationId, githubReleaseTargets.organizationId),
      ),
    )
    .leftJoin(
      dependencyReviewSettings,
      eq(dependencyReviewSettings.organizationId, githubReleaseTargets.organizationId),
    )
    .where(
      and(
        organizationId ? eq(githubReleaseTargets.organizationId, organizationId) : undefined,
        dueAt
          ? and(
              or(isNull(protectionHealth.nextCheckAt), lte(protectionHealth.nextCheckAt, dueAt)),
              or(isNull(protectionHealth.leaseUntil), lte(protectionHealth.leaseUntil, dueAt)),
            )
          : undefined,
      ),
    )
    .orderBy(sql`coalesce(${protectionHealth.nextCheckAt}, 0)`, githubReleaseTargets.id);
  return limit === undefined ? query : query.limit(limit);
}
export type ProtectionHealthRow = Awaited<ReturnType<typeof listProtectionHealthRows>>[number];
export async function getProtectionHealthRow(
  db: AppDb,
  organizationId: string,
  targetId: string,
): Promise<ProtectionHealthRow | null> {
  const [row] = await db
    .select(projection)
    .from(githubReleaseTargets)
    .innerJoin(
      githubAppInstallations,
      and(
        eq(githubAppInstallations.id, githubReleaseTargets.installationRowId),
        eq(githubAppInstallations.organizationId, githubReleaseTargets.organizationId),
      ),
    )
    .leftJoin(
      protectionHealth,
      and(
        eq(protectionHealth.releaseTargetId, githubReleaseTargets.id),
        eq(protectionHealth.organizationId, githubReleaseTargets.organizationId),
      ),
    )
    .leftJoin(
      dependencyReviewSettings,
      eq(dependencyReviewSettings.organizationId, githubReleaseTargets.organizationId),
    )
    .where(
      and(
        eq(githubReleaseTargets.organizationId, organizationId),
        eq(githubReleaseTargets.id, targetId),
      ),
    )
    .limit(1);
  return row ?? null;
}
function readSnapshot(value: string | null | undefined): ProtectionHealthSnapshot {
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (
      isRecord(data) &&
      (data.defaultBranch === null || typeof data.defaultBranch === "string") &&
      Array.isArray(data.checks) &&
      data.checks.length <= 12 &&
      data.checks.every(
        (check) =>
          isRecord(check) &&
          typeof check.id === "string" &&
          typeof check.label === "string" &&
          typeof check.detail === "string" &&
          ["passed", "failed", "unknown"].includes(String(check.status)),
      )
    )
      return data as unknown as ProtectionHealthSnapshot;
  } catch {
    /* Legacy or malformed saved evidence is never a passing observation. */
  }
  return { defaultBranch: null, checks: [] };
}
export function storedProtectionHealthStatus(row: ProtectionHealthRow) {
  return protectionHealthStatus(readSnapshot(row.health?.snapshotJson).checks);
}
export function publicProtectionHealth(
  row: ProtectionHealthRow,
  now = new Date(),
): ProtectionHealthTarget {
  const snapshot = readSnapshot(row.health?.snapshotJson);
  const checkedAt = row.health?.checkedAt ?? null;
  const stale =
    !checkedAt ||
    now.getTime() - checkedAt.getTime() > PROTECTION_HEALTH_FRESH_MS ||
    checkedAt < row.target.updatedAt ||
    checkedAt < row.installation.updatedAt ||
    Boolean(row.dependencySettings && checkedAt < row.dependencySettings.updatedAt);
  const checks =
    row.installation.status === "active"
      ? snapshot.checks
      : [
          {
            id: "installation-active",
            label: "GitHub App installation",
            status: "failed" as const,
            detail: `The installation is ${row.installation.status}; its mapped Environment and dependency checks are not currently verified.`,
          },
        ];
  if (
    row.dependencySettings?.enabled !== true &&
    !checks.some((entry) => entry.id === "dependency-review-enabled" && entry.status === "failed")
  )
    checks.push({
      id: "dependency-review-enabled",
      label: "Dependency review",
      status: "failed",
      detail: "Dependency review is currently disabled for this organization.",
    });
  return {
    ...snapshot,
    checks,
    releaseTargetId: row.target.id,
    repositoryFullName: row.target.repositoryFullName,
    environment: row.target.environment,
    checkedAt: checkedAt?.toISOString() ?? null,
    stale,
    status:
      row.installation.status !== "active" || row.dependencySettings?.enabled !== true
        ? "at_risk"
        : stale
          ? "unknown"
          : protectionHealthStatus(checks),
    scope: "mapped_environment_and_default_branch",
  };
}
export async function claimProtectionHealth(
  db: AppDb,
  row: ProtectionHealthRow,
  now: Date,
): Promise<string | null> {
  // Insert from the live target, so deleting a target cannot be undone by a late refresh.
  await db.run(sql`insert into protection_health (release_target_id, organization_id, next_check_at)
    select id, organization_id, ${now.getTime()} from github_release_targets where id = ${row.target.id} and organization_id = ${row.target.organizationId}
    on conflict(release_target_id) do nothing`);
  const leaseId = crypto.randomUUID();
  const [claimed] = await db
    .update(protectionHealth)
    .set({
      leaseId,
      leaseUntil: new Date(now.getTime() + PROTECTION_HEALTH_LEASE_MS),
      snapshotJson: null,
      checkedAt: null,
    })
    .where(
      and(
        eq(protectionHealth.releaseTargetId, row.target.id),
        eq(protectionHealth.organizationId, row.target.organizationId),
        or(isNull(protectionHealth.leaseUntil), lte(protectionHealth.leaseUntil, now)),
      ),
    )
    .returning({ id: protectionHealth.releaseTargetId });
  return claimed ? leaseId : null;
}
export async function saveProtectionHealth(
  db: AppDb,
  row: ProtectionHealthRow,
  leaseId: string,
  snapshot: ProtectionHealthSnapshot,
  now: Date,
): Promise<boolean> {
  const [saved] = await db
    .update(protectionHealth)
    .set({
      snapshotJson: JSON.stringify(snapshot),
      checkedAt: now,
      nextCheckAt: new Date(now.getTime() + PROTECTION_HEALTH_INTERVAL_MS),
      leaseId: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(protectionHealth.releaseTargetId, row.target.id),
        eq(protectionHealth.organizationId, row.target.organizationId),
        eq(protectionHealth.leaseId, leaseId),
        sql`exists (select 1 from github_release_targets t join github_app_installations i on i.id = t.installation_row_id
          where t.id = ${row.target.id} and t.organization_id = ${row.target.organizationId}
          and t.updated_at = ${row.target.updatedAt.getTime()} and t.repository_id = ${row.target.repositoryId}
          and t.repository_full_name = ${row.target.repositoryFullName} and t.environment = ${row.target.environment}
          and t.installation_row_id = ${row.target.installationRowId}
          and t.ecosystem is ${row.target.ecosystem} and t.artifact_name is ${row.target.artifactName}
          and i.status = ${row.installation.status} and i.updated_at = ${row.installation.updatedAt.getTime()})`,
        row.dependencySettings
          ? sql`exists (select 1 from dependency_review_settings s where s.organization_id = ${row.target.organizationId} and s.updated_at = ${row.dependencySettings.updatedAt.getTime()} and s.enabled = ${row.dependencySettings.enabled ? 1 : 0} and s.policy_json = ${row.dependencySettings.policyJson})`
          : sql`not exists (select 1 from dependency_review_settings s where s.organization_id = ${row.target.organizationId})`,
      ),
    )
    .returning({ id: protectionHealth.releaseTargetId });
  if (!saved)
    await db
      .update(protectionHealth)
      .set({ leaseId: null, leaseUntil: null, nextCheckAt: now })
      .where(
        and(
          eq(protectionHealth.releaseTargetId, row.target.id),
          eq(protectionHealth.organizationId, row.target.organizationId),
          eq(protectionHealth.leaseId, leaseId),
        ),
      );
  return Boolean(saved);
}

export async function latestReviewedWorkflowRun(
  db: AppDb,
  row: ProtectionHealthRow,
): Promise<number | null> {
  const [gate] = await db
    .select({ runId: githubWorkflowGates.runId })
    .from(githubWorkflowGates)
    .innerJoin(
      scans,
      and(
        eq(scans.gateId, githubWorkflowGates.id),
        eq(scans.organizationId, row.target.organizationId),
        eq(scans.status, "complete"),
        eq(scans.source, "workflow_gate"),
      ),
    )
    .where(
      and(
        eq(githubWorkflowGates.organizationId, row.target.organizationId),
        eq(githubWorkflowGates.releaseTargetId, row.target.id),
        eq(githubWorkflowGates.repositoryId, row.target.repositoryId),
        eq(githubWorkflowGates.status, "approved"),
        eq(githubWorkflowGates.decision, "approved"),
      ),
    )
    .orderBy(desc(githubWorkflowGates.requestedAt))
    .limit(1);
  return gate?.runId ?? null;
}
