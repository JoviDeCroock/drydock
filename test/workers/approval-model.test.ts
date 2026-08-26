import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember } from "../../server/db/invitations";
import { createOrganization, ensurePersonalOrganization } from "../../server/db/organizations";
import {
  addMemberAndReconcileApprovals,
  removeMemberAndReconcileApprovals,
  removeUserMembershipsAndReconcileApprovals,
  setRequiredReleaseApprovals,
  upsertScanApproval,
} from "../../server/db/scan-approvals";
import {
  recordGatePackageDecision,
  recordScanDecision,
  type ScanDecision,
} from "../../server/db/scan-decisions";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { markGateDecidedForPackageAggregate } from "../../server/lib/github-app/webhook-gates";

// Model-based interleaving test for multi-party release approval.
//
// Every reviewed bug on this feature had the same shape: some event changed an
// input to the derived approval state (a vote, a membership row, the policy)
// without fully re-running the projection or its gate side effects. Rather than
// sampling that space one hand-written scenario at a time, this suite runs
// seeded-random sequences of the real mutation functions against D1 and checks
// the persisted state after every event against a pure-JS oracle of the
// documented semantics (docs/release-approvals.md).
//
// The oracle is deliberately an independent re-statement of the spec: when this
// suite fails, either the SQL or the spec understanding is wrong, and both are
// worth knowing. Failures print the seed and the full event trace, so any
// counterexample replays deterministically.
//
// Scope: events run sequentially (each awaited), so this exercises event-order
// interleavings and crash-shaped partial writes (a durable vote whose
// projection write never ran, a policy transaction whose gate finalization was
// interrupted) — the class every review round found. It does not exercise
// truly simultaneous statements; those races are guarded by the in-SQL CAS
// predicates, which sequential replays still evaluate.

const DECISIONS: ScanDecision[] = ["publish", "no_publish"];

/** Deterministic PRNG so every failure is replayable from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface OracleVote {
  decision: ScanDecision;
}

type Projection = ScanDecision | null;

/**
 * Pure model of the approval state machine. Facts (votes, membership, policy)
 * are the inputs; `projection` mirrors what `scans.decision` must read, and
 * `gateStatus` mirrors the aggregate gate row.
 */
class Oracle {
  members = new Set<string>();
  policy = 1;
  /** scanId -> userId -> durable vote row. */
  votes = new Map<string, Map<string, OracleVote>>();
  /** scanId -> expected `scans.decision`. */
  projection = new Map<string, Projection>();
  gateStatus: "pending" | "approved" | "rejected" = "pending";
  /** The policy live at the finalize CAS — what the completed gate must snapshot. */
  gateSnapshotRequired: number | null = null;
  /** Bumped whenever the pending gate's decision generation advances. */
  gateGenerationAdvanced = false;

  constructor(
    readonly ownerUserId: string,
    memberUserIds: string[],
    readonly stagedScanIds: string[],
    readonly gatePackageScanIds: string[],
  ) {
    this.members.add(ownerUserId);
    for (const id of memberUserIds) this.members.add(id);
    for (const id of [...stagedScanIds, ...gatePackageScanIds]) {
      this.votes.set(id, new Map());
      this.projection.set(id, null);
    }
  }

  allScanIds(): string[] {
    return [...this.stagedScanIds, ...this.gatePackageScanIds];
  }

  isGatePackage(scanId: string): boolean {
    return this.gatePackageScanIds.includes(scanId);
  }

  hasBlock(scanId: string): boolean {
    return [...this.votes.get(scanId)!.values()].some((vote) => vote.decision === "no_publish");
  }

  /** Publish votes whose voter is still an organization member. */
  eligibleApprovals(scanId: string): number {
    let count = 0;
    for (const [userId, vote] of this.votes.get(scanId)!) {
      if (vote.decision === "publish" && this.members.has(userId)) count += 1;
    }
    return count;
  }

  /** The verdict the current facts produce: block wins, then quorum, then null. */
  verdict(scanId: string): Projection {
    if (this.hasBlock(scanId)) return "no_publish";
    return this.eligibleApprovals(scanId) >= this.policy ? "publish" : null;
  }

