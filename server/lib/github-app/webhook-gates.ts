import { and, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import { githubWorkflowGates, scans } from "../../db/schema";
import type { InstallationRecord, ReleaseTargetRecord } from "./persistence";
import type { ParsedDeploymentProtectionEvent } from "./webhook";

type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";

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
  // CAS claim taken when a delivery starts the review batch, so a concurrent
  // re-delivery does not double-run the per-package scans. It is a lease: see
  // `GATE_REVIEW_CLAIM_LEASE_MS` for how an abandoned claim is taken over.
  reviewStartedAt: Date | null;
  failureReason: string | null;
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
 * webhook. Returns the existing row if the same `X-GitHub-Delivery` ID has
 * already been recorded, so retries from GitHub are idempotent.
 */
export async function recordGateRequest(
  db: AppDb,
  input: RecordGateRequestInput,
): Promise<{ gate: WorkflowGateRecord; created: boolean }> {
  const existing = await getGateByDeliveryId(db, input.deliveryId);
  if (existing) return { gate: existing, created: false };

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
    environment: input.event.environment.toLowerCase(),
    runId: input.event.runId,
    deploymentId: input.event.deploymentId,
    deploymentCallbackUrl: input.event.deploymentCallbackUrl,
    eventAction: input.event.action,
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const fresh = await getGateByDeliveryId(db, input.deliveryId);
  if (!fresh) throw new Error("workflow gate row vanished immediately after insert");
  return { gate: fresh, created: true };
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

// A review claim is a lease, not a permanent flag. A delivery that fails
// mid-batch hands the claim back via `releaseGateReviewClaim`, but a hard crash
// (worker eviction, CPU limit, an exhausted queue retry ladder) cannot: it
// leaves `review_started_at` set with no scan attached, and every later
// delivery loses the CAS and skips. The gate then sits pending forever with no
// review, no failure reason, and nothing to tell the maintainer. Expiring the
// claim keeps the fail-closed guarantee (an expired claim never approves
// anything) while making an abandoned batch retryable.
//
// The lease has to outlast a healthy batch — a monorepo gate scans every
// package — so it is set well above the queue's own retry ladder rather than
// tuned tight. `recoverAbandonedGateReviews` sweeps on the same 15-minute cron.
export const GATE_REVIEW_CLAIM_LEASE_MS = 30 * 60 * 1000;

export type GateReviewClaim = "claimed" | "reclaimed" | "lost";

/**
 * CAS-claim the review batch for a gate. Returns `claimed` for exactly the
 * first delivery that flips `review_started_at` from null while the gate is
 * still pending; a concurrent re-delivery loses the claim and skips.
 *
 * A claim older than `GATE_REVIEW_CLAIM_LEASE_MS` with no representative scan
 * attached belongs to a delivery that died mid-batch, and is taken over
 * (`reclaimed`). The `scan_id is null` guard is what keeps that safe: a gate
 * that finished its review and is waiting on a human carries a scan, so it can
 * never be reclaimed and re-run out from under the maintainer.
 */
export async function claimGateReviewStart(
  db: AppDb,
  gateId: string,
  now: Date = new Date(),
): Promise<GateReviewClaim> {
  // Two narrow CAS updates rather than one `or(...)`: SQLite `returning` on an
  // UPDATE reports the new row, so a combined statement could not tell a fresh
  // claim from a takeover, and the two cases are logged differently — a
  // takeover means a previous delivery died mid-batch.
  const fresh = await casClaimGateReview(
    db,
    gateId,
    now,
    isNull(githubWorkflowGates.reviewStartedAt),
  );
  if (fresh) return "claimed";
  const staleBefore = new Date(now.getTime() - GATE_REVIEW_CLAIM_LEASE_MS);
  const takeover = await casClaimGateReview(
    db,
    gateId,
    now,
    lte(githubWorkflowGates.reviewStartedAt, staleBefore),
  );
  return takeover ? "reclaimed" : "lost";
}

async function casClaimGateReview(
  db: AppDb,
  gateId: string,
  now: Date,
  claimCondition: SQL | undefined,
): Promise<boolean> {
  const updated = await db
    .update(githubWorkflowGates)
    .set({ reviewStartedAt: now, updatedAt: now })
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.status, "pending"),
        isNull(githubWorkflowGates.scanId),
        claimCondition,
      ),
    )
    .returning({ id: githubWorkflowGates.id });
  return updated.length > 0;
}

export interface AbandonedGateReview {
  id: string;
  organizationId: string;
  repositoryFullName: string;
  environment: string;
  requestedAt: Date;
  reviewStartedAt: Date;
  failureReason: string | null;
}

/**
 * Pending gates holding a review claim that has outlived its lease without
 * attaching a scan — the abandoned-batch state described above. Ordered oldest
 * first and bounded so a cron sweep stays cheap.
 */
export async function listAbandonedGateReviews(
  db: AppDb,
  input: { staleBefore: Date; limit: number },
): Promise<AbandonedGateReview[]> {
  const rows = await db
    .select({
      id: githubWorkflowGates.id,
      organizationId: githubWorkflowGates.organizationId,
      repositoryFullName: githubWorkflowGates.repositoryFullName,
      environment: githubWorkflowGates.environment,
      requestedAt: githubWorkflowGates.requestedAt,
      reviewStartedAt: githubWorkflowGates.reviewStartedAt,
      failureReason: githubWorkflowGates.failureReason,
    })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.status, "pending"),
        isNull(githubWorkflowGates.scanId),
        lte(githubWorkflowGates.reviewStartedAt, input.staleBefore),
      ),
    )
    .orderBy(githubWorkflowGates.reviewStartedAt)
    .limit(input.limit);
  return rows.flatMap((row) =>
    row.reviewStartedAt ? [{ ...row, reviewStartedAt: row.reviewStartedAt }] : [],
  );
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
 * already-reviewed package state.
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
      updatedAt: now,
    })
    .where(
      and(
        eq(githubWorkflowGates.id, input.gateId),
        eq(githubWorkflowGates.organizationId, input.organizationId),
        eq(githubWorkflowGates.status, "pending"),
        sql`exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${input.gateId}
            and ${scans.organizationId} = ${input.organizationId}
            and ${scans.status} = 'failed'
        )`,
        sql`not exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${input.gateId}
            and ${scans.organizationId} = ${input.organizationId}
            and ${scans.decision} is not null
        )`,
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
        input.decision === "approved" ? sql`${githubWorkflowGates.scanId} is not null` : sql`1 = 1`,
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

function readGateRow(row: {
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
  status: string;
  decision: string | null;
  decisionComment: string | null;
  reportUrl: string | null;
  scanId: string | null;
  reviewStartedAt: Date | string | number | null;
  failureReason: string | null;
  requestedAt: Date | string | number;
  decidedAt: Date | string | number | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): WorkflowGateRecord {
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
    requestedAt: new Date(row.requestedAt),
    decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function normalizeGateStatus(value: string): WorkflowGateStatus {
  if (value === "approved" || value === "rejected" || value === "errored") return value;
  return "pending";
}

function normalizeGateDecision(value: string | null): "approved" | "rejected" | null {
  if (value === "approved" || value === "rejected") return value;
  return null;
}
