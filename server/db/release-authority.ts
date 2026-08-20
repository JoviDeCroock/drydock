import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { type AppDb } from "./client";
import { githubWorkflowGates, releaseAuthoritySnapshots } from "./schema";
import {
  type AuthorityBaselineRef,
  computeReleaseAuthorityDelta,
  type ReleaseAuthorityDelta,
} from "../lib/release-authority/delta";
import { normalizeReleaseAuthorityDelta } from "../lib/release-authority/normalize-delta";
import { normalizeReleaseAuthoritySnapshot } from "../lib/release-authority/normalize";
import type { ReleaseAuthoritySnapshot } from "../lib/release-authority/snapshot";
import { sha256Hex, stableJson } from "../lib/platform/stable-json";

export interface ReleaseAuthorityRecord {
  id: string;
  organizationId: string;
  releaseTargetId: string;
  gateId: string;
  runId: number;
  workflowPath: string;
  headSha: string | null;
  snapshot: ReleaseAuthoritySnapshot | null;
  delta: ReleaseAuthorityDelta | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  artifactBindingDigest: string | null;
  createdAt: Date;
}

export interface RecordAuthoritySnapshotInput {
  organizationId: string;
  releaseTargetId: string;
  gateId: string;
  runId: number;
  workflowPath: string | null;
  headSha: string | null;
  snapshot: ReleaseAuthoritySnapshot;
  delta: ReleaseAuthorityDelta;
  artifactBindingDigest: string | null;
}

/**
 * Persist (or replace) the authority record for one gate. A gate is reviewed at
 * most once, but a retried review batch re-captures the snapshot, so this
 * overwrites by gate rather than accumulating rows. The approval fields are
 * deliberately reset on re-capture: an approval belongs to the exact snapshot
 * that was shown to the maintainer.
 */
export async function recordReleaseAuthoritySnapshot(
  db: AppDb,
  input: RecordAuthoritySnapshotInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(releaseAuthoritySnapshots)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      releaseTargetId: input.releaseTargetId,
      gateId: input.gateId,
      runId: input.runId,
      workflowPath: input.workflowPath ?? "",
      headSha: input.headSha,
      snapshotJson: input.snapshot,
      deltaJson: input.delta,
      approvedAt: null,
      approvedByUserId: null,
      artifactBindingDigest: input.artifactBindingDigest,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: releaseAuthoritySnapshots.gateId,
      set: {
        runId: input.runId,
        workflowPath: input.workflowPath ?? "",
        headSha: input.headSha,
        snapshotJson: input.snapshot,
        deltaJson: input.delta,
        approvedAt: null,
        approvedByUserId: null,
        artifactBindingDigest: input.artifactBindingDigest,
        updatedAt: now,
      },
    });
}

