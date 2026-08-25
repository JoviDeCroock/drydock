/**
 * Publish / no-publish decisions.
 *
 * A decision is the reviewer's verdict on a scanned release, and for gated
 * releases it is also what unblocks or blocks the waiting GitHub deployment.
 * Every decision writes an audit event carrying the risk the reviewer actually
 * saw, so an override stays attributable after the fact.
 *
 * A decision is no longer written directly. Both paths below record the acting
 * member's *vote* (see `scan-approvals.ts`) and then write whatever verdict the
 * org's approval bar says those votes add up to — which for a one-approval org
 * is the vote itself, and for a two-approval org is nothing at all until a
 * second distinct member agrees.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { parsePersistedAiReview } from "../lib/ai-review/contract";
import { normalizeScanRiskBreakdown } from "../lib/review/risk";
import { recordProductEvent } from "../lib/platform/analytics";
import type { AppDb } from "./client";
import { recordScanEvent } from "./events";
import {
  approvalVoterIsCurrentMember,
  buildScanApprovalState,
  getOrganizationApprovalPolicy,
  listScanApprovalVotes,
  resolveApprovalVerdict,
  upsertScanApproval,
  type OrganizationApprovalPolicy,
  type ScanApprovalState,
  type ScanApprovalVote,
} from "./scan-approvals";
import { getScan } from "./scan-detail";
import { githubWorkflowGates, organizations, scanApprovals, scanEvents, scans } from "./schema";

export const SCAN_DECISIONS = ["publish", "no_publish"] as const;
export type ScanDecision = (typeof SCAN_DECISIONS)[number];

export const SCAN_DECISION_FILTERS = [
  "undecided",
  "published_without_decision",
  "publish",
  "no_publish",
  "all",
] as const;
export type ScanDecisionFilter = (typeof SCAN_DECISION_FILTERS)[number];

export interface RecordScanDecisionInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
  decision: ScanDecision;
  reason?: string | null;
}

type ScanDecisionDetail = NonNullable<Awaited<ReturnType<typeof getScan>>>;

/**
 * What a decision submission did.
 *
 * `recorded` covers both "the release swapped" and "your approval is in, the
 * release still needs another" — the caller tells them apart with `verdict`,
 * which is the release's decision *after* this vote, not the vote itself.
 */
export type RecordScanDecisionResult =
  | {
      outcome: "recorded";
      detail: ScanDecisionDetail;
      approvals: ScanApprovalState;
      verdict: ScanDecision | null;
      /** True when this vote is the one that moved the release's verdict. */
      verdictChanged: boolean;
    }
  /** The scan is gone, not in a decidable state, or its gate is no longer pending. */
  | { outcome: "not_actionable" }
  /** This member has already voted and the path does not allow re-voting. */
  | { outcome: "already_voted" };

interface DecisionTargetRow {
  createdAt: Date | number | string | null;
  risk: string;
  riskSummaryJson: unknown;
  aiJson: unknown;
  decision: string | null;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | number | string | null;
}

export async function recordScanDecision(
  db: AppDb,
  input: RecordScanDecisionInput,
  artifactBucket?: R2Bucket,
  env?: Cloudflare.Env,
): Promise<RecordScanDecisionResult> {
  const [current] = await db
    .select(DECISION_TARGET_COLUMNS)
    .from(scans)
    .where(
        and(
          eq(scans.id, input.scanId),
          eq(scans.organizationId, input.organizationId),
          eq(scans.status, "complete"),
          isNull(scans.registryStatusSupersededAt),
          // Workflow-gate votes must go through the gate route: that path performs
          // the per-vote TOTP step-up and owns the irreversible GitHub callback.
          // Sharing the vote roster is safe only when the staged route cannot add
          // an un-stepped-up approval to it.
          inArray(scans.source, ["manual", "auto_discovery"]),
        ),
    )
    .limit(1);
  if (!current) return { outcome: "not_actionable" };

  return applyDecisionVote(db, {
    input,
    current,
    // The staged decision is an audit record — it publishes nothing — so a
    // reviewer may revise their own vote here as freely as they could revise
    // the whole decision before quorum existed.
    hardenOnly: false,
    // Always npm here: this is the staged-publish decision route. Gated
    // releases decide through `recordGatePackageDecision` below and report
    // `gate`.
    ecosystem: "npm",
    artifactBucket,
    env,
    // Only the plain status/ownership predicate; no gate to race with.
    applyVerdictWhere: () =>
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
        isNull(scans.registryStatusSupersededAt),
        inArray(scans.source, ["manual", "auto_discovery"]),
      )!,
  });
}

