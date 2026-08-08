import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type AppDb } from "./client";
import { ciReleaseArtifacts, ciReleaseSets, githubWorkflowGates, scans } from "./schema";

type CiReleaseSetStatus = "open" | "sealed" | "scanning" | "reviewed" | "errored";

export interface CiReleaseSetRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  repositoryId: number;
  repositoryFullName: string;
  runId: number;
  runAttempt: number;
  releaseKey: string;
  ecosystem: string | null;
  sha: string | null;
  ref: string | null;
  workflowRef: string | null;
  jobWorkflowRef: string | null;
  actor: string | null;
  eventName: string | null;
  status: CiReleaseSetStatus;
  artifactCount: number;
  totalBytes: number;
  scanId: string | null;
  reviewStartedAt: Date | null;
  failureReason: string | null;
  verifiedAt: Date | null;
  sealedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CiReleaseArtifactRecord {
  id: string;
  releaseSetId: string;
  organizationId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string | null;
  createdAt: Date;
}

export interface OpenReleaseSetInput {
  organizationId: string;
  installationRowId: string;
  repositoryId: number;
  repositoryFullName: string;
  runId: number;
  runAttempt: number;
  releaseKey: string;
  ecosystem: string | null;
  sha: string | null;
  ref: string | null;
  workflowRef: string | null;
  jobWorkflowRef: string | null;
  actor: string | null;
  eventName: string | null;
}

/**
 * Get-or-create the release set for one workflow run.
 *
 * Every job in a matrix build calls this before uploading, so it must be
 * idempotent on `(organization, repository, run, attempt, releaseKey)` — that
 * is what makes N parallel build jobs converge on one review instead of N.
 * Concurrent creators race on the unique index; the loser re-reads the winner's
 * row rather than failing the job.
 */
