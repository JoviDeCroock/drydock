/**
 * Multi-party release approval.
 *
 * A release decision used to be one person's click. An organization can now
 * require N distinct members to approve before a release actually swaps to
 * approved: each member's vote is a `scan_approvals` row, and `scans.decision`
 * — still the single final verdict every downstream consumer reads — is
 * *derived* from those rows rather than written directly.
 *
 * Two rules make the derivation safe rather than merely tallied:
 *   - a block is unilateral and immediate, so a quorum can never be used to
 *     out-vote someone who has seen something bad in the diff;
 *   - approvals are counted per distinct member (enforced by a unique index,
 *     not by application code), so one reviewer cannot clear a two-person bar.
 */
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { chunkForD1 } from "./d1-chunk";
import type { ScanDecision } from "./scan-decisions";
import {
  githubWorkflowGates,
  organizationMembers,
  organizations,
  scanApprovals,
  scans,
  user,
} from "./schema";

/** Hard ceiling on the org policy: past this a release can never be shipped. */
export const MAX_REQUIRED_RELEASE_APPROVALS = 10;

interface ScanApprovalRecord {
  userId: string | null;
  name: string | null;
  email: string | null;
  decision: ScanDecision;
  reason: string | null;
  createdAt: Date | number | string;
  /**
   * True for the synthesized record standing in for a decision made before
   * multi-party approval existed (or for a gate auto-block), where the only
   * attribution we have is `scans.decided_by_user_id`.
   */
  legacy?: boolean;
}

export interface ScanApprovalState {
  /** Distinct approvals this org requires before a release swaps to approved. */
  required: number;
  approvedCount: number;
  blockedCount: number;
  /** The verdict these votes produce — mirrors the scan's `decision` column. */
  verdict: ScanDecision | null;
  approvals: ScanApprovalRecord[];
  /** The requesting member's own recorded vote, if any. */
  viewerDecision: ScanDecision | null;
  /** Members of the org — the pool the required approvals are drawn from. */
  eligibleApproverCount: number;
}

export interface OrganizationApprovalPolicy {
  required: number;
  memberCount: number;
}

function normalizeRequiredApprovals(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(MAX_REQUIRED_RELEASE_APPROVALS, Math.max(1, Math.floor(parsed)));
}

/**
 * The verdict a set of votes produces.
 *
 * Fail closed on the block: one `no_publish` decides the release no matter how
 * many approvals sit next to it, and no matter what the required count is.
 */
export function resolveApprovalVerdict(
  votes: ReadonlyArray<{ decision: ScanDecision }>,
  required: number,
): ScanDecision | null {
  if (votes.some((vote) => vote.decision === "no_publish")) return "no_publish";
  const approvals = votes.filter((vote) => vote.decision === "publish").length;
  return approvals >= normalizeRequiredApprovals(required) ? "publish" : null;
}

/** The org's approval bar, plus the member pool it has to be met from. */
export async function getOrganizationApprovalPolicy(
  db: AppDb,
  organizationId: string,
): Promise<OrganizationApprovalPolicy> {
  // Two reads rather than one correlated subquery: D1's planner does not
  // correlate the member count against the outer `organizations` row here, and
  // silently returned 0 — which would have shown every org as unable to meet
  // its own bar. Both are single-row indexed lookups.
  const [[row], [members]] = await Promise.all([
    db
      .select({ required: organizations.requiredReleaseApprovals })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
    db
      .select({ total: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId)),
  ]);
  // A missing org row cannot reach any caller here (every one is reached
  // through an org the member belongs to), so the default is a formality.
  return {
    required: normalizeRequiredApprovals(row?.required ?? 1),
    memberCount: Number(members?.total ?? 0),
  };
}

