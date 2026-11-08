import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import type { WorkflowGateStatus } from "../../db/enums";
import { githubWorkflowGates, scans } from "../../db/schema";
import {
  type GateReviewBinding,
  GATE_STALE_REVIEW_REASONS,
  type GateStaleReviewReason,
  readGateReviewBinding,
} from "../workflow-gates/review-binding";
import type { InstallationRecord, ReleaseTargetRecord } from "./persistence";
import type { ParsedDeploymentProtectionEvent } from "./webhook";

export interface WorkflowGateRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  releaseTargetId: string;
  deliveryId: string;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  runId: number;
  deploymentId: number | null;
  deploymentCallbackUrl: string;
  eventAction: string;
  status: WorkflowGateStatus;
  decision: "approved" | "rejected" | null;
  decisionComment: string | null;
  reportUrl: string | null;
  // Representative (highest-risk) package scan. A monorepo gate fans out into
  // several per-package scans (`scans.gate_id = this.id`); this points at the
  // one surfaced as the gate's headline.
  scanId: string | null;
  // CAS claim flipped once when a delivery starts the review batch, so a
  // concurrent re-delivery does not double-run the per-package scans.
  reviewStartedAt: Date | null;
  failureReason: string | null;
  /** The run attempt and artifacts the review batch saw; null until a batch claims the gate. */
  reviewBinding: GateReviewBinding | null;
  decisionDeliveredAt: Date | null;
  requestedAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RecordGateRequestInput {
  deliveryId: string;
  installation: InstallationRecord;
  releaseTarget: ReleaseTargetRecord;
  event: ParsedDeploymentProtectionEvent;
}

/**
 * Persist a pending gate after a `deployment_protection_rule.requested`
 * webhook. Returns the existing row for a delivery already recorded, or for
 * the same deployment arriving under another delivery id: the signature covers
 * only the body, so a resent body must not open a second gate.
 *
 * GitHub's callback is per run and Environment, not per attempt, so a newer
 * request for the same run and Environment (a re-run attempt) supersedes every
 * older pending gate for it; only the newest can release the job.
 */
export async function recordGateRequest(
  db: AppDb,
  input: RecordGateRequestInput,
): Promise<{ gate: WorkflowGateRecord; created: boolean }> {
  const existing = await getGateByDeliveryId(db, input.deliveryId);
  if (existing) return { gate: existing, created: false };
  const environment = input.event.environment.toLowerCase();
  const runKey = and(
    eq(githubWorkflowGates.installationRowId, input.installation.id),
    eq(githubWorkflowGates.repositoryId, input.event.repositoryId),
    eq(githubWorkflowGates.runId, input.event.runId),
    eq(githubWorkflowGates.environment, environment),
  );
  if (input.event.deploymentId !== null) {
    const [sameDeployment] = await db
      .select()
      .from(githubWorkflowGates)
      .where(and(runKey, eq(githubWorkflowGates.deploymentId, input.event.deploymentId)))
      .limit(1);
    if (sameDeployment) return { gate: readGateRow(sameDeployment), created: false };
  }

  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(githubWorkflowGates).values({
    id,
    organizationId: input.installation.organizationId,
    installationRowId: input.installation.id,
    releaseTargetId: input.releaseTarget.id,
    deliveryId: input.deliveryId,
    repositoryId: input.event.repositoryId,
    repositoryFullName: input.event.repositoryFullName,
    environment,
    runId: input.event.runId,
    deploymentId: input.event.deploymentId,
    deploymentCallbackUrl: input.event.deploymentCallbackUrl,
    eventAction: input.event.action,
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await supersedeOlderGateRequests(db, id, runKey);
  const fresh = await getGateByDeliveryId(db, input.deliveryId);
  if (!fresh) throw new Error("workflow gate row vanished immediately after insert");
  return { gate: fresh, created: true };
}

/**
 * Order two requests for one run and Environment: by deployment id when both
 * carry one (GitHub allocates them increasingly), else by arrival. Concurrent
 * deliveries agree on the order, so exactly the newest stays pending.
 */
function requestIsOlderThan(gateId: string) {
  const other = githubWorkflowGates;
  return sql`(
    select case
      when ${other.deploymentId} is not null and mine.deployment_id is not null
        then ${other.deploymentId} < mine.deployment_id
      else ${other.createdAt} < mine.created_at
        or (${other.createdAt} = mine.created_at and ${other.id} < mine.id)
    end
    from ${githubWorkflowGates} as mine
    where mine.id = ${gateId}
  )`;
}

async function supersedeOlderGateRequests(
  db: AppDb,
  gateId: string,
  runKey: ReturnType<typeof and>,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubWorkflowGates)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        runKey,
        ne(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.status, "pending"),
        requestIsOlderThan(gateId),
      ),
    );
  // A delayed delivery of an older attempt arrives after the newer one: it is
  // recorded (so a replay dedupes) but never reviewable.
  const newer = await db
    .select({ id: githubWorkflowGates.id })
    .from(githubWorkflowGates)
    .where(and(runKey, ne(githubWorkflowGates.id, gateId), sql`not ${requestIsOlderThan(gateId)}`))
    .limit(1);
  if (newer.length === 0) return;
  await db
    .update(githubWorkflowGates)
    .set({ status: "superseded", updatedAt: now })
    .where(and(eq(githubWorkflowGates.id, gateId), eq(githubWorkflowGates.status, "pending")));
}

