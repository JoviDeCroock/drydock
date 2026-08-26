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
import type { OrganizationRole } from "../lib/auth/roles";
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
  /** Whether this voter is still eligible to contribute to a live quorum. */
  eligible?: boolean;
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
  /** The verdict predates (or was produced outside) the member vote roster. */
  legacyDecision: boolean;
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

export interface ReconciledScanProjection {
  id: string;
  source: string;
  gateId: string | null;
  packageName: string | null;
  summaryJson: unknown;
  publicFeedListedAt: Date | null;
  publicPackageKey: string | null;
  decision: string | null;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date | null;
  risk: string;
  riskSummaryJson: unknown;
  aiJson: unknown;
}

export interface ReconciledScanDecision extends ReconciledScanProjection {
  /** Current-member approvals after the policy transaction committed. */
  approvalCount: number;
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

/** SQL proof that the current `scan_approvals` row still belongs to an org member. */
export function approvalVoterIsCurrentMember(organizationId: string) {
  return approvalProjectionSql(organizationId).voterIsCurrentMember;
}

/**
 * The SQL fragments every approval reconciliation derives `scans.decision`
 * from. There is exactly one definition of "a vote", "a block", "an eligible
 * approval", "the live bar", and "a still-pending gate package"; every writer
 * that changes an input to the projection — a vote, a membership row, the
 * policy — must build its predicates from these rather than restating them,
 * so the derivation cannot drift between event handlers.
 *
 * Pass `null` to correlate on `scans.organizationId` instead of one bound
 * organization, for statements that span every organization a user belongs to
 * (account deletion).
 */
function approvalProjectionSql(organizationId: string | null) {
  const org = organizationId === null ? sql`${scans.organizationId}` : sql`${organizationId}`;
  return {
    /** The current `scan_approvals` row's voter is still an org member. */
    voterIsCurrentMember: sql`exists (
      select 1
      from ${organizationMembers}
      where ${organizationMembers.organizationId} = ${org}
        and ${organizationMembers.userId} = ${scanApprovals.userId}
    )`,
    /** The outer `scans` row has at least one recorded vote. */
    scanHasVotes: sql`exists (
      select 1
      from ${scanApprovals}
      where ${scanApprovals.scanId} = ${scans.id}
        and ${scanApprovals.organizationId} = ${org}
    )`,
    /**
     * The outer `scans` row carries a durable block. A block is a fail-closed
     * release verdict, so unlike approvals it does not require current
     * membership.
     */
    scanHasBlock: sql`exists (
      select 1
      from ${scanApprovals}
      where ${scanApprovals.scanId} = ${scans.id}
        and ${scanApprovals.organizationId} = ${org}
        and ${scanApprovals.decision} = 'no_publish'
    )`,
    /** Approvals on the outer `scans` row that still count toward a live quorum. */
    eligibleApprovalCount: sql`(
      select count(*)
      from ${scanApprovals}
      where ${scanApprovals.scanId} = ${scans.id}
        and ${scanApprovals.organizationId} = ${org}
        and ${scanApprovals.decision} = 'publish'
        and exists (
          select 1
          from ${organizationMembers}
          where ${organizationMembers.organizationId} = ${org}
            and ${organizationMembers.userId} = ${scanApprovals.userId}
        )
    )`,
    /** The organization's live approval bar. */
    requiredApprovals: sql`(
      select ${organizations.requiredReleaseApprovals}
      from ${organizations}
      where ${organizations.id} = ${org}
    )`,
    /** The outer `scans` row belongs to a workflow gate that is still pending. */
    scanGateIsPending: sql`exists (
      select 1
      from ${githubWorkflowGates}
      where ${githubWorkflowGates.id} = ${scans.gateId}
        and ${githubWorkflowGates.organizationId} = ${org}
        and ${githubWorkflowGates.status} = 'pending'
    )`,
  };
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
  expectedRequired?: number,
): Promise<{
  /** False when a conditional policy write lost to another owner request. */
  applied: boolean;
  /** Pending gates whose reconciled package verdicts now resolve the aggregate. */
  readyGates: Array<{ id: string; decision: "approved" | "rejected" }>;
  changedScans: ReconciledScanDecision[];
}> {
  const normalized = normalizeRequiredApprovals(required);
  const normalizedExpected =
    expectedRequired === undefined ? null : normalizeRequiredApprovals(expectedRequired);
  // Route callers pass the policy they authorized. When the requested value
  // already equals that value, this is recovery work rather than a policy
  // transition: re-check projections and ready gates, but do not rewrite the
  // policy row or invalidate in-flight gate decisions.
  const changesPolicy = normalizedExpected === null || normalizedExpected !== normalized;
  const now = new Date();
  const projection = approvalProjectionSql(organizationId);
  const { voterIsCurrentMember, scanHasVotes: hasVotes, scanHasBlock: hasBlock } = projection;
  const approvalCount = projection.eligibleApprovalCount;
  // A completed workflow gate is irreversible. Reconcile ordinary staged
  // decisions and packages whose held gate is still pending, but never rewrite
  // the historical package decisions behind a GitHub job that already shipped.
  const policyStillApplies = or(ne(scans.source, "workflow_gate"), projection.scanGateIsPending)!;
  const policyIsCurrent = sql`exists (
    select 1
    from ${organizations}
    where ${organizations.id} = ${organizationId}
      and ${organizations.requiredReleaseApprovals} = ${normalized}
  )`;
  const target = and(
    eq(scans.organizationId, organizationId),
    hasVotes,
    policyStillApplies,
    policyIsCurrent,
  )!;
  // A package approved before vote rows existed is still live while its gate
  // remains pending. Once the bar rises above one, that legacy projection has
  // no roster that can prove the new quorum, so reopen it in the same policy
  // batch. Leaving it as `publish` would deadlock the gate: the aggregate CAS
  // rejects the empty roster, while the vote route treats the package as
  // already decided and gives no member a first approval to retry.
  const unsupportedLegacyGateApproval = and(
    eq(scans.organizationId, organizationId),
    eq(scans.source, "workflow_gate"),
    eq(scans.decision, "publish"),
    sql`not ${hasVotes}`,
    policyStillApplies,
    policyIsCurrent,
    sql`${normalized} > 1`,
  )!;
  const latestVote = (
    decision: ScanDecision,
    column: "reason" | "user_id" | "updated_at",
    currentMemberOnly = true,
  ) =>
    sql`(
      select ${sql.identifier(column)}
      from ${scanApprovals}
      where ${scanApprovals.scanId} = ${scans.id}
        and ${scanApprovals.organizationId} = ${organizationId}
        and ${scanApprovals.decision} = ${decision}
        ${currentMemberOnly ? sql`and ${voterIsCurrentMember}` : sql``}
      order by ${scanApprovals.updatedAt} desc, ${scanApprovals.id} desc
      limit 1
    )`;

  // D1 batches are transactional: readers never observe the new policy paired
  // with verdicts derived from the old one. Blocks are applied first, approvals
  // second, and the remaining unsupported verdicts are cleared last.
  const [updatedPolicy, , blocked, approved, undecided] = await db.batch([
    db
      .update(organizations)
      .set({ requiredReleaseApprovals: normalized, updatedAt: now })
      .where(
        and(
          eq(organizations.id, organizationId),
          changesPolicy ? undefined : sql`0`,
          normalizedExpected === null
            ? undefined
            : eq(organizations.requiredReleaseApprovals, normalizedExpected),
        ),
      )
      .returning({ id: organizations.id }),
    // A gate decision request authorizes one exact pending-gate generation
    // before its TOTP step-up. Advance that generation in the same transaction
    // as the policy so a vote cannot land after reconciliation has already
    // evaluated the old roster under the new bar.
    db
      .update(githubWorkflowGates)
      .set({
        updatedAt: sql`max(${githubWorkflowGates.updatedAt} + 1, ${now.getTime()})`,
      })
      .where(
        and(
          eq(githubWorkflowGates.organizationId, organizationId),
          eq(githubWorkflowGates.status, "pending"),
          changesPolicy ? policyIsCurrent : sql`0`,
        ),
      ),
    db
      .update(scans)
      .set({
        decision: "no_publish",
        decisionReason: latestVote("no_publish", "reason", false),
        decidedByUserId: latestVote("no_publish", "user_id", false),
        decidedAt: now,
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
        decidedAt: now,
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
        or(
          and(
            target,
            sql`not ${hasBlock}`,
            sql`${approvalCount} < ${normalized}`,
            isNotNull(scans.decision),
          ),
          unsupportedLegacyGateApproval,
        ),
      )
      .returning(RECONCILED_SCAN_COLUMNS),
  ]);

  const readyGates = await listReadyPendingGates(db, organizationId);
  const changedScans = [...blocked, ...approved, ...undecided];
  const changedCounts = await countScanApprovals(
    db,
    organizationId,
    changedScans.map((scan) => scan.id),
  );
  return {
    applied: updatedPolicy.length > 0,
    readyGates,
    changedScans: changedScans.map((scan) => ({
      ...scan,
      approvalCount: changedCounts.get(scan.id)?.eligibleApproved ?? 0,
    })),
  };
}

export interface ReadyPendingGate {
  id: string;
  decision: "approved" | "rejected";
}

/**
 * Pending gates whose current package projections already resolve the
 * aggregate: fail-closed rejection when any package carries a durable voted
 * block, approval when every package has met the live bar.
 *
 * This is the one definition of "a gate someone should finalize". Every event
 * that can move a projection without a decision request attached — a policy
 * change, a member rejoining, recovery after an interrupted request — asks
 * this and then drives `finalizeReconciledWorkflowGateDecision`, whose CAS
 * re-proves the roster before anything reaches GitHub.
 */
export async function listReadyPendingGates(
  db: AppDb,
  organizationId: string,
): Promise<ReadyPendingGate[]> {
  const gateHasDurableBlock = sql`exists (
    select 1
    from ${scans}
    inner join ${scanApprovals} on ${scanApprovals.scanId} = ${scans.id}
    where ${scans.gateId} = ${githubWorkflowGates.id}
      and ${scans.organizationId} = ${organizationId}
      and ${scans.decision} = 'no_publish'
      and ${scanApprovals.organizationId} = ${organizationId}
      and ${scanApprovals.decision} = 'no_publish'
  )`;
  const gateHasPackages = sql`exists (
    select 1
    from ${scans}
    where ${scans.gateId} = ${githubWorkflowGates.id}
      and ${scans.organizationId} = ${organizationId}
  )`;
  const gateHasUnapprovedPackage = sql`exists (
    select 1
    from ${scans}
    where ${scans.gateId} = ${githubWorkflowGates.id}
      and ${scans.organizationId} = ${organizationId}
      and (${scans.decision} is null or ${scans.decision} <> 'publish')
  )`;
  return db
    .select({
      id: githubWorkflowGates.id,
      decision: sql<"approved" | "rejected">`case
        when ${gateHasDurableBlock} then 'rejected'
        else 'approved'
      end`,
    })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.organizationId, organizationId),
        eq(githubWorkflowGates.status, "pending"),
        gateHasPackages,
        or(
          gateHasDurableBlock,
          and(isNotNull(githubWorkflowGates.scanId), sql`not ${gateHasUnapprovedPackage}`),
        ),
      ),
    );
}