  /** The aggregate-approve CAS predicate of `markGateDecidedForPackageAggregate`. */
  gateApproveWouldCommit(): boolean {
    if (this.gateStatus !== "pending") return false;
    return this.gatePackageScanIds.every((scanId) => {
      if (this.projection.get(scanId) !== "publish") return false;
      if (this.hasBlock(scanId)) return false;
      const hasVotes = this.votes.get(scanId)!.size > 0;
      if ((this.policy > 1 || hasVotes) && this.eligibleApprovals(scanId) < this.policy) {
        return false;
      }
      return true;
    });
  }

  /** The aggregate-reject CAS predicate: some package projected as blocked. */
  gateRejectWouldCommit(): boolean {
    if (this.gateStatus !== "pending") return false;
    return this.gatePackageScanIds.some((scanId) => this.projection.get(scanId) === "no_publish");
  }

  /** Staged vote: freely revisable; the projection is re-derived every time. */
  applyStagedVote(userId: string, scanId: string, decision: ScanDecision): void {
    if (!this.members.has(userId)) return;
    this.votes.get(scanId)!.set(userId, { decision });
    this.projection.set(scanId, this.verdict(scanId));
  }

  /** Staged vote whose request died right after the vote row became durable. */
  applyCrashedStagedVote(userId: string, scanId: string, decision: ScanDecision): void {
    if (!this.members.has(userId)) return;
    this.votes.get(scanId)!.set(userId, { decision });
  }

  /**
   * Gate vote: fail-closed revisions only, and both the vote row and the
   * projection write prove the gate is still pending.
   */
  applyGateVote(userId: string, scanId: string, decision: ScanDecision): void {
    if (this.gateStatus !== "pending") return;
    const projection = this.projection.get(scanId);
    const myVote = this.votes.get(scanId)!.get(userId);
    // The route's `blockableDecision` read guard.
    const actionable =
      decision === "no_publish"
        ? projection === null ||
          (projection === "publish" && this.policy > 1) ||
          (projection === "no_publish" && myVote?.decision === "no_publish")
        : projection === null || (projection === "publish" && myVote?.decision === "publish");
    if (!actionable) return;
    if (!this.members.has(userId)) return;
    this.applyCrashedGateVote(userId, scanId, decision);
    // Projection transition, constrained to the gate path's permitted edges.
    const verdict = this.verdict(scanId);
    if (verdict === projection) return;
    if (verdict === "publish" && projection !== null) return;
    if (verdict === "no_publish" && projection === "publish" && this.policy <= 1) return;
    this.projection.set(scanId, verdict);
  }

  /** Gate vote whose request died right after the vote row became durable. */
  applyCrashedGateVote(userId: string, scanId: string, decision: ScanDecision): void {
    if (this.gateStatus !== "pending") return;
    if (!this.members.has(userId)) return;
    const myVote = this.votes.get(scanId)!.get(userId);
    if (!myVote) {
      this.votes.get(scanId)!.set(userId, { decision });
    } else if (myVote.decision === "publish" && decision === "no_publish") {
      // hardenOnly: the only permitted revision is the fail-closed direction.
      this.votes.get(scanId)!.set(userId, { decision });
    }
  }

  /**
   * Membership loss (removal or account deletion): approvals on live scans are
   * withdrawn, blocks stay durable, and a pending-gate package whose remaining
   * quorum no longer meets the bar reopens. Final staged decisions keep their
   * historical roster.
   */
  applyMembershipLoss(userId: string): void {
    this.members.delete(userId);
    for (const scanId of this.allScanIds()) {
      const scanIsMutable =
        this.projection.get(scanId) === null ||
        (this.isGatePackage(scanId) &&
          this.projection.get(scanId) === "publish" &&
          this.gateStatus === "pending");
      if (!scanIsMutable) continue;
      const vote = this.votes.get(scanId)!.get(userId);
      if (vote?.decision === "publish") this.votes.get(scanId)!.delete(userId);
    }
    for (const scanId of this.gatePackageScanIds) {
      if (this.gateStatus !== "pending") continue;
      if (this.projection.get(scanId) !== "publish") continue;
      if (this.eligibleApprovals(scanId) < this.policy) this.projection.set(scanId, null);
    }
  }