const DECISION_TARGET_COLUMNS = {
  createdAt: scans.createdAt,
  risk: scans.risk,
  riskSummaryJson: scans.riskSummaryJson,
  aiJson: scans.aiJson,
  decision: scans.decision,
  decisionReason: scans.decisionReason,
  decidedByUserId: scans.decidedByUserId,
  decidedAt: scans.decidedAt,
} as const;

interface ApplyDecisionVoteInput {
  input: RecordScanDecisionInput;
  current: DecisionTargetRow;
  hardenOnly: boolean;
  ecosystem: string;
  artifactBucket?: R2Bucket;
  env?: Cloudflare.Env;
  /**
   * The predicate the verdict write must still satisfy. Re-checked at write
   * time rather than trusted from the read above, so a concurrent finalize
   * (or a fail-closed auto-block) wins the race instead of being overwritten.
   */
  applyVerdictWhere: (verdict: ScanDecision) => ReturnType<typeof and>;
}

/**
 * The shared body of both decision paths: record the vote, re-tally, and write
 * the verdict only if it moved.
 *
 * The tally deliberately re-reads every vote instead of incrementing a counter.
 * Two members approving at the same instant both land their own row (distinct
 * keys in the unique index, so neither is lost), and each then reads a tally
 * that includes the other — so the second one through writes the verdict and
 * the first sees `verdictChanged: false`. A counter would have to be right
 * about which write won; a re-tally does not.
 */