export async function getGateByDeliveryId(
  db: AppDb,
  deliveryId: string,
): Promise<WorkflowGateRecord | null> {
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(eq(githubWorkflowGates.deliveryId, deliveryId))
    .limit(1);
  return row ? readGateRow(row) : null;
}

export async function getGateForOrganization(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<WorkflowGateRecord | null> {
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? readGateRow(row) : null;
}

/**
 * Resolve the gate a scan belongs to. A monorepo gate fans out into several
 * per-package scans, so the authoritative link is `scans.gate_id`; only the
 * representative scan is also reachable via `github_workflow_gates.scan_id`. We
 * resolve via `scans.gate_id` first and fall back to the representative pointer
 * for any pre-migration row that lacks a back-link.
 */
export async function getGateByScanId(
  db: AppDb,
  organizationId: string,
  scanId: string,
): Promise<WorkflowGateRecord | null> {
  const [scanRow] = await db
    .select({ gateId: scans.gateId })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (scanRow?.gateId) {
    return getGateForOrganization(db, organizationId, scanRow.gateId);
  }
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.scanId, scanId),
        eq(githubWorkflowGates.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? readGateRow(row) : null;
}

/** One per-package scan attached to a gate, as the gate decision aggregates them. */
export interface GatePackageScan {
  scanId: string;
  packageName: string | null;
  stagedVersion: string | null;
  risk: string;
  status: string;
  decision: string | null;
  releaseRisk: string | null;
}

/**
 * List every per-package scan attached to a gate (`scans.gate_id = gateId`),
 * oldest first. The gate decision is the aggregate over these: it releases the
 * held deployment only once every package is individually approved, and blocks
 * it the moment any one is rejected.
 */
export async function listGatePackageScans(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<GatePackageScan[]> {
  const rows = await db
    .select({
      scanId: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      risk: scans.risk,
      status: scans.status,
      decision: scans.decision,
      riskSummaryJson: scans.riskSummaryJson,
      createdAt: scans.createdAt,
    })
    .from(scans)
    .where(and(eq(scans.gateId, gateId), eq(scans.organizationId, organizationId)));
  return rows
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((row) => ({
      scanId: row.scanId,
      packageName: row.packageName,
      stagedVersion: row.stagedVersion,
      risk: row.risk,
      status: row.status,
      decision: row.decision,
      releaseRisk: readReleaseRisk(row.riskSummaryJson),
    }));
}

function readReleaseRisk(riskSummaryJson: unknown): string | null {
  if (!riskSummaryJson || typeof riskSummaryJson !== "object" || Array.isArray(riskSummaryJson)) {
    return null;
  }
  const value = (riskSummaryJson as { releaseRisk?: unknown }).releaseRisk;
  return typeof value === "string" ? value : null;
}

/**
 * CAS-claim the review batch for a gate. Returns true for exactly the first
 * delivery that flips `review_started_at` from null while the gate is still
 * pending; a concurrent re-delivery loses the claim and skips. A claim that is
 * never finalized (a delivery that fails mid-batch releases it via
 * `releaseGateReviewClaim`; a hard crash leaves the gate pending — safe, never
 * auto-approved). The claimer's own artifact listing becomes the gate's review
 * binding, so the binding always describes the batch that is reviewed.
 */
export async function claimGateReviewStart(
  db: AppDb,
  gateId: string,
  binding: GateReviewBinding,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(githubWorkflowGates)
    .set({
      reviewStartedAt: now,
      runAttempt: binding.runAttempt,
      reviewedArtifactsJson: {
        artifactName: binding.artifactName,
        artifactNamePrefix: binding.artifactNamePrefix,
        artifacts: binding.artifacts,
      },
      updatedAt: now,
    })
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.status, "pending"),
        isNull(githubWorkflowGates.reviewStartedAt),
      ),
    )
    .returning({ id: githubWorkflowGates.id });
  return updated.length > 0;
}