  /**
   * Membership (re)gain: a retained publish vote from the joining member can
   * complete a quorum immediately, on undecided staged scans and pending-gate
   * packages alike.
   */
  applyMembershipGain(userId: string): void {
    this.members.add(userId);
    for (const scanId of this.allScanIds()) {
      if (this.projection.get(scanId) !== null) continue;
      if (this.isGatePackage(scanId) && this.gateStatus !== "pending") continue;
      const vote = this.votes.get(scanId)!.get(userId);
      if (vote?.decision !== "publish") continue;
      if (this.hasBlock(scanId)) continue;
      if (this.eligibleApprovals(scanId) >= this.policy) this.projection.set(scanId, "publish");
    }
  }

  /**
   * Policy transition: every voted staged scan and every voted package behind a
   * still-pending gate is re-derived under the new bar in the same transaction.
   */
  applyPolicy(required: number): void {
    const changesPolicy = required !== this.policy;
    this.policy = required;
    if (changesPolicy && this.gateStatus === "pending") this.gateGenerationAdvanced = true;
    for (const scanId of this.allScanIds()) {
      if (this.votes.get(scanId)!.size === 0) continue;
      if (this.isGatePackage(scanId) && this.gateStatus !== "pending") continue;
      this.projection.set(scanId, this.verdict(scanId));
    }
  }

  applyGateFinalized(decision: "approved" | "rejected"): void {
    this.gateStatus = decision;
    this.gateSnapshotRequired = this.policy;
  }
}

interface World {
  organizationId: string;
  ownerUserId: string;
  userIds: string[];
  stagedScanIds: string[];
  gateId: string;
  gatePackageScanIds: string[];
  /** The gate generation a stale, pre-policy-change request would have authorized. */
  initialGateUpdatedAt: Date;
  oracle: Oracle;
}

async function seedUser(): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: `Reviewer ${userId.slice(-6)}`,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await ensurePersonalOrganization(db, { userId });
  return userId;
}

async function seedStagedScan(organizationId: string, ownerUserId: string): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId,
    ownerUserId,
    source: "manual",
  });
  await persistScan(db, {
    id: scanId,
    stageId: `stage-${scanId.slice(-12)}`,
    organizationId,
    ownerUserId,
    packageJson: { name: "@org/pkg", version: "1.2.3" },
    risk: "low",
    status: "complete",
    summary: { ok: true },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    report: { version: 1, digest: "digest" },
  });
  return scanId;
}