const RECONCILED_SCAN_COLUMNS = {
  id: scans.id,
  source: scans.source,
  gateId: scans.gateId,
  packageName: scans.packageName,
  summaryJson: scans.summaryJson,
  publicFeedListedAt: scans.publicFeedListedAt,
  publicPackageKey: scans.publicPackageKey,
  decision: scans.decision,
  decisionReason: scans.decisionReason,
  decidedByUserId: scans.decidedByUserId,
  decidedAt: scans.decidedAt,
  createdAt: scans.createdAt,
  risk: scans.risk,
  riskSummaryJson: scans.riskSummaryJson,
  aiJson: scans.aiJson,
} as const;

/**
 * Add (or restore) a member and immediately re-project any retained approvals
 * that become eligible because of that membership row.
 *
 * Final staged decisions keep their historical vote roster when someone
 * leaves. If a later policy increase reopens one of those releases, accepting
 * a new invitation can make the former member's retained vote live again. The
 * membership write and the resulting null -> publish transitions therefore
 * belong in one D1 batch; otherwise the approval state can report a sufficient
 * tally while `scans.decision` remains null indefinitely.
 */
export async function addMemberAndReconcileApprovals(
  db: AppDb,
  input: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<ReconciledScanDecision[]> {
  const now = new Date();
  const projection = approvalProjectionSql(input.organizationId);
  const addedMemberHasVote = sql`exists (
    select 1
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${scans.id}
      and ${scanApprovals.organizationId} = ${input.organizationId}
      and ${scanApprovals.userId} = ${input.userId}
      and ${scanApprovals.decision} = 'publish'
  )`;
  const addedMemberApprovalReason = sql`(
    select ${scanApprovals.reason}
    from ${scanApprovals}
    where ${scanApprovals.scanId} = ${scans.id}
      and ${scanApprovals.organizationId} = ${input.organizationId}
      and ${scanApprovals.userId} = ${input.userId}
      and ${scanApprovals.decision} = 'publish'
    limit 1
  )`;

  const [, approved] = await db.batch([
    db
      .insert(organizationMembers)
      .values({
        id: `member:${input.organizationId}:${input.userId}`,
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationMembers.organizationId, organizationMembers.userId],
        set: { role: input.role, updatedAt: now },
      }),
    db
      .update(scans)
      .set({
        decision: "publish",
        decisionReason: addedMemberApprovalReason,
        // This retained vote became decisive when its voter rejoined. Keep the
        // canonical projection and the member-joined audit event attributed to
        // the same person rather than to an unrelated, more recent approver.
        decidedByUserId: input.userId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(scans.organizationId, input.organizationId),
          isNull(scans.decision),
          addedMemberHasVote,
          sql`not ${projection.scanHasBlock}`,
          sql`${projection.eligibleApprovalCount} >= ${projection.requiredApprovals}`,
          or(ne(scans.source, "workflow_gate"), projection.scanGateIsPending),
        ),
      )
      .returning(RECONCILED_SCAN_COLUMNS),
  ]);
  const counts = await countScanApprovals(
    db,
    input.organizationId,
    approved.map((scan) => scan.id),
  );
  return approved.map((scan) => ({
    ...scan,
    approvalCount: counts.get(scan.id)?.eligibleApproved ?? 0,
  }));
}

