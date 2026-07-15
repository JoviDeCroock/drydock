import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  githubWorkflowGates,
  npmConnections,
  organizationMilestones,
  organizations,
  scans,
} from "./schema";
import { emitOperationalEvent } from "../lib/observability";
import { currentTelemetryContext } from "../lib/telemetry/context";

export const ORGANIZATION_MILESTONES = [
  "organization_created",
  "integration_validated",
  "artifact_observed",
  "review_completed",
  "protected_release_completed",
] as const;

export type OrganizationMilestone = (typeof ORGANIZATION_MILESTONES)[number];

export async function recordOrganizationMilestone(
  db: AppDb,
  organizationId: string,
  milestone: OrganizationMilestone,
  occurredAt = new Date(),
) {
  await db
    .insert(organizationMilestones)
    .values({
      organizationId,
      milestone,
      firstAt: occurredAt,
      lastAt: occurredAt,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [organizationMilestones.organizationId, organizationMilestones.milestone],
      set: {
        firstAt: sql`min(${organizationMilestones.firstAt}, ${occurredAt.getTime()})`,
        lastAt: sql`max(${organizationMilestones.lastAt}, ${occurredAt.getTime()})`,
        count: sql`${organizationMilestones.count} + 1`,
      },
    });
  if (currentTelemetryContext().requestId) {
    emitOperationalEvent("info", "organization.milestone.recorded", {
      organizationId,
      milestone,
    });
  }
}

export async function listOrganizationMilestones(db: AppDb, organizationId: string) {
  return db
    .select({
      milestone: organizationMilestones.milestone,
      firstAt: organizationMilestones.firstAt,
      lastAt: organizationMilestones.lastAt,
      count: organizationMilestones.count,
    })
    .from(organizationMilestones)
    .where(eq(organizationMilestones.organizationId, organizationId))
    .orderBy(asc(organizationMilestones.firstAt));
}

export async function hasOrganizationMilestone(
  db: AppDb,
  organizationId: string,
  milestone: OrganizationMilestone,
) {
  const [row] = await db
    .select({ count: organizationMilestones.count })
    .from(organizationMilestones)
    .where(
      and(
        eq(organizationMilestones.organizationId, organizationId),
        eq(organizationMilestones.milestone, milestone),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// Daily reconciliation makes the projection deploy-safe for existing tenants
// and repairs missed domain writes from exact durable state. Validation history
// cannot be reconstructed from the one current connection row, so that query
// inserts a missing milestone but never overwrites a richer live count.
export async function reconcileOrganizationMilestones(db: AppDb) {
  const results = await db.batch([
    db.run(sql`
      insert into ${organizationMilestones}
        (organization_id, milestone, first_at, last_at, count)
      select ${organizations.id}, 'organization_created', ${organizations.createdAt},
        ${organizations.createdAt}, 1
      from ${organizations}
      where true
      on conflict (organization_id, milestone) do update set
        first_at = excluded.first_at,
        last_at = excluded.last_at,
        count = excluded.count
    `),
    db.run(sql`
      insert into ${organizationMilestones}
        (organization_id, milestone, first_at, last_at, count)
      select ${npmConnections.organizationId}, 'integration_validated',
        min(${npmConnections.validatedAt}), max(${npmConnections.validatedAt}), 1
      from ${npmConnections}
      where ${npmConnections.validationStatus} = 'valid'
        and ${npmConnections.validatedAt} is not null
      group by ${npmConnections.organizationId}
      on conflict (organization_id, milestone) do nothing
    `),
    db.run(sql`
      insert into ${organizationMilestones}
        (organization_id, milestone, first_at, last_at, count)
      select ${scans.organizationId}, 'artifact_observed', min(${scans.completedAt}),
        max(${scans.completedAt}), count(*)
      from ${scans}
      where ${scans.status} = 'complete'
        and ${scans.organizationId} is not null
        and ${scans.completedAt} is not null
      group by ${scans.organizationId}
      on conflict (organization_id, milestone) do update set
        first_at = excluded.first_at,
        last_at = excluded.last_at,
        count = excluded.count
    `),
    db.run(sql`
      insert into ${organizationMilestones}
        (organization_id, milestone, first_at, last_at, count)
      select ${scans.organizationId}, 'review_completed', min(${scans.completedAt}),
        max(${scans.completedAt}), count(*)
      from ${scans}
      where ${scans.status} = 'complete'
        and ${scans.organizationId} is not null
        and ${scans.completedAt} is not null
      group by ${scans.organizationId}
      on conflict (organization_id, milestone) do update set
        first_at = excluded.first_at,
        last_at = excluded.last_at,
        count = excluded.count
    `),
    db.run(sql`
      insert into ${organizationMilestones}
        (organization_id, milestone, first_at, last_at, count)
      select protected.organization_id, 'protected_release_completed',
        min(protected.occurred_at), max(protected.occurred_at), count(*)
      from (
        select ${scans.organizationId} as organization_id,
          coalesce(${scans.protectedReleaseRecordedAt}, ${scans.decidedAt}) as occurred_at
        from ${scans}
        where ${scans.source} <> 'workflow_gate'
          and ${scans.decision} is not null
          and ${scans.organizationId} is not null
          and ${scans.decidedAt} is not null
        union all
        select ${githubWorkflowGates.organizationId} as organization_id,
          ${githubWorkflowGates.callbackDeliveredAt} as occurred_at
        from ${githubWorkflowGates}
        where ${githubWorkflowGates.callbackDeliveredAt} is not null
      ) protected
      group by protected.organization_id
      on conflict (organization_id, milestone) do update set
        first_at = excluded.first_at,
        last_at = excluded.last_at,
        count = excluded.count
    `),
  ]);
  const rows = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
  if (currentTelemetryContext().requestId) {
    emitOperationalEvent("info", "organization.milestones.reconciled", { rows });
  }
  return rows;
}