export async function openReleaseSet(
  db: AppDb,
  input: OpenReleaseSetInput,
): Promise<{ set: CiReleaseSetRecord; created: boolean }> {
  const existing = await findReleaseSetByRun(db, input);
  if (existing) return { set: existing, created: false };

  const now = new Date();
  const id = crypto.randomUUID();
  try {
    await db.insert(ciReleaseSets).values({
      id,
      organizationId: input.organizationId,
      installationRowId: input.installationRowId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      runId: input.runId,
      runAttempt: input.runAttempt,
      releaseKey: input.releaseKey,
      ecosystem: input.ecosystem,
      sha: input.sha,
      ref: input.ref,
      workflowRef: input.workflowRef,
      jobWorkflowRef: input.jobWorkflowRef,
      actor: input.actor,
      eventName: input.eventName,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Lost the create race against a sibling job in the same run.
    const raced = await findReleaseSetByRun(db, input);
    if (raced) return { set: raced, created: false };
    throw err;
  }
  const fresh = await getReleaseSet(db, input.organizationId, id);
  if (!fresh) throw new Error("release set row vanished immediately after insert");
  return { set: fresh, created: true };
}

async function findReleaseSetByRun(
  db: AppDb,
  input: Pick<
    OpenReleaseSetInput,
    "organizationId" | "repositoryId" | "runId" | "runAttempt" | "releaseKey"
  >,
): Promise<CiReleaseSetRecord | null> {
  const [row] = await db
    .select()
    .from(ciReleaseSets)
    .where(
      and(
        eq(ciReleaseSets.organizationId, input.organizationId),
        eq(ciReleaseSets.repositoryId, input.repositoryId),
        eq(ciReleaseSets.runId, input.runId),
        eq(ciReleaseSets.runAttempt, input.runAttempt),
        eq(ciReleaseSets.releaseKey, input.releaseKey),
      ),
    )
    .limit(1);
  return row ? readSetRow(row) : null;
}

export async function getReleaseSet(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<CiReleaseSetRecord | null> {
  const [row] = await db
    .select()
    .from(ciReleaseSets)
    .where(and(eq(ciReleaseSets.id, id), eq(ciReleaseSets.organizationId, organizationId)))
    .limit(1);
  return row ? readSetRow(row) : null;
}

/**
 * Find the release sets a `deployment_protection_rule` delivery should bind to.
 *
 * The webhook knows only repository + run, so a run that opened several keyed
 * sets returns all of them: the held deployment must wait for every release the
 * run produced, not just the first. Later attempts sort first because a re-run
 * supersedes the attempt before it.
 *
 * Still-`open` sets are deliberately included. A workflow whose upload job
 * finished but whose seal step never ran would otherwise look to the gate like
 * a pull-path release and get its bundle downloaded twice; binding an open set
 * lets the caller seal it instead.
 */
export async function listReleaseSetsForRun(
  db: AppDb,
  input: { organizationId: string; repositoryId: number; runId: number },
): Promise<CiReleaseSetRecord[]> {
  const rows = await db
    .select()
    .from(ciReleaseSets)
    .where(
      and(
        eq(ciReleaseSets.organizationId, input.organizationId),
        eq(ciReleaseSets.repositoryId, input.repositoryId),
        eq(ciReleaseSets.runId, input.runId),
      ),
    )
    .orderBy(desc(ciReleaseSets.runAttempt));
  if (rows.length === 0) return [];
  const newestAttempt = rows[0].runAttempt;
  return rows.filter((row) => row.runAttempt === newestAttempt).map(readSetRow);
}

/**
 * Record one uploaded artifact, replacing any earlier upload at the same path.
 *
 * Re-uploading a path is normal (a job retried), and the last upload wins. The
 * counters are recomputed from the artifact rows rather than incremented, so a
 * replacement cannot inflate them.
 */
export async function recordReleaseArtifact(
  db: AppDb,
  input: {
    releaseSetId: string;
    organizationId: string;
    path: string;
    sha256: string;
    sizeBytes: number;
    storageKey: string | null;
  },
): Promise<CiReleaseArtifactRecord> {
  const now = new Date();
  await db
    .delete(ciReleaseArtifacts)
    .where(
      and(
        eq(ciReleaseArtifacts.releaseSetId, input.releaseSetId),
        eq(ciReleaseArtifacts.path, input.path),
      ),
    );
  const id = crypto.randomUUID();
  await db.insert(ciReleaseArtifacts).values({
    id,
    releaseSetId: input.releaseSetId,
    organizationId: input.organizationId,
    path: input.path,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    createdAt: now,
  });
  await refreshReleaseSetCounters(db, input.releaseSetId);
  return {
    id,
    releaseSetId: input.releaseSetId,
    organizationId: input.organizationId,
    path: input.path,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    createdAt: now,
  };
}

async function refreshReleaseSetCounters(db: AppDb, releaseSetId: string): Promise<void> {
  const [totals] = await db
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${ciReleaseArtifacts.sizeBytes}), 0)`,
    })
    .from(ciReleaseArtifacts)
    .where(eq(ciReleaseArtifacts.releaseSetId, releaseSetId));
  await db
    .update(ciReleaseSets)
    .set({
      artifactCount: Number(totals?.count ?? 0),
      totalBytes: Number(totals?.bytes ?? 0),
      updatedAt: new Date(),
    })
    .where(eq(ciReleaseSets.id, releaseSetId));
}

export async function listReleaseArtifacts(
  db: AppDb,
  releaseSetId: string,
): Promise<CiReleaseArtifactRecord[]> {
  const rows = await db
    .select()
    .from(ciReleaseArtifacts)
    .where(eq(ciReleaseArtifacts.releaseSetId, releaseSetId));
  return rows.map(readArtifactRow).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * CAS an open set to sealed. Returns null when the set was already sealed (or
 * further along), which makes a repeated seal call from a retried job a no-op
 * rather than a way to re-open a finished review.
 */
export async function sealReleaseSet(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<CiReleaseSetRecord | null> {
  const now = new Date();
  const updated = await db
    .update(ciReleaseSets)
    .set({ status: "sealed", sealedAt: now, updatedAt: now })
    .where(
      and(
        eq(ciReleaseSets.id, id),
        eq(ciReleaseSets.organizationId, organizationId),
        eq(ciReleaseSets.status, "open"),
      ),
    )
    .returning({ id: ciReleaseSets.id });
  if (updated.length === 0) return null;
  return getReleaseSet(db, organizationId, id);
}

/**
 * Claim the review batch for a sealed set. Exactly one queue delivery wins;
 * a concurrent re-delivery skips instead of double-running the package scans.
 */
export async function claimReleaseSetReview(db: AppDb, id: string): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(ciReleaseSets)
    .set({ status: "scanning", reviewStartedAt: now, updatedAt: now })
    .where(
      and(
        eq(ciReleaseSets.id, id),
        eq(ciReleaseSets.status, "sealed"),
        isNull(ciReleaseSets.reviewStartedAt),
      ),
    )
    .returning({ id: ciReleaseSets.id });
  return updated.length > 0;
}

/** Release a claim so a retry can re-run the whole batch. */
export async function releaseReleaseSetReviewClaim(db: AppDb, id: string): Promise<void> {
  const now = new Date();
  await db
    .update(ciReleaseSets)
    .set({ status: "sealed", reviewStartedAt: null, updatedAt: now })
    .where(and(eq(ciReleaseSets.id, id), eq(ciReleaseSets.status, "scanning")))
    .execute();
}

export async function markReleaseSetReviewed(
  db: AppDb,
  id: string,
  scanId: string,
): Promise<CiReleaseSetRecord | null> {
  const now = new Date();
  const updated = await db
    .update(ciReleaseSets)
    .set({ status: "reviewed", scanId, reviewedAt: now, updatedAt: now })
    .where(and(eq(ciReleaseSets.id, id), eq(ciReleaseSets.status, "scanning")))
    .returning({ id: ciReleaseSets.id, organizationId: ciReleaseSets.organizationId });
  if (updated.length === 0) return null;
  return getReleaseSet(db, updated[0].organizationId, id);
}

export async function markReleaseSetErrored(db: AppDb, id: string, reason: string): Promise<void> {
  const now = new Date();
  await db
    .update(ciReleaseSets)
    .set({ status: "errored", failureReason: reason.slice(0, 500), updatedAt: now })
    .where(eq(ciReleaseSets.id, id))
    .execute();
}

export async function markReleaseSetVerified(db: AppDb, id: string): Promise<void> {
  const now = new Date();
  await db
    .update(ciReleaseSets)
    .set({ verifiedAt: now, updatedAt: now })
    .where(eq(ciReleaseSets.id, id))
    .execute();
}

/**
 * Point every scan in a release set at a gate that just bound to it.
 *
 * This is what lets the push path reuse the entire pull-path decision surface
 * unchanged: `listGatePackageScans`, the per-package decision route, the
 * aggregate CAS, and the workbench all resolve through `scans.gate_id`. Only
 * scans with no gate yet are claimed, so a second gate binding to the same set
 * (two protected environments in one run) does not steal the first gate's
 * package rows.
 */
export async function linkReleaseSetScansToGate(
  db: AppDb,
  input: { releaseSetId: string; organizationId: string; gateId: string },
): Promise<number> {
  const updated = await db
    .update(scans)
    .set({ gateId: input.gateId, updatedAt: new Date() })
    .where(
      and(
        eq(scans.releaseSetId, input.releaseSetId),
        eq(scans.organizationId, input.organizationId),
        isNull(scans.gateId),
      ),
    )
    .returning({ id: scans.id });
  return updated.length;
}

/** Every gate that has bound to a release set (one per protected environment). */
export async function listGateIdsForReleaseSet(
  db: AppDb,
  input: { releaseSetId: string; organizationId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: githubWorkflowGates.id })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.releaseSetId, input.releaseSetId),
        eq(githubWorkflowGates.organizationId, input.organizationId),
      ),
    );
  return rows.map((row) => row.id);
}

/** Bind a gate row to the release set whose review it will collect. */
export async function bindGateToReleaseSet(
  db: AppDb,
  input: { gateId: string; organizationId: string; releaseSetId: string },
): Promise<boolean> {
  const updated = await db
    .update(githubWorkflowGates)
    .set({ releaseSetId: input.releaseSetId, updatedAt: new Date() })
    .where(
      and(
        eq(githubWorkflowGates.id, input.gateId),
        eq(githubWorkflowGates.organizationId, input.organizationId),
        isNull(githubWorkflowGates.releaseSetId),
      ),
    )
    .returning({ id: githubWorkflowGates.id });
  return updated.length > 0;
}

/**
 * Drop the R2 pointers once the reviewed bytes are no longer needed. The
 * digests stay on the row — they are the provenance evidence a maintainer and
 * the publish-time verify step compare against — but the package bytes
 * themselves do not outlive the review that needed them.
 */
export async function clearReleaseArtifactStorageKeys(
  db: AppDb,
  releaseSetId: string,
): Promise<void> {
  await db
    .update(ciReleaseArtifacts)
    .set({ storageKey: null })
    .where(eq(ciReleaseArtifacts.releaseSetId, releaseSetId))
    .execute();
}

/** Per-package scans belonging to a release set, oldest first. */
export async function listReleaseSetScans(
  db: AppDb,
  input: { releaseSetId: string; organizationId: string },
): Promise<
  {
    scanId: string;
    packageName: string | null;
    stagedVersion: string | null;
    risk: string;
    status: string;
    decision: string | null;
    /** The gate that claimed this scan, if one has bound to the set. */
    gateId: string | null;
  }[]
> {
  const rows = await db
    .select({
      scanId: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      risk: scans.risk,
      status: scans.status,
      decision: scans.decision,
      gateId: scans.gateId,
      createdAt: scans.createdAt,
    })
    .from(scans)
    .where(
      and(
        eq(scans.releaseSetId, input.releaseSetId),
        eq(scans.organizationId, input.organizationId),
      ),
    );
  return rows
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(({ createdAt: _createdAt, ...rest }) => rest);
}

/**
 * Discard a half-finished review batch so a retry starts from a clean set.
 *
 * Deletes the set's scans regardless of status, matching `discardGateScans`.
 * Sparing the completed ones would look tidier and be wrong: the batch fails as
 * a unit, so a retry re-scans every package, and any survivor becomes a
 * duplicate row for a package that now has a fresh scan. The set only reaches a
 * decision after a batch completes, so nothing decided is ever discarded here.
 */
export async function deleteReleaseSetScans(
  db: AppDb,
  input: { releaseSetId: string; organizationId: string },
): Promise<string[]> {
  const removed = await db
    .delete(scans)
    .where(
      and(
        eq(scans.releaseSetId, input.releaseSetId),
        eq(scans.organizationId, input.organizationId),
      ),
    )
    .returning({ id: scans.id });
  return removed.map((row) => row.id);
}

function readSetRow(row: typeof ciReleaseSets.$inferSelect): CiReleaseSetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    runId: row.runId,
    runAttempt: row.runAttempt,
    releaseKey: row.releaseKey,
    ecosystem: row.ecosystem,
    sha: row.sha,
    ref: row.ref,
    workflowRef: row.workflowRef,
    jobWorkflowRef: row.jobWorkflowRef,
    actor: row.actor,
    eventName: row.eventName,
    status: normalizeStatus(row.status),
    artifactCount: row.artifactCount,
    totalBytes: row.totalBytes,
    scanId: row.scanId,
    reviewStartedAt: row.reviewStartedAt ? new Date(row.reviewStartedAt) : null,
    failureReason: row.failureReason,
    verifiedAt: row.verifiedAt ? new Date(row.verifiedAt) : null,
    sealedAt: row.sealedAt ? new Date(row.sealedAt) : null,
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readArtifactRow(row: typeof ciReleaseArtifacts.$inferSelect): CiReleaseArtifactRecord {
  return {
    id: row.id,
    releaseSetId: row.releaseSetId,
    organizationId: row.organizationId,
    path: row.path,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    createdAt: new Date(row.createdAt),
  };
}

function normalizeStatus(value: string): CiReleaseSetStatus {
  if (
    value === "sealed" ||
    value === "scanning" ||
    value === "reviewed" ||
    value === "errored" ||
    value === "open"
  ) {
    return value;
  }
  return "open";
}
