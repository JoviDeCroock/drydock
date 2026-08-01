// Bounded delete helpers for the scheduled retention sweep.
//
// Every sweep here runs inside a cron invocation with a fixed CPU budget, so no
// helper issues an unbounded DELETE: each batch is capped by a `limit` subselect
// and the caller iterates a bounded number of batches, reporting whether more
// rows remain for the next tick. The orchestration (windows, env gating,
// structured events, R2 teardown) lives in `server/lib/retention.ts`.

import { and, eq, gt, gte, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubWorkflowGates, scanEvents, scanFiles, scanFindings, scans } from "./schema";

const RETENTION_DEFAULT_BATCH_SIZE = 200;
const RETENTION_DEFAULT_MAX_BATCHES = 10;

export interface BoundedSweepOptions {
  /** Rows deleted per statement. */
  batchSize?: number;
  /** Statements issued before the sweep yields to the next tick. */
  maxBatches?: number;
}

export interface BoundedSweepResult {
  deleted: number;
  batches: number;
  /** True when the batch cap was hit, so rows may still be eligible. */
  moreRemaining: boolean;
}

export async function runBoundedSweep(
  options: BoundedSweepOptions,
  deleteBatch: (limit: number) => Promise<Array<{ id: string }>>,
): Promise<BoundedSweepResult> {
  const batchSize = boundedInt(options.batchSize, RETENTION_DEFAULT_BATCH_SIZE);
  const maxBatches = boundedInt(options.maxBatches, RETENTION_DEFAULT_MAX_BATCHES);
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = await deleteBatch(batchSize);
    batches += 1;
    deleted += rows.length;
    // A short batch means the predicate is drained; stop instead of paying for a
    // statement that can only return nothing.
    if (rows.length < batchSize) return { deleted, batches, moreRemaining: false };
  }
  return { deleted, batches, moreRemaining: true };
}

export interface ExpiredScanRow {
  id: string;
  organizationId: string;
  artifactStorageVersion: number | null;
  createdAt: Date;
}

export interface ExpiredScanCursor {
  createdAtMs: number;
  id: string;
}

/**
 * Scans created before `cutoff`, oldest first, bounded by `limit`. Selected
 * through the `scans_created_idx` index. Read (rather than deleted in place)
 * because each row's R2 prefix has to be swept before its metadata goes away —
 * the prefix is derived from (organizationId, scanId), which is only knowable
 * while the row still exists.
 *
 * Two rows are excluded rather than deferred, because a permanently-deferred row
 * at the head of a fixed-size oldest-first page would starve every deletable row
 * behind it:
 *
 * - **No organization.** `scans.organization_id` is nullable (the org was
 *   deleted, which already swept its artifacts), so there is no prefix to sweep
 *   and no org to scope the delete to. Such a row can never be processed by this
 *   sweep, so it must not occupy a slot on every tick.
 * - **Attached to a still-pending workflow gate.** Deleting it would null a live
 *   gate's `scan_id` and leave a held GitHub job pointing at nothing. Once the
 *   gate is decided the scan becomes eligible again.
 *
 * `cursor` pages past rows the caller deferred for a transient reason (an R2
 * sweep that failed), so one stuck scan cannot block the rest of the backlog.
 */
export async function listScansOlderThan(
  db: AppDb,
  cutoff: Date,
  limit: number,
  cursor?: ExpiredScanCursor | null,
): Promise<ExpiredScanRow[]> {
  const conditions = [lt(scans.createdAt, cutoff), isNotNull(scans.organizationId)];
  if (cursor) {
    const cursorDate = new Date(cursor.createdAtMs);
    conditions.push(
      or(
        gt(scans.createdAt, cursorDate),
        and(eq(scans.createdAt, cursorDate), gt(scans.id, cursor.id)),
      )!,
    );
  }
  const rows = await db
    .select({
      id: scans.id,
      organizationId: scans.organizationId,
      artifactStorageVersion: scans.artifactStorageVersion,
      createdAt: scans.createdAt,
    })
    .from(scans)
    .where(
      and(
        ...conditions,
        notExists(
          db
            .select({ one: sql`1` })
            .from(githubWorkflowGates)
            .where(
              and(
                eq(githubWorkflowGates.scanId, scans.id),
                eq(githubWorkflowGates.status, "pending"),
              ),
            ),
        ),
      ),
    )
    .orderBy(scans.createdAt, scans.id)
    .limit(Math.max(1, Math.floor(limit)));

  // organizationId is narrowed by the isNotNull predicate above; Drizzle types it
  // from the (nullable) column, so assert once here rather than at every use.
  return rows as ExpiredScanRow[];
}