async function applyDecisionVote(
  db: AppDb,
  {
    input,
    current,
    hardenOnly,
    ecosystem,
    artifactBucket,
    env,
    applyVerdictWhere,
  }: ApplyDecisionVoteInput,
): Promise<RecordScanDecisionResult> {
  const now = new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  let decisionReason = reason;

  const vote = await upsertScanApproval(db, {
    scanId: input.scanId,
    organizationId: input.organizationId,
    userId: input.actorUserId,
    decision: input.decision,
    reason,
    now,
    hardenOnly,
  });
  if (vote === "not_member") return { outcome: "not_actionable" };
  const approvalRecorded = vote === "recorded";

  // Read the policy only after the vote is durable. A concurrent policy batch
  // that commits just before this insert cannot otherwise see the new row, and
  // this request could keep an old, higher bar and leave a now-sufficient tally
  // undecided. Every write below proves both the live policy and roster; a lost
  // compare-and-set retries from fresh state rather than treating the stale
  // tally as success.
  let policy: OrganizationApprovalPolicy | null = null;
  let votes: ScanApprovalVote[] = [];
  let verdict: ScanDecision | null = null;
  let verdictChanged = false;
  let resolvedScan: BuildApprovalScan | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [nextPolicy, nextVotes, liveRows] = await Promise.all([
      getOrganizationApprovalPolicy(db, input.organizationId),
      listScanApprovalVotes(db, input.scanId, input.organizationId),
      db
        .select(DECISION_TARGET_COLUMNS)
        .from(scans)
        .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
        .limit(1),
    ]);
    const live = liveRows[0];
    if (!live) return { outcome: "not_actionable" };

    policy = nextPolicy;
    votes = nextVotes;
    // A retry of an already-durable gate vote must preserve the comment that
    // was actually recorded, rather than replacing decision attribution with
    // whatever the recovery request happened to submit.
    decisionReason = approvalRecorded
      ? reason
      : (nextVotes.find((candidate) => candidate.userId === input.actorUserId)?.reason ?? reason);
    verdict = resolveApprovalVerdict(
      votes.filter((candidate) => candidate.eligible),
      policy.required,
    );
    const previousVerdict = scanDecision(live.decision);
    const expectedDecision = previousVerdict
      ? eq(scans.decision, previousVerdict)
      : isNull(scans.decision);

    if (verdict === previousVerdict) {
      // Even a semantic no-op must prove the policy is still current. This is
      // the branch that used to strand a two-vote tally when the owner lowered
      // the bar from three to two between the request's read and write.
      const confirmed = await db
        .update(scans)
        .set({ updatedAt: now })
        .where(
          and(
            eq(scans.id, input.scanId),
            eq(scans.organizationId, input.organizationId),
            expectedDecision,
            approvalVerdictIsSupported(input, policy, verdict),
          ),
        )
        .returning({ id: scans.id });
      if (confirmed.length === 0) continue;
      verdictChanged = false;
      resolvedScan = approvalScanAfter(
        live,
        verdict,
        false,
        input.actorUserId,
        decisionReason,
        now,
      );
      break;
    }

    if (verdict) {
      const applied = await db
        .update(scans)
        .set({
          decision: verdict,
          decisionReason,
          // The member whose vote completed the bar owns the decision; the full
          // roster of who else approved lives in `scan_approvals`.
          decidedByUserId: input.actorUserId,
          decidedAt: now,
          updatedAt: now,
        })
        // Compare against the verdict read above as well as the live roster.
        // Without this staged co-approvers could both update null -> publish and
        // both emit the one logical `scan.decided` transition.
        .where(
          and(
            applyVerdictWhere(verdict),
            expectedDecision,
            approvalVerdictIsSupported(input, policy, verdict),
          ),
        )
        .returning({ id: scans.id });
      if (applied.length === 0) continue;
    } else {
      // Verdict fell back to undecided — reachable when the approval bar was
      // raised above what an already-approved release had cleared.
      const applied = await db
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
            eq(scans.id, input.scanId),
            eq(scans.organizationId, input.organizationId),
            expectedDecision,
            approvalVerdictIsSupported(input, policy, null),
          ),
        )
        .returning({ id: scans.id });
      if (applied.length === 0) continue;
    }

    verdictChanged = true;
    resolvedScan = approvalScanAfter(live, verdict, true, input.actorUserId, decisionReason, now);
    break;
  }

  if (!policy || !resolvedScan) return { outcome: "not_actionable" };

  const eligibleApprovedCount = votes.filter(
    (vote) => vote.eligible && vote.decision === "publish",
  ).length;
  await recordDecisionAuditTrail(db, {
    input,
    reason: decisionReason,
    policy,
    eligibleApprovedCount,
    verdict,
    verdictChanged,
    approvalRecorded,
  });

  // A gate retry may find the durable vote left by an interrupted request. If
  // it still did not move the verdict, preserve the duplicate-vote 409; if the
  // saved roster was already sufficient, the transition above repairs the
  // package and lets the route continue to aggregate the gate.
  if (!approvalRecorded && !verdictChanged) return { outcome: "already_voted" };

  const approvals = buildScanApprovalState({
    votes,
    policy,
    viewerUserId: input.actorUserId,
    scan: resolvedScan,
  });

  if (verdictChanged && verdict) {
    recordScanDecisionProductEvents(env, current, {
      organizationId: input.organizationId,
      decision: verdict,
      ecosystem,
      approvalCount: eligibleApprovedCount,
      requiredApprovals: policy.required,
      now,
    });
  }

  const detail = await getScan(db, input.scanId, input.organizationId, artifactBucket);
  if (!detail) return { outcome: "not_actionable" };
  // `verdictChanged` is what callers act on (purging caches, finalizing a gate),
  // so it must describe the row that is actually persisted now.
  verdictChanged = verdictChanged && (detail.scan.decision ?? null) === verdict;
  return { outcome: "recorded", detail, approvals, verdict, verdictChanged };
}

type BuildApprovalScan = Parameters<typeof buildScanApprovalState>[0]["scan"];

function scanDecision(value: string | null): ScanDecision | null {
  return value === "publish" || value === "no_publish" ? value : null;
}