export async function setRequiredReleaseApprovals(
  db: AppDb,
  organizationId: string,
  required: number,
): Promise<{
  readyGateIds: string[];
  changedScans: Array<{
    id: string;
    source: string;
    packageName: string | null;
    summaryJson: unknown;
    publicFeedListedAt: Date | null;
  }>;
}> {
  const normalized = normalizeRequiredApprovals(required);
  const now = new Date();
  const hasVotes = sql`exists (
    select 1
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${scans.id}
      and ${scanApprovals.organizationId} = ${organizationId}
  )`;
  const hasBlock = sql`exists (
    select 1
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${scans.id}
      and ${scanApprovals.organizationId} = ${organizationId}
      and ${scanApprovals.decision} = 'no_publish'
  )`;
  const approvalCount = sql`(
    select count(*)
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${scans.id}
      and ${scanApprovals.organizationId} = ${organizationId}
      and ${scanApprovals.decision} = 'publish'
  )`;
  // A completed workflow gate is irreversible. Reconcile ordinary staged
  // decisions and packages whose held gate is still pending, but never rewrite
  // the historical package decisions behind a GitHub job that already shipped.
  const policyStillApplies = or(
    ne(scans.source, "workflow_gate"),
    sql`exists (
      select 1
      from ${githubWorkflowGates}
      where ${githubWorkflowGates.id} = ${scans.gateId}
        and ${githubWorkflowGates.organizationId} = ${organizationId}
        and ${githubWorkflowGates.status} = 'pending'
    )`,
  )!;
  const target = and(eq(scans.organizationId, organizationId), hasVotes, policyStillApplies)!;
  const latestVote = (decision: ScanDecision, column: "reason" | "user_id" | "updated_at") =>
    sql`(
      select ${sql.identifier(column)}
      from ${scanApprovals}
      where ${scanApprovals.scanId} = ${scans.id}
        and ${scanApprovals.organizationId} = ${organizationId}
        and ${scanApprovals.decision} = ${decision}
      order by ${scanApprovals.updatedAt} desc, ${scanApprovals.id} desc
      limit 1
    )`;

  // D1 batches are transactional: readers never observe the new policy paired
  // with verdicts derived from the old one. Blocks are applied first, approvals
  // second, and the remaining unsupported verdicts are cleared last.
  const [, blocked, approved, undecided] = await db.batch([
    db
      .update(organizations)
      .set({ requiredReleaseApprovals: normalized, updatedAt: now })
      .where(eq(organizations.id, organizationId)),
    db
      .update(scans)
      .set({
        decision: "no_publish",
        decisionReason: latestVote("no_publish", "reason"),
        decidedByUserId: latestVote("no_publish", "user_id"),
        decidedAt: latestVote("no_publish", "updated_at"),
        updatedAt: now,
      })
      .where(and(target, hasBlock, or(isNull(scans.decision), ne(scans.decision, "no_publish"))))
      .returning(RECONCILED_SCAN_COLUMNS),
    db
      .update(scans)
      .set({
        decision: "publish",
        decisionReason: latestVote("publish", "reason"),
        decidedByUserId: latestVote("publish", "user_id"),
        decidedAt: latestVote("publish", "updated_at"),
        updatedAt: now,
      })
      .where(
        and(
          target,
          sql`not ${hasBlock}`,
          sql`${approvalCount} >= ${normalized}`,
          or(isNull(scans.decision), ne(scans.decision, "publish")),
        ),
      )
      .returning(RECONCILED_SCAN_COLUMNS),
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
          target,
          sql`not ${hasBlock}`,
          sql`${approvalCount} < ${normalized}`,
          isNotNull(scans.decision),
        ),
      )
      .returning(RECONCILED_SCAN_COLUMNS),
  ]);

  const readyGates = await db
    .select({ id: githubWorkflowGates.id })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.organizationId, organizationId),
        eq(githubWorkflowGates.status, "pending"),
        isNotNull(githubWorkflowGates.scanId),
        sql`exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${githubWorkflowGates.id}
            and ${scans.organizationId} = ${organizationId}
        )`,
        sql`not exists (
          select 1
          from ${scans}
          where ${scans.gateId} = ${githubWorkflowGates.id}
            and ${scans.organizationId} = ${organizationId}
            and (${scans.decision} is null or ${scans.decision} <> 'publish')
        )`,
      ),
    );
  return {
    readyGateIds: readyGates.map((gate) => gate.id),
    changedScans: [...blocked, ...approved, ...undecided],
  };
}