export async function getReleaseAuthorityForGate(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<ReleaseAuthorityRecord | null> {
  const [row] = await db
    .select()
    .from(releaseAuthoritySnapshots)
    .where(
      and(
        eq(releaseAuthoritySnapshots.gateId, gateId),
        eq(releaseAuthoritySnapshots.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? readRow(row) : null;
}

/**
 * Recompute a pending gate's delta against the baseline that is approved now,
 * not merely the one that existed when the review batch was captured. Pending
 * releases can overlap; without this refresh an older `unchanged` delta could
 * be approved after another gate moved the baseline.
 */
export async function refreshReleaseAuthorityDeltaForGate(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<ReleaseAuthorityRecord | null> {
  const record = await getReleaseAuthorityForGate(db, organizationId, gateId);
  if (!record?.snapshot) return record;
  const [gate] = await db
    .select({ status: githubWorkflowGates.status })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.id, gateId),
        eq(githubWorkflowGates.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (gate?.status !== "pending") return record;

  const baseline = await findApprovedAuthorityBaseline(db, {
    organizationId,
    releaseTargetId: record.releaseTargetId,
    workflowPath: record.snapshot.run.workflowPath,
    excludeGateId: gateId,
  });
  const approvedReleasePaths = baseline
    ? []
    : await listApprovedReleasePaths(db, {
        organizationId,
        releaseTargetId: record.releaseTargetId,
        excludeGateId: gateId,
        excludeWorkflowPath: record.snapshot.run.workflowPath,
      });
  const delta = computeReleaseAuthorityDelta(record.snapshot, baseline, { approvedReleasePaths });
  if (stableJson(delta) !== stableJson(record.delta)) {
    await db
      .update(releaseAuthoritySnapshots)
      .set({ deltaJson: delta, updatedAt: new Date() })
      .where(
        and(
          eq(releaseAuthoritySnapshots.id, record.id),
          eq(releaseAuthoritySnapshots.organizationId, organizationId),
          eq(releaseAuthoritySnapshots.gateId, gateId),
        ),
      );
  }
  return { ...record, delta };
}

/** Opaque binding between a UI acknowledgement and the exact delta it showed. */
export async function releaseAuthorityAcknowledgementToken(
  record: ReleaseAuthorityRecord | null,
): Promise<string | null> {
  if (!record?.delta) return null;
  return sha256Hex(stableJson({ snapshotId: record.id, delta: record.delta }));
}

export interface BaselineLookupInput {
  organizationId: string;
  releaseTargetId: string;
  workflowPath: string | null;
  /** The gate being reviewed, so a re-run never compares against itself. */
  excludeGateId: string;
}

/**
 * The most recently approved snapshot for the same release boundary, or null.
 *
 * Only approved snapshots are eligible. A release that was reviewed but never
 * decided — or one that was rejected — must not become the thing the next
 * release is measured against, or a rejected authority change would launder
 * itself into the baseline.
 */
export async function findApprovedAuthorityBaseline(
  db: AppDb,
  input: BaselineLookupInput,
): Promise<{ snapshot: ReleaseAuthoritySnapshot; ref: AuthorityBaselineRef } | null> {
  const [row] = await db
    .select()
    .from(releaseAuthoritySnapshots)
    .where(
      and(
        eq(releaseAuthoritySnapshots.organizationId, input.organizationId),
        eq(releaseAuthoritySnapshots.releaseTargetId, input.releaseTargetId),
        eq(releaseAuthoritySnapshots.workflowPath, input.workflowPath ?? ""),
        ne(releaseAuthoritySnapshots.gateId, input.excludeGateId),
        isNotNull(releaseAuthoritySnapshots.approvedAt),
      ),
    )
    .orderBy(desc(releaseAuthoritySnapshots.approvedAt))
    .limit(1);
  if (!row) return null;
  const record = readRow(row);
  if (!record.snapshot) return null;
  return {
    snapshot: record.snapshot,
    ref: {
      snapshotId: record.id,
      gateId: record.gateId,
      runId: record.runId,
      headSha: record.headSha,
      approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
    },
  };
}

/**
 * How many distinct approved release paths are worth carrying into a delta. A
 * target with more publish workflows than this has already made the point.
 */
const MAX_APPROVED_RELEASE_PATHS = 16;

/**
 * The distinct entry-workflow paths this release target has already published
 * through under an approved authority, excluding the gate being reviewed and
 * the path it arrived on.
 *
 * Baselines are per release path, so a release arriving on a path with no
 * history finds nothing to compare against. That is genuinely neutral on a
 * target's first release and a real signal on a target with history — someone
 * added a second way to publish. This is the lookup that tells the two apart;
 * without it both collapse into `no_baseline`, which reads as "first release
 * here" and asks for no acknowledgement.
 */
export async function listApprovedReleasePaths(
  db: AppDb,
  input: {
    organizationId: string;
    releaseTargetId: string;
    excludeGateId: string;
    excludeWorkflowPath: string | null;
  },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workflowPath: releaseAuthoritySnapshots.workflowPath })
    .from(releaseAuthoritySnapshots)
    .where(
      and(
        eq(releaseAuthoritySnapshots.organizationId, input.organizationId),
        eq(releaseAuthoritySnapshots.releaseTargetId, input.releaseTargetId),
        ne(releaseAuthoritySnapshots.gateId, input.excludeGateId),
        ne(releaseAuthoritySnapshots.workflowPath, input.excludeWorkflowPath ?? ""),
        isNotNull(releaseAuthoritySnapshots.approvedAt),
      ),
    )
    .limit(MAX_APPROVED_RELEASE_PATHS);
  // The empty path is "the run reported no entry workflow", not a release path
  // anyone approved travelling through.
  return rows
    .map((row) => row.workflowPath)
    .filter((path) => path.length > 0)
    .sort();
}

/**
 * Record that a maintainer accepted this release's authority. Called when the
 * gate as a whole is approved, which is the point the held deployment is
 * released — so the accepted snapshot is exactly the authority that published.
 */
export async function markAuthoritySnapshotApproved(
  db: AppDb,
  input: { organizationId: string; gateId: string; approvedByUserId: string | null },
): Promise<void> {
  const now = new Date();
  await db
    .update(releaseAuthoritySnapshots)
    .set({ approvedAt: now, approvedByUserId: input.approvedByUserId, updatedAt: now })
    .where(
      and(
        eq(releaseAuthoritySnapshots.gateId, input.gateId),
        eq(releaseAuthoritySnapshots.organizationId, input.organizationId),
      ),
    );
}

function readRow(row: {
  id: string;
  organizationId: string;
  releaseTargetId: string;
  gateId: string;
  runId: number;
  workflowPath: string;
  headSha: string | null;
  snapshotJson: unknown;
  deltaJson: unknown;
  approvedAt: Date | string | number | null;
  approvedByUserId: string | null;
  artifactBindingDigest: string | null;
  createdAt: Date | string | number;
}): ReleaseAuthorityRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    releaseTargetId: row.releaseTargetId,
    gateId: row.gateId,
    runId: row.runId,
    workflowPath: row.workflowPath,
    headSha: row.headSha,
    snapshot: normalizeReleaseAuthoritySnapshot(row.snapshotJson),
    delta: normalizeReleaseAuthorityDelta(row.deltaJson),
    approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
    approvedByUserId: row.approvedByUserId,
    artifactBindingDigest: row.artifactBindingDigest,
    createdAt: new Date(row.createdAt),
  };
}