/**
 * Release a review-batch claim so a later delivery can retry. Only clears the
 * claim while the gate is still pending and no representative scan is attached,
 * so it can never reopen a gate that already reached a decision or a review.
 */
export async function releaseGateReviewClaim(db: AppDb, gateId: string): Promise<void> {
  const now = new Date();
  await db
    .update(githubWorkflowGates)
    .set({ reviewStartedAt: null, updatedAt: now })
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.status, "pending"),
        isNull(githubWorkflowGates.scanId),
      ),
    );
}

/**
 * Reopen a failed, still-pending review batch so the next gate job can discard
 * the failed package scans and re-run the whole set. This refuses to run once a
 * package decision has been recorded, because retrying would otherwise replace
 * already-reviewed package state — unless the review went stale (the run's
 * attempt or artifacts changed since it), when those decisions describe bytes
 * the job would no longer publish.
 */
export async function resetGateReviewForRetry(
  db: AppDb,
  input: { gateId: string; organizationId: string },
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(githubWorkflowGates)
    .set({
      scanId: null,
      reviewStartedAt: null,
      failureReason: null,
      runAttempt: null,
      reviewedArtifactsJson: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(githubWorkflowGates.id, input.gateId),
        eq(githubWorkflowGates.organizationId, input.organizationId),
        eq(githubWorkflowGates.status, "pending"),
        sql`(${staleReviewCondition()} or (
          exists (
            select 1
            from ${scans}
            where ${scans.gateId} = ${input.gateId}
              and ${scans.organizationId} = ${input.organizationId}
              and ${scans.status} = 'failed'
          )
          and not exists (
            select 1
            from ${scans}
            where ${scans.gateId} = ${input.gateId}
              and ${scans.organizationId} = ${input.organizationId}
              and ${scans.decision} is not null
          )
        ))`,
      ),
    )
    .returning({ id: githubWorkflowGates.id });
  return updated.length > 0;
}

export async function attachScanToGate(
  db: AppDb,
  gateId: string,
  scanId: string,
  expectedPreviousScanId?: string | null,
): Promise<boolean> {
  const now = new Date();
  const conditions = [
    eq(githubWorkflowGates.id, gateId),
    eq(githubWorkflowGates.status, "pending"),
  ];
  if (expectedPreviousScanId !== undefined) {
    conditions.push(
      expectedPreviousScanId === null
        ? isNull(githubWorkflowGates.scanId)
        : eq(githubWorkflowGates.scanId, expectedPreviousScanId),
    );
  }
  const updated = await db
    .update(githubWorkflowGates)
    .set({ scanId, updatedAt: now })
    .where(and(...conditions))
    .returning({ id: githubWorkflowGates.id });
  return updated.length > 0;
}

interface DecideGateInput {
  gateId: string;
  decision: "approved" | "rejected";
  comment: string;
  reportUrl?: string | null;
}

