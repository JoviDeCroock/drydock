/**
 * Publish / no-publish decisions.
 *
 * A decision is the reviewer's verdict on a scanned release, and for gated
 * releases it is also what unblocks or blocks the waiting GitHub deployment.
 * Every decision writes an audit event carrying the risk the reviewer actually
 * saw, so an override stays attributable after the fact.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { parsePersistedAiReview } from "../lib/ai-review/contract";
import { normalizeScanRiskBreakdown } from "../lib/review/risk";
import { scanEcosystem } from "../lib/public-feed";
import { recordProductEvent } from "../lib/analytics";
import type { AppDb } from "./client";
import { recordScanEvent } from "./events";
import { getScan } from "./scan-detail";
import { undecidedQueueConditions } from "./scan-query";
import { readScanRiskBreakdown } from "./scan-risk";
import { githubWorkflowGates, scanEvents, scans } from "./schema";

import type { ScanDecision } from "./enums";

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
        isNull(scans.registryStatusSupersededAt),
      ),
    )
    .returning({
      id: scans.id,
      createdAt: scans.createdAt,
      risk: scans.risk,
      riskSummaryJson: scans.riskSummaryJson,
      aiJson: scans.aiJson,
      source: scans.source,
      summaryJson: scans.summaryJson,
    });

  if (updated.length === 0) return null;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.decided",
    metadata: { decision: input.decision, reason },
  });

  // Staged publishes are npm-only, but a published-pair review reaches this
  // route for any ecosystem with a public-diff adapter, so the counter reads
  // the scan rather than assuming. Gated releases decide through
  // `recordGatePackageDecision` below and report `gate`.
  recordDecisionEvent(env, updated[0], {
    organizationId: input.organizationId,
    decision: input.decision,
    ecosystem: scanEcosystem(updated[0].source, updated[0].summaryJson) ?? "npm",
    via: "single",
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

/** The most reviews one batch approval covers. */
export const BATCH_APPROVAL_LIMIT = 50;

/**
 * Staged reviews one action may approve together: rows of the **Undecided**
 * queue whose whole package reads low (release and artifact risk), compared
 * against a published baseline, with no findings new since the last approved
 * release and nothing the AI reviewer asked a person to look at. Each reads
 * "likely safe" on its own page; a clean diff over a risky package ("package
 * context only") does not qualify. Everything else keeps its own decision. The
 * approval re-checks this in the same statement that writes it, so a review
 * that changed after the list loaded stays undecided.
 */
function batchApprovableConditions(organizationId: string) {
  return [
    eq(scans.organizationId, organizationId),
    eq(scans.status, "complete"),
    inArray(scans.source, ["manual", "auto_discovery"]),
    ...undecidedQueueConditions(),
    sql`json_extract(${scans.riskSummaryJson}, '$.releaseRisk') = 'low'`,
    sql`json_extract(${scans.riskSummaryJson}, '$.artifactRisk') = 'low'`,
    sql`json_extract(${scans.summaryJson}, '$.baseline.comparisonSkipped') is null`,
    sql`coalesce(json_extract(${scans.summaryJson}, '$.releaseConsistency.status'), 'none') != 'diverged'`,
    sql`coalesce(json_extract(${scans.aiJson}, '$.requiresManualReview'), 0) = 0`,
    sql`coalesce(json_extract(${scans.aiJson}, '$.releaseAssessment'), 'not_assessed') in ('nothing_unusual', 'not_assessed')`,
  ];
}

export interface BatchApprovableScan {
  id: string;
  packageName: string | null;
  stagedVersion: string | null;
  registryUrl: string | null;
  releaseFindingCount: number;
  createdAt: Date;
}

/** Newest first; `more` says the queue holds more than one batch covers. */
export async function listBatchApprovableScans(
  db: AppDb,
  organizationId: string,
): Promise<{ scans: BatchApprovableScan[]; more: boolean }> {
  const rows = await db
    .select({
      id: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      registryUrl: scans.registryUrl,
      riskSummaryJson: scans.riskSummaryJson,
      createdAt: scans.createdAt,
    })
    .from(scans)
    .where(and(...batchApprovableConditions(organizationId)))
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(BATCH_APPROVAL_LIMIT + 1);
  return {
    scans: rows.slice(0, BATCH_APPROVAL_LIMIT).map((row) => ({
      id: row.id,
      packageName: row.packageName,
      stagedVersion: row.stagedVersion,
      registryUrl: row.registryUrl,
      releaseFindingCount: readScanRiskBreakdown(row.riskSummaryJson)?.releaseFindingCount ?? 0,
      createdAt: row.createdAt,
    })),
    more: rows.length > BATCH_APPROVAL_LIMIT,
  };
}