export interface ScanApprovalVote {
  userId: string | null;
  name: string | null;
  email: string | null;
  decision: ScanDecision;
  reason: string | null;
  createdAt: Date;
  /** The current vote's submission time; changes whenever a staged vote is revised. */
  updatedAt: Date;
  /** False after the voter leaves the organization; retained for historical display only. */
  eligible: boolean;
}

/** Every current vote on one scan, ordered by latest submission time, with voter identity. */
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
      updatedAt: scanApprovals.updatedAt,
      name: user.name,
      email: user.email,
      eligibleUserId: organizationMembers.userId,
    })
    .from(scanApprovals)
    .leftJoin(user, eq(user.id, scanApprovals.userId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, scanApprovals.userId),
      ),
    )
    .where(and(eq(scanApprovals.scanId, scanId), eq(scanApprovals.organizationId, organizationId)))
    .orderBy(scanApprovals.updatedAt, scanApprovals.id);
  return rows.map((row) => ({
    userId: row.userId,
    name: row.name ?? null,
    email: row.email ?? null,
    decision: row.decision === "no_publish" ? "no_publish" : "publish",
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    eligible: row.eligibleUserId !== null,
  }));
}

export interface ScanApprovalCounts {
  approved: number;
  blocked: number;
  eligibleApproved: number;
  eligibleBlocked: number;
  viewerDecision: ScanDecision | null;
}

