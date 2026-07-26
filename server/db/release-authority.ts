import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { type AppDb } from "./client";
import { releaseAuthoritySnapshots, scans } from "./schema";
import type { AuthorityBaselineRef, ReleaseAuthorityDelta } from "../lib/release-authority/delta";
import { normalizeReleaseAuthorityDelta } from "../lib/release-authority/normalize-delta";
import { normalizeReleaseAuthoritySnapshot } from "../lib/release-authority/normalize";
import type { ReleaseAuthoritySnapshot } from "../lib/release-authority/snapshot";

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
 * Resolve the authority record behind a scan. A monorepo gate fans out into
 * several package scans that all share one release authority, so every scan of
 * the gate resolves to the same record.
 */
export async function getReleaseAuthorityForScan(
  db: AppDb,
  organizationId: string,
  scanId: string,
): Promise<ReleaseAuthorityRecord | null> {
  const [scanRow] = await db
    .select({ gateId: scans.gateId })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (!scanRow?.gateId) return null;
  return getReleaseAuthorityForGate(db, organizationId, scanRow.gateId);
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