export interface RecordBatchApprovalInput {
  organizationId: string;
  actorUserId: string;
  scanIds: readonly string[];
  reason?: string | null;
}

/**
 * Approve the listed reviews that are still batch-approvable, each with the
 * same audit event a single decision writes. The decisions and their events
 * land in one transaction. Returns the approved rows; a listed review that
 * was decided, superseded, or settled on npm in the meantime is left alone.
 */
export async function recordBatchApproval(
  db: AppDb,
  input: RecordBatchApprovalInput,
  env?: Cloudflare.Env,
) {
  const scanIds = [...new Set(input.scanIds)];
  if (!scanIds.length) return [];
  const now = new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const metadata = JSON.stringify({ decision: "publish", reason, batch: true });
  const [updated] = await db.batch([
    db
      .update(scans)
      .set({
        decision: "publish",
        decisionReason: reason,
        decidedByUserId: input.actorUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(scans.id, scanIds), ...batchApprovableConditions(input.organizationId)))
      .returning({
        id: scans.id,
        createdAt: scans.createdAt,
        risk: scans.risk,
        riskSummaryJson: scans.riskSummaryJson,
        source: scans.source,
        // Only the stage record: the badge key and dist-tag read nothing else,
        // and the full summary carries the whole file list.
        stagedPublish: sql<string | null>`json_extract(${scans.summaryJson}, '$.stagedPublish')`,
        packageName: scans.packageName,
        stagedVersion: scans.stagedVersion,
        registryPackageName: scans.registryPackageName,
        registryUrl: scans.registryUrl,
        badgePublic: scans.badgePublic,
        publicFeedListedAt: scans.publicFeedListedAt,
      }),
    // One event per row the update above just wrote: same decider, same instant.
    // A same-millisecond resubmit by the same decider matches those rows again;
    // their events already exist, so it records nothing rather than failing.
    db
      .insert(scanEvents)
      .select(sql`select 'scan-decided:' || ${scans.id} || ':' || ${now.getTime()},
      ${input.organizationId}, ${input.actorUserId}, ${scans.id}, 'scan.decided', ${metadata},
      ${now.getTime()}
      from ${scans}
      where ${and(
        inArray(scans.id, scanIds),
        eq(scans.organizationId, input.organizationId),
        eq(scans.decision, "publish"),
        eq(scans.decidedByUserId, input.actorUserId),
        eq(scans.decidedAt, now),
      )}`)
      .onConflictDoNothing(),
  ]);

  const approved = updated.map(({ stagedPublish, ...row }) => ({
    ...row,
    summaryJson: { stagedPublish: parseStagedPublish(stagedPublish) },
  }));
  for (const row of approved) {
    recordDecisionEvent(
      env,
      { ...row, aiJson: null },
      {
        organizationId: input.organizationId,
        decision: "publish",
        ecosystem: "npm",
        via: "batch",
        now,
      },
    );
  }
  return approved;
}

function parseStagedPublish(value: string | null): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export interface RecordGatePackageDecisionInput extends RecordScanDecisionInput {
  gateId: string;
}

/**
 * Record the one allowed decision for a workflow-gate package while the gate is
 * still pending. This keeps stale concurrent submits from mutating package state
 * after the aggregate gate decision has already released or blocked GitHub.
 */
export async function recordGatePackageDecision(
  db: AppDb,
  input: RecordGatePackageDecisionInput,
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
    });

  if (updated.length === 0) return null;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.decided",
    metadata: { decision: input.decision, reason },
  });

  // Gated releases decide here rather than through `recordScanDecision`, so
  // without this the decision counter saw only the npm staged path — the
  // ecosystems that release exclusively through a gate were invisible.
  recordDecisionEvent(env, updated[0], {
    organizationId: input.organizationId,
    decision: input.decision,
    ecosystem: "gate",
    via: "single",
    now,
  });

  return getScan(db, input.scanId, input.organizationId, artifactBucket);
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
  input: {
    organizationId: string;
    decision: string;
    ecosystem: string;
    via: "single" | "batch";
    now: Date;
  },
): void {
  const breakdown = normalizeScanRiskBreakdown(readRiskSummaryValue(row.riskSummaryJson));
  recordProductEvent(env, {
    name: "scan.decided",
    organizationId: input.organizationId,
    ecosystem: input.ecosystem,
    decision: input.decision,
    releaseRisk: breakdown?.releaseRisk ?? row.risk,
    artifactRisk: breakdown?.artifactRisk ?? row.risk,
    via: input.via,
    timeToDecisionMs: Math.max(0, input.now.getTime() - toEpochMs(row.createdAt)),
  });

  // A batch approval is not a judgment of each review's AI result, so it stays
  // out of the reviewer feedback dataset.
  if (input.via === "batch") return;
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