/** Approval counts for a page of scans, keyed by scan id. Empty ids → empty map. */
export async function countScanApprovals(
  db: AppDb,
  organizationId: string,
  scanIds: string[],
  viewerUserId?: string | null,
): Promise<Map<string, ScanApprovalCounts>> {
  const counts = new Map<string, ScanApprovalCounts>();
  if (!scanIds.length) return counts;
  // A full review page is 100 scans and D1 caps a statement at 100 bound
  // parameters, so the id list has to be chunked (two slots reserved for the
  // organization id in the outer filter and membership predicate, plus one
  // when resolving the viewer's vote) or the busiest page of the queue throws.
  for (const chunk of chunkForD1([...new Set(scanIds)], 1, viewerUserId ? 3 : 2)) {
    const rows = await db
      .select({
        scanId: scanApprovals.scanId,
        decision: scanApprovals.decision,
        total: sql<number>`count(*)`,
        eligibleTotal: sql<number>`sum(case when ${approvalVoterIsCurrentMember(
          organizationId,
        )} then 1 else 0 end)`,
        viewerTotal: viewerUserId
          ? sql<number>`sum(case when ${scanApprovals.userId} = ${viewerUserId} then 1 else 0 end)`
          : sql<number>`0`,
      })
      .from(scanApprovals)
      .where(
        and(eq(scanApprovals.organizationId, organizationId), inArray(scanApprovals.scanId, chunk)),
      )
      .groupBy(scanApprovals.scanId, scanApprovals.decision);
    for (const row of rows) {
      const entry = counts.get(row.scanId) ?? {
        approved: 0,
        blocked: 0,
        eligibleApproved: 0,
        eligibleBlocked: 0,
        viewerDecision: null,
      };
      if (row.decision === "no_publish") {
        entry.blocked += Number(row.total);
        entry.eligibleBlocked += Number(row.eligibleTotal);
      } else {
        entry.approved += Number(row.total);
        entry.eligibleApproved += Number(row.eligibleTotal);
      }
      if (Number(row.viewerTotal) > 0) {
        entry.viewerDecision = row.decision === "no_publish" ? "no_publish" : "publish";
      }
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
    source?: string | null;
    gateId?: string | null;
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
        // The roster displays the time attached to the vote it is showing. A
        // staged reviewer may replace their decision and reason, so the
        // original insert time would misdate the revised vote.
        createdAt: vote.updatedAt,
        eligible: vote.eligible,
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
  const legacyDecision = votes.length === 0 && decision !== null;
  // A decided release keeps its historical count. Once a policy change or
  // revised vote reopens it, former members remain visible in the roster but
  // stop contributing to the live quorum.
  const countedApprovals =
    votes.length && decision === null
      ? approvals.filter((_, index) => votes[index]?.eligible)
      : approvals;
  return {
    required: policy.required,
    approvedCount: countedApprovals.filter((entry) => entry.decision === "publish").length,
    blockedCount: countedApprovals.filter((entry) => entry.decision === "no_publish").length,
    verdict: decision,
    legacyDecision,
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
  const [votes, livePolicy, completedGate] = await Promise.all([
    listScanApprovalVotes(db, input.scanId, input.organizationId),
    input.policy
      ? Promise.resolve(input.policy)
      : getOrganizationApprovalPolicy(db, input.organizationId),
    input.scan.source === "workflow_gate" && input.scan.gateId
      ? db
          .select({
            status: githubWorkflowGates.status,
            required: githubWorkflowGates.requiredReleaseApprovals,
          })
          .from(githubWorkflowGates)
          .where(
            and(
              eq(githubWorkflowGates.id, input.scan.gateId),
              eq(githubWorkflowGates.organizationId, input.organizationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  // Completed gates are historical release records. Rows completed before the
  // snapshot column existed used the only policy available then: one approval.
  const policy =
    completedGate && completedGate.status !== "pending"
      ? { ...livePolicy, required: completedGate.required ?? 1 }
      : livePolicy;
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
  /** Gate votes may only be written while this organization-scoped gate is pending. */
  pendingGateId?: string;
  /** Generation observed before the gate decision request performed step-up. */
  pendingGateUpdatedAt?: Date;
}

export type UpsertScanApprovalOutcome =
  | "recorded"
  | "already_voted"
  | "not_member"
  | "not_actionable";

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
  // Select the candidate row from live membership instead of inserting plain
  // values. The membership proof, optional pending-gate proof, and write are
  // one SQLite statement: a request authorized just before member removal or
  // gate finalization cannot leave a vote that becomes eligible after a later
  // re-invite or appears in a completed gate's historical roster.
  const candidate = db
    .select({
      id: sql<string>`${crypto.randomUUID()}`.as("id"),
      scanId: sql<string>`${input.scanId}`.as("scan_id"),
      organizationId: organizationMembers.organizationId,
      userId: organizationMembers.userId,
      decision: sql<string>`${input.decision}`.as("decision"),
      reason: sql<string | null>`${input.reason}`.as("reason"),
      // INSERT ... SELECT expressions bypass the target column's timestamp
      // mapper, so bind D1's integer representation explicitly.
      createdAt: sql<Date>`${input.now.getTime()}`.as("created_at"),
      updatedAt: sql<Date>`${input.now.getTime()}`.as("updated_at"),
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.userId),
        input.pendingGateId
          ? sql`exists (
              select 1
              from ${githubWorkflowGates}
              where ${githubWorkflowGates.id} = ${input.pendingGateId}
                and ${githubWorkflowGates.organizationId} = ${input.organizationId}
                and ${githubWorkflowGates.status} = 'pending'
                ${input.pendingGateUpdatedAt ? sql`and ${githubWorkflowGates.updatedAt} = ${input.pendingGateUpdatedAt.getTime()}` : sql``}
            )`
          : undefined,
      ),
    )
    .limit(1);
  const recorded = await db
    .insert(scanApprovals)
    .select(candidate)
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
  if (recorded.length > 0) return "recorded";

  const [member] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (!member) return "not_member";
  if (input.pendingGateId) {
    const [pendingGate] = await db
      .select({ id: githubWorkflowGates.id })
      .from(githubWorkflowGates)
      .where(
        and(
          eq(githubWorkflowGates.id, input.pendingGateId),
          eq(githubWorkflowGates.organizationId, input.organizationId),
          eq(githubWorkflowGates.status, "pending"),
          input.pendingGateUpdatedAt
            ? eq(githubWorkflowGates.updatedAt, input.pendingGateUpdatedAt)
            : undefined,
        ),
      )
      .limit(1);
    if (!pendingGate) return "not_actionable";
  }
  return "already_voted";
}

/**
 * Remove a member and every vote that can still affect an unfinished release.
 *
 * This is one D1 batch so a transient cleanup failure cannot leave the member
 * deleted but their pending vote ready to become eligible on a later re-invite.
 * A package may already read `publish` while a sibling keeps its workflow gate
 * pending; those package approvals are still live release state, so delete the
 * departing member's vote and reopen the package when the remaining roster no
 * longer meets the bar. Final staged decisions and completed gates keep their
 * historical roster, and blocks remain final.
 */
export async function removeMemberAndReconcileApprovals(
  db: AppDb,
  organizationId: string,
  userId: string,
): Promise<{ removed: boolean; changedScans: ReconciledScanProjection[] }> {
  return removeMembershipsAndReconcileApprovalsCore(db, userId, organizationId);
}

/**
 * Revoke every surviving membership and remove the account's still-live approvals.
 *
 * The membership deletion belongs in the same D1 batch as vote cleanup and
 * projection repair. Otherwise an already-authorized decision request can land
 * a new approval after cleanup but before account deletion removes membership,
 * leaving a pending gate package projected as approved by an ineligible voter.
 */
export async function removeUserMembershipsAndReconcileApprovals(
  db: AppDb,
  userId: string,
): Promise<ReconciledScanProjection[]> {
  const { changedScans } = await removeMembershipsAndReconcileApprovalsCore(db, userId, null);
  return changedScans;
}

/**
 * The one implementation behind both departure shapes: an owner removing a
 * member from one organization, and account deletion revoking every
 * membership at once (`organizationId: null`). Both must delete the departing
 * member's approvals on live release state, keep fail-closed blocks and final
 * rosters, and reopen a pending-gate package whose remaining quorum no longer
 * meets the bar — in one D1 batch with the membership deletion, so an
 * interrupted request cannot leave a stale vote that becomes eligible again
 * after a later re-invite.
 */
async function removeMembershipsAndReconcileApprovalsCore(
  db: AppDb,
  userId: string,
  organizationId: string | null,
): Promise<{ removed: boolean; changedScans: ReconciledScanProjection[] }> {
  const now = new Date();
  const projection = approvalProjectionSql(organizationId);
  const mutableScans = db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        organizationId === null ? undefined : eq(scans.organizationId, organizationId),
        or(
          isNull(scans.decision),
          and(
            eq(scans.source, "workflow_gate"),
            eq(scans.decision, "publish"),
            projection.scanGateIsPending,
          ),
        ),
      ),
    );

  const [removed, , reopened] = await db.batch([
    db
      .delete(organizationMembers)
      .where(
        and(
          organizationId === null
            ? undefined
            : eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .returning({ id: organizationMembers.id }),
    // Run even when the membership row was already removed by an interrupted
    // request. That makes retrying the operation repair stale approval state.
    db.delete(scanApprovals).where(
      and(
        organizationId === null ? undefined : eq(scanApprovals.organizationId, organizationId),
        eq(scanApprovals.userId, userId),
        // A block is durable even when its scan projection has not caught up
        // yet (for example, interruption immediately after the vote insert).
        // Departures invalidate approvals, never fail-closed blocks.
        eq(scanApprovals.decision, "publish"),
        inArray(scanApprovals.scanId, mutableScans),
      ),
    ),
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
          organizationId === null ? undefined : eq(scans.organizationId, organizationId),
          eq(scans.source, "workflow_gate"),
          eq(scans.decision, "publish"),
          projection.scanGateIsPending,
          sql`${projection.eligibleApprovalCount} < ${projection.requiredApprovals}`,
        ),
      )
      .returning(RECONCILED_SCAN_COLUMNS),
  ]);
  return { removed: removed.length > 0, changedScans: reopened };
}