const RECONCILED_SCAN_COLUMNS = {
  id: scans.id,
  source: scans.source,
  packageName: scans.packageName,
  summaryJson: scans.summaryJson,
  publicFeedListedAt: scans.publicFeedListedAt,
} as const;

export interface ScanApprovalVote {
  userId: string | null;
  name: string | null;
  email: string | null;
  decision: ScanDecision;
  reason: string | null;
  createdAt: Date;
}

/** Every vote cast on one scan, oldest first, with the voter's identity. */
export async function listScanApprovalVotes(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<ScanApprovalVote[]> {
  const rows = await db
    .select({
      userId: scanApprovals.userId,
      decision: scanApprovals.decision,
      reason: scanApprovals.reason,
      createdAt: scanApprovals.createdAt,
      name: user.name,
      email: user.email,
    })
    .from(scanApprovals)
    .leftJoin(user, eq(user.id, scanApprovals.userId))
    .where(and(eq(scanApprovals.scanId, scanId), eq(scanApprovals.organizationId, organizationId)))
    .orderBy(scanApprovals.createdAt);
  return rows.map((row) => ({
    userId: row.userId,
    name: row.name ?? null,
    email: row.email ?? null,
    decision: row.decision === "no_publish" ? "no_publish" : "publish",
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}

/** Approval counts for a page of scans, keyed by scan id. Empty ids → empty map. */
export async function countScanApprovals(
  db: AppDb,
  organizationId: string,
  scanIds: string[],
): Promise<Map<string, { approved: number; blocked: number }>> {
  const counts = new Map<string, { approved: number; blocked: number }>();
  if (!scanIds.length) return counts;
  // A full review page is 100 scans and D1 caps a statement at 100 bound
  // parameters, so the id list has to be chunked (one slot reserved for the
  // organization id) or the busiest page of the queue throws.
  for (const chunk of chunkForD1([...new Set(scanIds)], 1, 1)) {
    const rows = await db
      .select({
        scanId: scanApprovals.scanId,
        decision: scanApprovals.decision,
        total: sql<number>`count(*)`,
      })
      .from(scanApprovals)
      .where(
        and(eq(scanApprovals.organizationId, organizationId), inArray(scanApprovals.scanId, chunk)),
      )
      .groupBy(scanApprovals.scanId, scanApprovals.decision);
    for (const row of rows) {
      const entry = counts.get(row.scanId) ?? { approved: 0, blocked: 0 };
      if (row.decision === "no_publish") entry.blocked += Number(row.total);
      else entry.approved += Number(row.total);
      counts.set(row.scanId, entry);
    }
  }
  return counts;
}

export interface BuildScanApprovalStateInput {
  votes: ScanApprovalVote[];
  policy: OrganizationApprovalPolicy;
  viewerUserId: string | null;
  /** Falls back to the scan's own columns when no votes were ever recorded. */
  scan: {
    decision: string | null;
    decisionReason: string | null;
    decidedByUserId: string | null;
    decidedAt: Date | number | string | null;
  };
}

/**
 * The client-facing approval state for one scan.
 *
 * Scans decided before this feature existed — and gate packages auto-blocked by
 * the artifact verifier, which has no human voter — have a decision but no
 * votes. Rather than render those as "0 of 1 approved", synthesize one record
 * from the columns that *are* populated so the roster always explains the
 * verdict it sits next to.
 */
export function buildScanApprovalState(input: BuildScanApprovalStateInput): ScanApprovalState {
  const { votes, policy, viewerUserId, scan } = input;
  const decision =
    scan.decision === "publish" || scan.decision === "no_publish"
      ? (scan.decision as ScanDecision)
      : null;
  const approvals: ScanApprovalRecord[] = votes.length
    ? votes.map((vote) => ({
        userId: vote.userId,
        name: vote.name,
        email: vote.email,
        decision: vote.decision,
        reason: vote.reason,
        createdAt: vote.createdAt,
      }))
    : decision
      ? [
          {
            userId: scan.decidedByUserId,
            name: null,
            email: null,
            decision,
            reason: scan.decisionReason,
            createdAt: scan.decidedAt ?? new Date(0),
            legacy: true,
          },
        ]
      : [];
  return {
    required: policy.required,
    approvedCount: approvals.filter((entry) => entry.decision === "publish").length,
    blockedCount: approvals.filter((entry) => entry.decision === "no_publish").length,
    verdict: decision,
    approvals,
    viewerDecision:
      (viewerUserId && votes.find((vote) => vote.userId === viewerUserId)?.decision) || null,
    eligibleApproverCount: policy.memberCount,
  };
}

/** Load the approval state for a scan the caller has already authorized. */
export async function loadScanApprovalState(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    viewerUserId: string | null;
    scan: BuildScanApprovalStateInput["scan"];
    policy?: OrganizationApprovalPolicy;
  },
): Promise<ScanApprovalState> {
  const [votes, policy] = await Promise.all([
    listScanApprovalVotes(db, input.scanId, input.organizationId),
    input.policy
      ? Promise.resolve(input.policy)
      : getOrganizationApprovalPolicy(db, input.organizationId),
  ]);
  return buildScanApprovalState({
    votes,
    policy,
    viewerUserId: input.viewerUserId,
    scan: input.scan,
  });
}

export interface UpsertScanApprovalInput {
  scanId: string;
  organizationId: string;
  userId: string;
  decision: ScanDecision;
  reason: string | null;
  now: Date;
  /**
   * When set, an existing vote may only be replaced by a `no_publish` — the
   * fail-closed direction. Used by the gate path, where an approval has already
   * been counted toward releasing a held deployment and must not be silently
   * withdrawn or re-cast.
   */
  hardenOnly?: boolean;
}

export type UpsertScanApprovalOutcome = "recorded" | "already_voted";

/**
 * Record (or replace) this member's vote.
 *
 * The `(scan_id, user_id)` unique index is what actually enforces one vote per
 * member; this is an upsert against it rather than a read-then-write, so two
 * concurrent submissions by the same member cannot both insert.
 */
export async function upsertScanApproval(
  db: AppDb,
  input: UpsertScanApprovalInput,
): Promise<UpsertScanApprovalOutcome> {
  const recorded = await db
    .insert(scanApprovals)
    .values({
      id: crypto.randomUUID(),
      scanId: input.scanId,
      organizationId: input.organizationId,
      userId: input.userId,
      decision: input.decision,
      reason: input.reason,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [scanApprovals.scanId, scanApprovals.userId],
      set: { decision: input.decision, reason: input.reason, updatedAt: input.now },
      // On the gate path an existing vote may only be replaced by a block —
      // the fail-closed direction. Everything else (re-approving, or softening
      // a block back to an approval) leaves the row untouched, and RETURNING
      // then yields nothing, which is how the caller learns the member has
      // already had their say.
      setWhere: input.hardenOnly
        ? input.decision === "no_publish"
          ? sql`${scanApprovals.decision} <> 'no_publish'`
          : sql`0`
        : undefined,
    })
    .returning({ id: scanApprovals.id });
  return recorded.length > 0 ? "recorded" : "already_voted";
}

/**
 * Drop a departing member's votes on releases that are still undecided.
 *
 * Someone who has left the organization must not keep counting toward its
 * quorum — otherwise removing a member silently leaves the release they
 * half-approved one click from shipping. Already-decided releases keep their
 * full roster: that decision was real when it was made and the audit trail has
 * to keep saying so.
 */
export async function dropPendingApprovalsForMember(
  db: AppDb,
  organizationId: string,
  userId: string,
): Promise<void> {
  const undecided = db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.organizationId, organizationId), isNull(scans.decision)));
  await db
    .delete(scanApprovals)
    .where(
      and(
        eq(scanApprovals.organizationId, organizationId),
        eq(scanApprovals.userId, userId),
        inArray(scanApprovals.scanId, undecided),
      ),
    );
}

/** Remove every still-pending vote before an account's surviving rows are anonymized. */
export async function dropPendingApprovalsForUser(db: AppDb, userId: string): Promise<void> {
  const undecided = db.select({ id: scans.id }).from(scans).where(isNull(scans.decision));
  await db
    .delete(scanApprovals)
    .where(and(eq(scanApprovals.userId, userId), inArray(scanApprovals.scanId, undecided)));
}
