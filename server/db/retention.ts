// Bounded delete helpers for the scheduled retention sweep.
//
// Every sweep here runs inside a cron invocation with a fixed CPU budget, so no
// helper issues an unbounded DELETE: each batch is capped by a `limit` subselect
// and the caller iterates a bounded number of batches, reporting whether more
// rows remain for the next tick. The orchestration (windows, env gating,
// structured events, R2 teardown) lives in `server/lib/retention.ts`.

import { and, eq, inArray, lt } from "drizzle-orm";
import type { AppDb } from "./client";
import { scanEvents, scanFiles, scanFindings, scans, session, verification } from "./schema";

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

/**
 * Delete Better Auth sessions that expired before `cutoff`. Better Auth never
 * removes an expired row itself, so without this the table grows once per sign-in
 * forever. An expired session is already unusable — `getAuthSession` rejects it —
 * so deleting it cannot sign anyone out.
 */
export async function pruneExpiredSessions(
  db: AppDb,
  cutoff: Date,
  options: BoundedSweepOptions = {},
): Promise<BoundedSweepResult> {
  return runBoundedSweep(options, (limit) =>
    db
      .delete(session)
      .where(
        inArray(
          session.id,
          db
            .select({ id: session.id })
            .from(session)
            .where(lt(session.expiresAt, cutoff))
            .limit(limit),
        ),
      )
      .returning({ id: session.id }),
  );
}

/**
 * Delete Better Auth verification rows that expired before `cutoff` — the
 * one-shot email-verification, password-reset, and step-up tokens. Better Auth
 * leaves both consumed and abandoned rows behind. Expired tokens are already
 * refused on use, so this only reclaims storage; the row also holds token
 * material, which is a second reason not to keep it past its window.
 */
export async function pruneExpiredVerifications(
  db: AppDb,
  cutoff: Date,
  options: BoundedSweepOptions = {},
): Promise<BoundedSweepResult> {
  return runBoundedSweep(options, (limit) =>
    db
      .delete(verification)
      .where(
        inArray(
          verification.id,
          db
            .select({ id: verification.id })
            .from(verification)
            .where(lt(verification.expiresAt, cutoff))
            .limit(limit),
        ),
      )
      .returning({ id: verification.id }),
  );
}

export interface ExpiredScanRow {
  id: string;
  organizationId: string | null;
  artifactStorageVersion: number | null;
}

/**
 * Scans created before `cutoff`, oldest first, bounded by `limit`. Selected
 * through the `scans_created_idx` index. Read (rather than deleted in place)
 * because each row's R2 prefix has to be swept before its metadata goes away —
 * the prefix is derived from (organizationId, scanId), which is only knowable
 * while the row still exists.
 */
export async function listScansOlderThan(
  db: AppDb,
  cutoff: Date,
  limit: number,
): Promise<ExpiredScanRow[]> {
  return db
    .select({
      id: scans.id,
      organizationId: scans.organizationId,
      artifactStorageVersion: scans.artifactStorageVersion,
    })
    .from(scans)
    .where(lt(scans.createdAt, cutoff))
    .orderBy(scans.createdAt, scans.id)
    .limit(Math.max(1, Math.floor(limit)));
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
 */
export async function deleteScanWithChildren(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<boolean> {
  await db
    .delete(scanEvents)
    .where(and(eq(scanEvents.scanId, scanId), eq(scanEvents.organizationId, organizationId)));
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
