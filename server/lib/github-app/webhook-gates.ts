import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "../../db";
import { githubWorkflowGates } from "../../db/schema";
import type { InstallationRecord, ReleaseTargetRecord } from "./persistence";
import type { ParsedDeploymentProtectionEvent } from "./webhook";

export type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";

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
  scanId: string | null;
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

export async function getGateByScanId(
  db: AppDb,
  organizationId: string,
  scanId: string,
): Promise<WorkflowGateRecord | null> {
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