/**
 * Atomically transition a pending gate to `approved` or `rejected`. Returns
 * null if the gate was already decided (or never existed), so the caller can
 * skip re-posting to GitHub.
 */
export async function markGateDecided(
  db: AppDb,
  input: DecideGateInput,
): Promise<WorkflowGateRecord | null> {
  const now = new Date();
  const updated = await db
    .update(githubWorkflowGates)
    .set({
      status: input.decision,
      decision: input.decision,
      decisionComment: input.comment,
      reportUrl: input.reportUrl ?? null,
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(githubWorkflowGates.id, input.gateId), eq(githubWorkflowGates.status, "pending")))
    .returning({ id: githubWorkflowGates.id });
  if (updated.length === 0) return null;
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(eq(githubWorkflowGates.id, input.gateId))
    .limit(1);
  return row ? readGateRow(row) : null;
}

interface DecideGateWithPackageAggregateInput extends DecideGateInput {
  organizationId: string;
}

/**
 * Atomically finalize a pending gate only if the current per-package scan
 * decisions still justify that aggregate decision. This closes the race where a
 * sibling package decision changes between a route's in-memory aggregation and
 * the gate CAS.
 */
export async function markGateDecidedForPackageAggregate(
  db: AppDb,
  input: DecideGateWithPackageAggregateInput,
): Promise<WorkflowGateRecord | null> {
  const now = new Date();
  const packageDecisionCondition =
    input.decision === "approved"
      ? sql`exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${input.gateId}
            and ${scans.organizationId} = ${input.organizationId}
        )
        and not exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${input.gateId}
            and ${scans.organizationId} = ${input.organizationId}
            and (${scans.decision} is null or ${scans.decision} <> 'publish')
        )`
      : sql`exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${input.gateId}
            and ${scans.organizationId} = ${input.organizationId}
            and ${scans.decision} = 'no_publish'
        )`;
  const updated = await db
    .update(githubWorkflowGates)
    .set({
      status: input.decision,
      decision: input.decision,
      decisionComment: input.comment,
      reportUrl: input.reportUrl ?? null,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(githubWorkflowGates.id, input.gateId),
        eq(githubWorkflowGates.organizationId, input.organizationId),
        eq(githubWorkflowGates.status, "pending"),
        input.decision === "approved"
          ? sql`${githubWorkflowGates.scanId} is not null
              and ${githubWorkflowGates.runAttempt} is not null
              and not ${staleReviewCondition()}`
          : sql`1 = 1`,
        packageDecisionCondition,
      ),
    )
    .returning({ id: githubWorkflowGates.id });
  if (updated.length === 0) return null;
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(eq(githubWorkflowGates.id, input.gateId))
    .limit(1);
  return row ? readGateRow(row) : null;
}

function staleReviewCondition() {
  return sql`coalesce(${githubWorkflowGates.failureReason} in (${sql.join(
    GATE_STALE_REVIEW_REASONS.map((reason) => sql`${reason}`),
    sql`, `,
  )}), 0)`;
}

/**
 * Record on a pending gate that its review no longer matches the run, so the
 * workbench offers a re-review. Approval re-checks GitHub on every attempt;
 * this flag is what the reader sees, not the guarantee.
 */
export async function markGateReviewStale(
  db: AppDb,
  gateId: string,
  reason: GateStaleReviewReason,
): Promise<void> {
  await db
    .update(githubWorkflowGates)
    .set({ failureReason: reason, updatedAt: new Date() })
    .where(and(eq(githubWorkflowGates.id, gateId), eq(githubWorkflowGates.status, "pending")));
}

/** Drop a stale flag once GitHub again reports exactly the reviewed run state. */
export async function clearGateReviewStale(db: AppDb, gateId: string): Promise<void> {
  await db
    .update(githubWorkflowGates)
    .set({ failureReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.status, "pending"),
        staleReviewCondition(),
      ),
    );
}