async function seedGateWorld(organizationId: string, ownerUserId: string) {
  const db = createDb(env.DB);
  const now = new Date();
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: `${Math.floor(now.getTime() % 1e9)}-${crypto.randomUUID().slice(0, 8)}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    repositoryId: 42,
    repositoryFullName: "octo/example",
    environment: "pypi",
    createdByUserId: null,
  });
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: 42,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId: 7,
    deploymentId: 909,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/example/actions/runs/7/deployment_protection_rule",
    eventAction: "requested",
    status: "pending",
    scanId: null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const packageScanIds: string[] = [];
  for (const packageName of ["pkg-a", "pkg-b"]) {
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `workflow-gate:${gateId}:pypi:${packageName}`,
      organizationId,
      ownerUserId,
      source: "workflow_gate",
      gateId,
    });
    await persistScan(db, {
      id: scanId,
      stageId: `workflow-gate:${gateId}:pypi:${packageName}`,
      organizationId,
      ownerUserId,
      packageJson: { name: packageName, version: "1.0.0" },
      previousPackageJson: null,
      risk: "low",
      status: "complete",
      summary: { diff: [] },
      ai: null,
      files: [],
      previousFiles: [],
      diff: [],
      findings: [],
    });
    packageScanIds.push(scanId);
  }
  await db
    .update(schema.githubWorkflowGates)
    .set({ scanId: packageScanIds[0] })
    .where(eq(schema.githubWorkflowGates.id, gateId));
  const [gateRow] = await db
    .select({ updatedAt: schema.githubWorkflowGates.updatedAt })
    .from(schema.githubWorkflowGates)
    .where(eq(schema.githubWorkflowGates.id, gateId))
    .limit(1);
  return { gateId, packageScanIds, initialGateUpdatedAt: gateRow.updatedAt };
}

async function seedWorld(): Promise<World> {
  const db = createDb(env.DB);
  const ownerUserId = await seedUser();
  const memberUserIds = [await seedUser(), await seedUser(), await seedUser()];
  const organizationId = await createOrganization(db, {
    ownerUserId,
    name: `Model Org ${crypto.randomUUID().slice(0, 8)}`,
  });
  for (const userId of memberUserIds) {
    await addOrganizationMember(db, { organizationId, userId, role: "member" });
  }
  const stagedScanIds = [
    await seedStagedScan(organizationId, ownerUserId),
    await seedStagedScan(organizationId, ownerUserId),
  ];
  const gate = await seedGateWorld(organizationId, ownerUserId);
  return {
    organizationId,
    ownerUserId,
    userIds: [ownerUserId, ...memberUserIds],
    stagedScanIds,
    gateId: gate.gateId,
    gatePackageScanIds: gate.packageScanIds,
    initialGateUpdatedAt: gate.initialGateUpdatedAt,
    oracle: new Oracle(ownerUserId, memberUserIds, stagedScanIds, gate.packageScanIds),
  };
}

async function readPersistedState(world: World) {
  const db = createDb(env.DB);
  const scanRows = await db
    .select({ id: schema.scans.id, decision: schema.scans.decision })
    .from(schema.scans)
    .where(eq(schema.scans.organizationId, world.organizationId));
  const voteRows = await db
    .select({
      scanId: schema.scanApprovals.scanId,
      userId: schema.scanApprovals.userId,
      decision: schema.scanApprovals.decision,
    })
    .from(schema.scanApprovals)
    .where(eq(schema.scanApprovals.organizationId, world.organizationId));
  const [gateRow] = await db
    .select({
      status: schema.githubWorkflowGates.status,
      required: schema.githubWorkflowGates.requiredReleaseApprovals,
      updatedAt: schema.githubWorkflowGates.updatedAt,
    })
    .from(schema.githubWorkflowGates)
    .where(eq(schema.githubWorkflowGates.id, world.gateId))
    .limit(1);
  const decisions = new Map(scanRows.map((row) => [row.id, row.decision]));
  const votes = new Map<string, Map<string, string>>();
  for (const row of voteRows) {
    if (!votes.has(row.scanId)) votes.set(row.scanId, new Map());
    if (row.userId) votes.get(row.scanId)!.set(row.userId, row.decision);
  }
  return { decisions, votes, gate: gateRow };
}

function checkInvariants(
  world: World,
  persisted: Awaited<ReturnType<typeof readPersistedState>>,
  context: string,
) {
  const { oracle } = world;
  for (const scanId of oracle.allScanIds()) {
    expect(persisted.decisions.get(scanId) ?? null, `${context}\nscan ${scanId} projection`).toBe(
      oracle.projection.get(scanId),
    );
    const persistedVotes = persisted.votes.get(scanId) ?? new Map<string, string>();
    const oracleVotes = oracle.votes.get(scanId)!;
    expect(persistedVotes.size, `${context}\nscan ${scanId} vote count`).toBe(oracleVotes.size);
    for (const [userId, vote] of oracleVotes) {
      expect(persistedVotes.get(userId), `${context}\nscan ${scanId} vote by ${userId}`).toBe(
        vote.decision,
      );
    }
  }
  expect(persisted.gate.status, `${context}\ngate status`).toBe(oracle.gateStatus);
  // Fail-closed: a durable block on any package must never coexist with an
  // approved gate, no matter what sequence of events produced the state.
  if (oracle.gatePackageScanIds.some((scanId) => oracle.hasBlock(scanId))) {
    expect(persisted.gate.status, `${context}\nblocked package on approved gate`).not.toBe(
      "approved",
    );
  }
  if (persisted.gate.status !== "pending") {
    // A completed gate is a historical record: members may leave afterwards
    // without retroactively weakening it, but the snapshot must equal the
    // policy that was live at the finalize CAS. Quorum at that instant is
    // already enforced by `attemptGateFinalize` asserting the CAS outcome
    // against the oracle's predicate.
    expect(persisted.gate.required, `${context}\ngate policy snapshot`).toBe(
      oracle.gateSnapshotRequired,
    );
  }
}

/** Mimics `finalizeReconciledWorkflowGateDecision`'s approve-then-reject CAS. */
async function attemptGateFinalize(world: World, preferred: "approved" | "rejected") {
  const db = createDb(env.DB);
  const order: Array<"approved" | "rejected"> =
    preferred === "approved" ? ["approved", "rejected"] : ["rejected"];
  for (const decision of order) {
    const wouldCommit =
      decision === "approved"
        ? world.oracle.gateApproveWouldCommit()
        : world.oracle.gateRejectWouldCommit();
    const decided = await markGateDecidedForPackageAggregate(db, {
      gateId: world.gateId,
      organizationId: world.organizationId,
      decision,
      comment: `model finalize ${decision}`,
      reportUrl: null,
    });
    expect(decided !== null, `gate ${decision} CAS matched oracle predicate`).toBe(wouldCommit);
    if (decided) {
      world.oracle.applyGateFinalized(decision);
      return;
    }
  }
}

async function runPolicyChange(world: World, required: number, finalizeReadyGates: boolean) {
  const db = createDb(env.DB);
  const result = await setRequiredReleaseApprovals(
    db,
    world.organizationId,
    required,
    world.oracle.policy,
  );
  world.oracle.applyPolicy(required);
  if (!finalizeReadyGates) return;
  for (const readyGate of result.readyGates) {
    if (readyGate.id !== world.gateId) continue;
    await attemptGateFinalize(world, readyGate.decision);
  }
}

interface EventOutcome {
  label: string;
}

/** One randomized event against the real persistence layer plus the oracle. */
async function runRandomEvent(world: World, random: () => number): Promise<EventOutcome> {
  const db = createDb(env.DB);
  const { oracle } = world;
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const user = pick(world.userIds);
  const decision = pick(DECISIONS);
  const roll = random();

  if (roll < 0.28) {
    const scanId = pick(world.stagedScanIds);
    await recordScanDecision(
      db,
      {
        scanId,
        organizationId: world.organizationId,
        actorUserId: user,
        decision,
        reason: `staged ${decision} by ${user.slice(-6)}`,
      },
      env.ARTIFACTS,
    );
    oracle.applyStagedVote(user, scanId, decision);
    return { label: `staged_vote ${user.slice(-6)} ${scanId.slice(-6)} ${decision}` };
  }

  if (roll < 0.52) {
    const scanId = pick(world.gatePackageScanIds);
    const [gateRow] = await db
      .select({
        status: schema.githubWorkflowGates.status,
        updatedAt: schema.githubWorkflowGates.updatedAt,
      })
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, world.gateId))
      .limit(1);
    if (gateRow.status === "pending") {
      await recordGatePackageDecision(
        db,
        {
          scanId,
          organizationId: world.organizationId,
          actorUserId: user,
          decision,
          reason: `gate ${decision} by ${user.slice(-6)}`,
          gateId: world.gateId,
          gateUpdatedAt: gateRow.updatedAt,
        },
        env.ARTIFACTS,
      );
      oracle.applyGateVote(user, scanId, decision);
    }
    return { label: `gate_vote ${user.slice(-6)} ${scanId.slice(-6)} ${decision}` };
  }

  if (roll < 0.6) {
    // Crash simulation: the vote row committed, then the request died before
    // re-tallying the projection. Exactly the partial state several review
    // rounds found recovery gaps around.
    const useGate = random() < 0.5;
    const scanId = useGate ? pick(world.gatePackageScanIds) : pick(world.stagedScanIds);
    if (useGate) {
      const [gateRow] = await db
        .select({ updatedAt: schema.githubWorkflowGates.updatedAt })
        .from(schema.githubWorkflowGates)
        .where(eq(schema.githubWorkflowGates.id, world.gateId))
        .limit(1);
      await upsertScanApproval(db, {
        scanId,
        organizationId: world.organizationId,
        userId: user,
        decision,
        reason: null,
        now: new Date(),
        hardenOnly: true,
        pendingGateId: world.gateId,
        pendingGateUpdatedAt: gateRow.updatedAt,
      });
      oracle.applyCrashedGateVote(user, scanId, decision);
    } else {
      await upsertScanApproval(db, {
        scanId,
        organizationId: world.organizationId,
        userId: user,
        decision,
        reason: null,
        now: new Date(),
      });
      oracle.applyCrashedStagedVote(user, scanId, decision);
    }
    return { label: `crash_vote ${user.slice(-6)} ${scanId.slice(-6)} ${decision}` };
  }

  if (roll < 0.68) {
    if (user === world.ownerUserId) return { label: "remove_member skipped(owner)" };
    await removeMemberAndReconcileApprovals(db, world.organizationId, user);
    oracle.applyMembershipLoss(user);
    return { label: `remove_member ${user.slice(-6)}` };
  }

  if (roll < 0.76) {
    if (oracle.members.has(user)) return { label: "rejoin_member skipped(current)" };
    await addMemberAndReconcileApprovals(db, {
      organizationId: world.organizationId,
      userId: user,
      role: "member",
    });
    oracle.applyMembershipGain(user);
    return { label: `rejoin_member ${user.slice(-6)}` };
  }

  if (roll < 0.82) {
    if (user === world.ownerUserId || oracle.members.size === 0) {
      return { label: "delete_account skipped(owner)" };
    }
    await removeUserMembershipsAndReconcileApprovals(db, user);
    oracle.applyMembershipLoss(user);
    return { label: `delete_account ${user.slice(-6)}` };
  }

  if (roll < 0.92) {
    // The route caps the bar at the current member count and never accepts < 1.
    const cap = Math.max(1, oracle.members.size);
    const required = 1 + Math.floor(random() * cap);
    // Crash simulation half the time: the policy transaction committed but the
    // request died before finalizing a now-ready gate.
    const finalize = random() < 0.5;
    await runPolicyChange(world, required, finalize);
    return { label: `set_policy ${required}${finalize ? "" : " crash(no-finalize)"}` };
  }

  if (roll < 0.97) {
    if (oracle.gateStatus !== "pending") return { label: "finalize_gate skipped(decided)" };
    await attemptGateFinalize(world, "approved");
    return { label: "finalize_gate" };
  }

  // A request that authorized the gate's original generation before a policy
  // change advanced it: its vote must not land once the generation moved.
  const scanId = pick(world.gatePackageScanIds);
  const result = await recordGatePackageDecision(
    db,
    {
      scanId,
      organizationId: world.organizationId,
      actorUserId: user,
      decision,
      reason: `stale gate ${decision}`,
      gateId: world.gateId,
      gateUpdatedAt: world.initialGateUpdatedAt,
    },
    env.ARTIFACTS,
  );
  if (oracle.gateGenerationAdvanced || oracle.gateStatus !== "pending") {
    expect(result.outcome, "stale-generation gate vote must not land").toBe("not_actionable");
  } else {
    oracle.applyGateVote(user, scanId, decision);
  }
  return { label: `stale_gate_vote ${user.slice(-6)} ${scanId.slice(-6)} ${decision}` };
}

/**
 * Recovery to a quiet state: retry every durable vote (the documented repair
 * path for an interrupted request), resubmit the live policy (idempotent
 * recovery work per docs/release-approvals.md), then attempt the aggregate CAS.
 */
async function quiesce(world: World): Promise<void> {
  const db = createDb(env.DB);
  const { oracle } = world;
  for (const scanId of oracle.allScanIds()) {
    for (const [userId, vote] of oracle.votes.get(scanId)!) {
      if (oracle.isGatePackage(scanId)) {
        if (oracle.gateStatus !== "pending") continue;
        const [gateRow] = await db
          .select({ updatedAt: schema.githubWorkflowGates.updatedAt })
          .from(schema.githubWorkflowGates)
          .where(eq(schema.githubWorkflowGates.id, world.gateId))
          .limit(1);
        await recordGatePackageDecision(
          db,
          {
            scanId,
            organizationId: world.organizationId,
            actorUserId: userId,
            decision: vote.decision,
            reason: null,
            gateId: world.gateId,
            gateUpdatedAt: gateRow.updatedAt,
          },
          env.ARTIFACTS,
        );
        oracle.applyGateVote(userId, scanId, vote.decision);
      } else {
        await recordScanDecision(
          db,
          {
            scanId,
            organizationId: world.organizationId,
            actorUserId: userId,
            decision: vote.decision,
            reason: null,
          },
          env.ARTIFACTS,
        );
        oracle.applyStagedVote(userId, scanId, vote.decision);
      }
    }
  }
  await runPolicyChange(world, world.oracle.policy, true);
  if (oracle.gateStatus === "pending") await attemptGateFinalize(world, "approved");
}

function assertQuiescedState(world: World, context: string): void {
  const { oracle } = world;
  const anyBlockedPackage = oracle.gatePackageScanIds.some(
    (scanId) => oracle.projection.get(scanId) === "no_publish",
  );
  const everyPackageApproved = oracle.gatePackageScanIds.every(
    (scanId) => oracle.projection.get(scanId) === "publish",
  );
  if (oracle.gateStatus === "pending") {
    // Liveness: a pending gate after full recovery must be genuinely
    // undecidable (some package short of quorum with no block), never a
    // stranded gate that met its bar or carries an unapplied block.
    expect(anyBlockedPackage, `${context}\npending gate with a blocked package`).toBe(false);
    expect(everyPackageApproved, `${context}\npending gate with every package approved`).toBe(
      false,
    );
  }
  if (oracle.gateStatus === "rejected") {
    expect(
      oracle.gatePackageScanIds.some((scanId) => oracle.hasBlock(scanId)),
      `${context}\nrejected gate without any durable block`,
    ).toBe(true);
  }
}

// Seed 306 is kept deliberately: it reaches an approved gate whose approver
// later leaves, the case that distinguishes historical release records from
// live quorum state.
const SEEDS = [7, 33, 59, 85, 111, 306];
const STEPS = 60;

/** Cross-seed coverage accounting, asserted once after the per-seed tests. */
const sweep = {
  gateOutcomes: new Set<string>(),
  stagedOutcomes: new Set<string>(),
  eventKinds: new Set<string>(),
};

describe("approval state-machine model", () => {
  for (const seed of SEEDS) {
    test(`randomized event sequence, seed ${seed}`, async () => {
      const random = mulberry32(seed);
      const world = await seedWorld();
      const trace: string[] = [];
      // Start every run at a multi-party bar; single-approval worlds are also
      // reachable from here via set_policy events.
      await runPolicyChange(world, 2, true);
      trace.push("set_policy 2");

      for (let step = 0; step < STEPS; step += 1) {
        const outcome = await runRandomEvent(world, random);
        trace.push(outcome.label);
        if (!outcome.label.includes("skipped")) {
          sweep.eventKinds.add(outcome.label.split(" ")[0]);
        }
        const context = `seed=${seed} step=${step}\n${trace.join("\n")}`;
        checkInvariants(world, await readPersistedState(world), context);
      }

      await quiesce(world);
      trace.push("quiesce");
      const context = `seed=${seed} after quiesce\n${trace.join("\n")}`;
      const settled = await readPersistedState(world);
      checkInvariants(world, settled, context);
      assertQuiescedState(world, context);

      // Idempotence: recovery on an already-quiet world must change nothing.
      await quiesce(world);
      const again = await readPersistedState(world);
      expect(again.decisions, `${context}\nsecond quiesce changed projections`).toEqual(
        settled.decisions,
      );
      expect(again.votes, `${context}\nsecond quiesce changed votes`).toEqual(settled.votes);
      expect(again.gate.status, `${context}\nsecond quiesce changed gate status`).toBe(
        settled.gate.status,
      );

      sweep.gateOutcomes.add(settled.gate.status);
      for (const scanId of world.stagedScanIds) {
        sweep.stagedOutcomes.add(String(settled.decisions.get(scanId)));
      }
    }, 120_000);
  }

  // The invariants above only bite if the sequences actually reach the
  // interesting states. This pins the fixed-seed sweep to a floor of coverage
  // so a future edit to the event mix cannot quietly hollow the suite out.
  test("sweep reaches diverse outcomes", () => {
    const summary = JSON.stringify({
      gates: [...sweep.gateOutcomes],
      staged: [...sweep.stagedOutcomes],
      events: [...sweep.eventKinds].sort(),
    });
    for (const outcome of ["approved", "rejected"]) {
      expect(sweep.gateOutcomes.has(outcome), `gate ${outcome} never reached: ${summary}`).toBe(
        true,
      );
    }
    for (const outcome of ["publish", "no_publish"]) {
      expect(sweep.stagedOutcomes.has(outcome), `staged ${outcome} never reached: ${summary}`).toBe(
        true,
      );
    }
    for (const kind of [
      "staged_vote",
      "gate_vote",
      "crash_vote",
      "remove_member",
      "rejoin_member",
      "delete_account",
      "set_policy",
      "finalize_gate",
      "stale_gate_vote",
    ]) {
      expect(sweep.eventKinds.has(kind), `event ${kind} never executed: ${summary}`).toBe(true);
    }
  });
});