function approvalScanAfter(
  current: DecisionTargetRow,
  verdict: ScanDecision | null,
  changed: boolean,
  actorUserId: string,
  reason: string | null,
  now: Date,
): BuildApprovalScan {
  return {
    decision: verdict,
    decisionReason: changed ? reason : current.decisionReason,
    decidedByUserId: changed ? actorUserId : current.decidedByUserId,
    decidedAt: changed ? now : current.decidedAt,
  };
}

/**
 * Atomic proof that the current vote rows still produce the verdict a request
 * computed earlier. D1 serializes each statement, not an entire request, so the
 * roster may change between `listScanApprovalVotes` and the scan update.
 */
function approvalVerdictIsSupported(
  input: RecordScanDecisionInput,
  policy: OrganizationApprovalPolicy,
  verdict: ScanDecision | null,
) {
  const blockExists = sql`exists (
    select 1
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${input.scanId}
      and ${scanApprovals.organizationId} = ${input.organizationId}
      and ${scanApprovals.decision} = 'no_publish'
      and ${approvalVoterIsCurrentMember(input.organizationId)}
  )`;
  if (verdict === "no_publish") return blockExists;

  // A policy change reconciles every existing vote in one transaction. Refuse
  // to apply a tally computed under the previous bar after that transaction has
  // committed; the recorded vote remains and a retry will use the new policy.
  const policyIsCurrent = sql`exists (
    select 1
    from ${organizations}
    where ${organizations.id} = ${input.organizationId}
      and ${organizations.requiredReleaseApprovals} = ${policy.required}
  )`;

  const approvalCount = sql`(
    select count(*)
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${input.scanId}
      and ${scanApprovals.organizationId} = ${input.organizationId}
      and ${scanApprovals.decision} = 'publish'
      and ${approvalVoterIsCurrentMember(input.organizationId)}
  )`;
  if (verdict === "publish") {
    return and(
      policyIsCurrent,
      sql`not ${blockExists}`,
      sql`${approvalCount} >= ${policy.required}`,
    )!;
  }
  return and(policyIsCurrent, sql`not ${blockExists}`, sql`${approvalCount} < ${policy.required}`)!;
}

/**
 * Audit trail for one submission.
 *
 * `scan.decided` stays the record of the release's verdict — it fires when the
 * verdict moves, not once per click — so the audit log never claims a release
 * was decided twice, or decided at all while it still waits on a co-approver.
 * Under a multi-approval policy each individual vote is also recorded, because
 * "who else signed off on this" is the whole point of the policy.
 */
async function recordDecisionAuditTrail(
  db: AppDb,
  input: {
    input: RecordScanDecisionInput;
    reason: string | null;
    policy: OrganizationApprovalPolicy;
    eligibleApprovedCount: number;
    verdict: ScanDecision | null;
    verdictChanged: boolean;
    approvalRecorded: boolean;
  },
): Promise<void> {
  let approvalEventMissing = input.approvalRecorded;
  if (!approvalEventMissing && input.policy.required > 1) {
    const [existing] = await db
      .select({ id: scanEvents.id })
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.organizationId, input.input.organizationId),
          eq(scanEvents.scanId, input.input.scanId),
          eq(scanEvents.actorUserId, input.input.actorUserId),
          eq(scanEvents.type, "scan.approval_recorded"),
        ),
      )
      .limit(1);
    approvalEventMissing = !existing;
  }
  if (approvalEventMissing && input.policy.required > 1) {
    await recordScanEvent(db, {
      organizationId: input.input.organizationId,
      actorUserId: input.input.actorUserId,
      scanId: input.input.scanId,
      type: "scan.approval_recorded",
      metadata: {
        decision: input.input.decision,
        reason: input.reason,
        approvedCount: input.eligibleApprovedCount,
        requiredApprovals: input.policy.required,
      },
    });
  }
  if (!input.verdict) return;
  let decisionEventMissing = input.verdictChanged;
  if (!decisionEventMissing) {
    const [existing] = await db
      .select({ id: scanEvents.id })
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.organizationId, input.input.organizationId),
          eq(scanEvents.scanId, input.input.scanId),
          eq(scanEvents.type, "scan.decided"),
        ),
      )
      .limit(1);
    decisionEventMissing = !existing;
  }
  if (!decisionEventMissing) return;
  await recordScanEvent(db, {
    organizationId: input.input.organizationId,
    actorUserId: input.input.actorUserId,
    scanId: input.input.scanId,
    type: "scan.decided",
    metadata: {
      decision: input.verdict,
      reason: input.reason,
      approvedCount: input.eligibleApprovedCount,
      requiredApprovals: input.policy.required,
    },
  });
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