/** Cursor addressing `row`, for paging past a deferred candidate. */
export function expiredScanCursor(row: ExpiredScanRow): ExpiredScanCursor {
  return { createdAtMs: row.createdAt.getTime(), id: row.id };
}

/**
 * Clear a scan's artifact-metadata columns, immediately before its R2 objects are
 * swept. Ordering matters here and the reverse is not survivable:
 *
 * Sweeping R2 first and then failing the D1 delete leaves a row that still claims
 * to be artifact-backed while its evidence is gone. Every detail read then
 * fetches nothing, logs `scan.artifacts.fallback_read`, and — because a compacted
 * row has no `scan_files` / `scan_findings` either, and
 * `SCAN_ARTIFACT_READS_DISABLED` is explicitly not a recovery path for those rows
 * — renders a completed scan with zero files and zero findings. An orphaned R2
 * object is recoverable by re-running the prefix sweep; a scan that reads clean
 * because its evidence was deleted is not.
 *
 * Doing it in this order means the worst residual state is a metadata-only row
 * that is honest about having no detail, that no reader will chase R2 for, and
 * that the next tick picks up again (it is still past the cutoff) to finish the
 * delete.
 */
export async function clearScanArtifactMetadata(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<boolean> {
  const updated = await db
    .update(scans)
    .set({
      artifactStorageVersion: null,
      artifactManifestKey: null,
      artifactManifestDigest: null,
      artifactManifestSize: null,
      reportArtifactKey: null,
      fileSamplesArtifactKey: null,
      diffArtifactKey: null,
      updatedAt: new Date(),
    })
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .returning({ id: scans.id });
  return updated.length > 0;
}

/**
 * Delete one scan and its D1 children, evidence first.
 *
 * `scan_files` / `scan_findings` / `scan_events` all cascade from `scans.id`, but
 * they are deleted explicitly and BEFORE the parent so the ordering is the
 * documented one rather than an implicit database behaviour: redacted evidence
 * must never outlive the metadata that describes it. The parent delete is
 * organization-scoped and returns the row, so a caller can tell a real deletion
 * from a row that moved underneath it — which nothing does today, since no code
 * path reassigns `scans.organization_id`.
 *
 * `auditEventCutoff` keeps the two retention windows from fighting. `scan_events`
 * is also the organization audit log, on its own flat 90-day window, and the two
 * ages are independent: a scan created 400 days ago can carry a `scan.decided`
 * row written yesterday. Cascading that away would delete a one-day-old audit
 * entry because the *scan* is old. Events at or newer than the cutoff are instead
 * detached (`scan_id` set to null) so they survive as organization audit rows —
 * without a deep link to a scan that no longer exists — until the audit sweep
 * collects them on their own schedule. Detaching has to happen before the parent
 * delete, or the FK cascade takes them first.
 */
export async function deleteScanWithChildren(
  db: AppDb,
  scanId: string,
  organizationId: string,
  auditEventCutoff: Date,
): Promise<boolean> {
  const scopedToScan = and(
    eq(scanEvents.scanId, scanId),
    eq(scanEvents.organizationId, organizationId),
  );
  await db.delete(scanEvents).where(and(scopedToScan, lt(scanEvents.createdAt, auditEventCutoff)));
  await db
    .update(scanEvents)
    .set({ scanId: null })
    .where(and(scopedToScan, gte(scanEvents.createdAt, auditEventCutoff)));
  await db.delete(scanFindings).where(eq(scanFindings.scanId, scanId));
  await db.delete(scanFiles).where(eq(scanFiles.scanId, scanId));
  const deleted = await db
    .delete(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .returning({ id: scans.id });
  return deleted.length > 0;
}

function boundedInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