/**
 * Undo an approval GitHub has not yet received because the run changed after
 * the decision. The gate returns to pending with the stale reason and its
 * package approvals are cleared, so a maintainer can reject or re-review; the
 * held job is never told to continue. Returns the cleared approvals for the
 * audit record.
 */
export async function withdrawUndeliveredGateApproval(
  db: AppDb,
  gate: WorkflowGateRecord,
  reason: GateStaleReviewReason,
) {
  const now = new Date();
  const [, cleared] = await db.batch([
    db
      .update(githubWorkflowGates)
      .set({
        status: "pending",
        decision: null,
        decisionComment: null,
        reportUrl: null,
        decidedAt: null,
        failureReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubWorkflowGates.id, gate.id),
          eq(githubWorkflowGates.status, "approved"),
          isNull(githubWorkflowGates.decisionDeliveredAt),
        ),
      )
      .returning({ id: githubWorkflowGates.id }),
    // Runs after the gate update in the same batch; it only clears approvals
    // when that update reopened the gate.
    db
      .update(scans)
      .set({
        decision: null,
        decisionReason: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scans.gateId, gate.id),
          eq(scans.organizationId, gate.organizationId),
          eq(scans.decision, "publish"),
          sql`exists (
            select 1 from ${githubWorkflowGates}
            where ${githubWorkflowGates.id} = ${gate.id}
              and ${githubWorkflowGates.status} = 'pending'
              and ${githubWorkflowGates.failureReason} = ${reason}
          )`,
        ),
      )
      .returning({
        packageName: scans.packageName,
        version: scans.stagedVersion,
        decidedByUserId: scans.decidedByUserId,
      }),
  ]);
  return cleared;
}

export async function markGateDecisionDelivered(db: AppDb, gateId: string): Promise<void> {
  const now = new Date();
  await db
    .update(githubWorkflowGates)
    .set({ decisionDeliveredAt: now, updatedAt: now })
    .where(
      and(eq(githubWorkflowGates.id, gateId), isNull(githubWorkflowGates.decisionDeliveredAt)),
    );
}

export async function markGateErrored(
  db: AppDb,
  gateId: string,
  reason: string,
): Promise<WorkflowGateRecord | null> {
  const now = new Date();
  const updated = await db
    .update(githubWorkflowGates)
    .set({ failureReason: reason.slice(0, 500), updatedAt: now })
    .where(and(eq(githubWorkflowGates.id, gateId), eq(githubWorkflowGates.status, "pending")))
    .returning({ id: githubWorkflowGates.id });
  if (updated.length === 0) return null;
  const [row] = await db
    .select()
    .from(githubWorkflowGates)
    .where(eq(githubWorkflowGates.id, gateId))
    .limit(1);
  return row ? readGateRow(row) : null;
}

function readGateRow(row: typeof githubWorkflowGates.$inferSelect): WorkflowGateRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    releaseTargetId: row.releaseTargetId,
    deliveryId: row.deliveryId,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    environment: row.environment,
    runId: row.runId,
    deploymentId: row.deploymentId,
    deploymentCallbackUrl: row.deploymentCallbackUrl,
    eventAction: row.eventAction,
    status: normalizeGateStatus(row.status),
    decision: normalizeGateDecision(row.decision),
    decisionComment: row.decisionComment,
    reportUrl: row.reportUrl,
    scanId: row.scanId,
    reviewStartedAt: row.reviewStartedAt ? new Date(row.reviewStartedAt) : null,
    failureReason: row.failureReason,
    reviewBinding: readGateReviewBinding(row.runAttempt, row.reviewedArtifactsJson),
    decisionDeliveredAt: row.decisionDeliveredAt ? new Date(row.decisionDeliveredAt) : null,
    requestedAt: new Date(row.requestedAt),
    decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function normalizeGateStatus(value: string): WorkflowGateStatus {
  if (
    value === "approved" ||
    value === "rejected" ||
    value === "errored" ||
    value === "superseded"
  ) {
    return value;
  }
  return "pending";
}

function normalizeGateDecision(value: string | null): "approved" | "rejected" | null {
  if (value === "approved" || value === "rejected") return value;
  return null;
}