export interface RecordGatePackageDecisionInput extends RecordScanDecisionInput {
  gateId: string;
}

/**
 * Record one member's decision on one package of a gate while the gate is still
 * pending, and flip the package's own verdict once the org's approval bar is
 * met. This keeps stale concurrent submits from mutating package state after
 * the aggregate gate decision has already released or blocked GitHub.
 *
 * Unlike the staged path, a vote here is not freely revisable: approving helps
 * release a held deployment, so the only permitted change is approve → block,
 * the fail-closed direction.
 */
export async function recordGatePackageDecision(
  db: AppDb,
  input: RecordGatePackageDecisionInput,
  artifactBucket?: R2Bucket,
  env?: Cloudflare.Env,
): Promise<RecordScanDecisionResult> {
  const gatePending = sql`exists (
          select 1
          from ${githubWorkflowGates}
          where ${githubWorkflowGates.id} = ${input.gateId}
            and ${githubWorkflowGates.status} = 'pending'
        )`;
  const multiApprovalPolicyIsCurrent = sql`exists (
    select 1
    from ${organizations}
    where ${organizations.id} = ${input.organizationId}
      and ${organizations.requiredReleaseApprovals} > 1
  )`;
  const actorAlreadyCastDurableDecision = sql`exists (
    select 1
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${input.scanId}
      and ${scanApprovals.organizationId} = ${input.organizationId}
      and ${scanApprovals.userId} = ${input.actorUserId}
      and ${scanApprovals.decision} = ${input.decision}
  )`;
  const decidable = and(
    eq(scans.id, input.scanId),
    eq(scans.organizationId, input.organizationId),
    eq(scans.gateId, input.gateId),
    eq(scans.source, "workflow_gate"),
    sql`${scans.status} in ('complete', 'failed')`,
    gatePending,
  )!;

  const blockableDecision =
    input.decision === "no_publish"
      ? or(
          isNull(scans.decision),
          and(eq(scans.decision, "publish"), multiApprovalPolicyIsCurrent),
          and(eq(scans.decision, "no_publish"), actorAlreadyCastDurableDecision),
        )
      : or(
          isNull(scans.decision),
          and(eq(scans.decision, "publish"), actorAlreadyCastDurableDecision),
        );
  const [current] = await db
    .select(DECISION_TARGET_COLUMNS)
    .from(scans)
    .where(and(decidable, blockableDecision))
    .limit(1);
  if (!current) return { outcome: "not_actionable" };

  return applyDecisionVote(db, {
    input,
    current,
    hardenOnly: true,
    ecosystem: "gate",
    artifactBucket,
    env,
    // The package must still be undecided when the verdict lands — except for a
    // block, which is allowed to override an approval that has not yet released
    // the deployment. Both re-assert that the gate is still pending, so a
    // concurrent finalize or fail-closed auto-reject wins this race.
    applyVerdictWhere: (verdict) =>
      and(
        decidable,
        verdict === "no_publish"
          ? or(
              isNull(scans.decision),
              and(eq(scans.decision, "publish"), multiApprovalPolicyIsCurrent),
            )
          : isNull(scans.decision),
      )!,
  });
}

/**
 * Shared product counter for both decision paths. Time-to-decision is the one
 * number that says how long a release actually sits held, and the decision-vs-
 * risk split is the clearest available signal that a risk grade is
 * miscalibrated — so both paths have to report it the same way.
 */
export function recordScanDecisionProductEvents(
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
    approvalCount: number;
    requiredApprovals: number;
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
    timeToDecisionMs: Math.max(0, input.now.getTime() - toEpochMs(row.createdAt)),
    // How many people it actually took, against the bar the org set. Without
    // both numbers a rising time-to-decision reads as reviewer apathy when it
    // is really a second approver being waited on.
    approvalCount: input.approvalCount,
    requiredApprovals: input.requiredApprovals,
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
