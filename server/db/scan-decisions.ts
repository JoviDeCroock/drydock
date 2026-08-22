/**
 * Publish / no-publish decisions.
 *
 * A decision is the reviewer's verdict on a scanned release, and for gated
 * releases it is also what unblocks or blocks the waiting GitHub deployment.
 * Every decision writes an audit event carrying the risk the reviewer actually
 * saw, so an override stays attributable after the fact.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePersistedAiReview } from "../lib/ai-review/contract";
import { normalizeScanRiskBreakdown } from "../lib/review/risk";
import { recordProductEvent } from "../lib/platform/analytics";
import type { AppDb } from "./client";
import { recordScanEvent } from "./events";
import { getScan } from "./scan-detail";
import { githubWorkflowGates, scans } from "./schema";

export const SCAN_DECISIONS = ["publish", "no_publish"] as const;
export type ScanDecision = (typeof SCAN_DECISIONS)[number];

export const SCAN_DECISION_FILTERS = ["undecided", "publish", "no_publish", "all"] as const;
export type ScanDecisionFilter = (typeof SCAN_DECISION_FILTERS)[number];

export interface RecordScanDecisionInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
  decision: ScanDecision;
  reason?: string | null;
}

export async function recordScanDecision(
  db: AppDb,
  input: RecordScanDecisionInput,
  artifactBucket?: R2Bucket,
  env?: Cloudflare.Env,
) {
  const now = new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const updated = await db
    .update(scans)
    .set({
      decision: input.decision,
      decisionReason: reason,
      decidedByUserId: input.actorUserId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
      ),
    )
    .returning({
      id: scans.id,
      createdAt: scans.createdAt,
      risk: scans.risk,
      riskSummaryJson: scans.riskSummaryJson,
      aiJson: scans.aiJson,
    });

  if (updated.length === 0) return null;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.decided",
    metadata: { decision: input.decision, reason },
  });

  // Always npm here: this is the staged-publish decision route. Gated releases
  // decide through `claimGatePackageDecision` below and report `gate`.
  recordDecisionEvent(env, updated[0], {
    organizationId: input.organizationId,
    decision: input.decision,
    ecosystem: "npm",
    now,
  });

  return getScan(db, input.scanId, input.organizationId, artifactBucket);
}

function toEpochMs(value: Date | number | string | null): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function readRiskSummaryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

interface RecordGatePackageDecisionInput extends RecordScanDecisionInput {
  gateId: string;
}

interface ClaimedGatePackageDecision {
  id: string;
  createdAt: Date | number | string;
  risk: string;
  riskSummaryJson: unknown;
  aiJson: unknown;
  decisionReason: string | null;
  decidedAt: Date;
}

/**
 * Record the one allowed decision for a workflow-gate package while the gate is
 * still pending. This keeps stale concurrent submits from mutating package state
 * after the aggregate gate decision has already released or blocked GitHub.
 */
export async function claimGatePackageDecision(
  db: AppDb,
  input: RecordGatePackageDecisionInput,
): Promise<ClaimedGatePackageDecision | null> {
  const now = new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const updated = await db
    .update(scans)
    .set({
      decision: input.decision,
      decisionReason: reason,
      decidedByUserId: input.actorUserId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.gateId, input.gateId),
        eq(scans.source, "workflow_gate"),
        sql`${scans.status} in ('complete', 'failed')`,
        isNull(scans.decision),
        sql`exists (
          select 1
          from ${githubWorkflowGates}
          where ${githubWorkflowGates.id} = ${input.gateId}
            and ${githubWorkflowGates.status} = 'pending'
        )`,
      ),
    )
    .returning({
      id: scans.id,
      createdAt: scans.createdAt,
      risk: scans.risk,
      riskSummaryJson: scans.riskSummaryJson,
      aiJson: scans.aiJson,
      decisionReason: scans.decisionReason,
      decidedAt: scans.decidedAt,
    });

  if (updated.length === 0) return null;

  return updated[0] as ClaimedGatePackageDecision;
}

/**
 * Emit the audit and product events for a package decision after its durable
 * outcome is known. Finalizing decisions delay this until the gate/baseline
 * batch commits, so a stale authority acknowledgement that is rolled back does
 * not leave behind a false `scan.decided` event.
 */
export async function recordClaimedGatePackageDecision(
  db: AppDb,
  input: RecordGatePackageDecisionInput,
  claimed: ClaimedGatePackageDecision,
  env?: Cloudflare.Env,
): Promise<void> {
  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.decided",
    metadata: { decision: input.decision, reason: claimed.decisionReason },
  });

  // Gated releases decide here rather than through `recordScanDecision`, so
  // without this the decision counter saw only the npm staged path — the
  // ecosystems that release exclusively through a gate were invisible.
  recordDecisionEvent(env, claimed, {
    organizationId: input.organizationId,
    decision: input.decision,
    ecosystem: "gate",
    now: claimed.decidedAt,
  });
}

/**
 * Shared product counter for both decision paths. Time-to-decision is the one
 * number that says how long a release actually sits held, and the decision-vs-
 * risk split is the clearest available signal that a risk grade is
 * miscalibrated — so both paths have to report it the same way.
 */
function recordDecisionEvent(
  env: Cloudflare.Env | undefined,
  row: {
    createdAt: Date | number | string | null;
    risk: string;
    riskSummaryJson: unknown;
    aiJson: unknown;
  },
  input: { organizationId: string; decision: string; ecosystem: string; now: Date },
): void {
  const breakdown = normalizeScanRiskBreakdown(readRiskSummaryValue(row.riskSummaryJson));
  recordProductEvent(env, {
    name: "scan.decided",
    organizationId: input.organizationId,
    ecosystem: input.ecosystem,
    decision: input.decision,
    releaseRisk: breakdown?.releaseRisk ?? row.risk,
    artifactRisk: breakdown?.artifactRisk ?? row.risk,
    timeToDecisionMs: Math.max(0, input.now.getTime() - toEpochMs(row.createdAt)),
  });

  const aiReview = parsePersistedAiReview(row.aiJson);
  // The disabled-review placeholder is persisted so report consumers can
  // explain why no advisory result exists, but it is not a reviewer attempt
  // and must not enter the reviewer feedback dataset as a "legacy" review.
  if (!aiReview || (aiReview.model === null && aiReview.reviewerVersion === null)) return;
  recordProductEvent(env, {
    name: "ai_review.decided",
    organizationId: input.organizationId,
    ecosystem: input.ecosystem,
    decision: input.decision,
    status: aiReview.status,
    releaseAssessment: aiReview.releaseAssessment,
    model: aiReview.model ?? "none",
    reviewerVersion: aiReview.reviewerVersion ?? "legacy",
  });
}
