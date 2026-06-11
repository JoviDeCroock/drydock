import { count, inArray, lt, or } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubWorkflowGates, scanEvents, scanFiles, scanFindings, scans } from "./schema";

// Retention windows. D1 has a hard 10 GB ceiling and the */15 discovery cron
// writes steadily, so unbounded history is a runway-limited hard failure, not a
// slow degradation. Scans keep ~6 months — long enough to revisit a release
// decision. Audit events keep ~3 months: they are write-heavy (several per scan)
// and lose operational value faster than the scan they describe.
export const SCAN_RETENTION_DAYS = 180;
export const SCAN_EVENT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPruneResult {
  scansPruned: number;
  scanFilesPruned: number;
  scanFindingsPruned: number;
  scanEventsPruned: number;
  gateScanRefsCleared: number;
}

/**
 * Delete rows past their retention window. Idempotent and safe to run on every
 * tick: each run removes only the delta that has aged out since the last one.
 *
 * D1 does not enforce foreign keys, so we cannot rely on `ON DELETE CASCADE`.
 * Every reference to a pruned scan is cleared by hand, in dependency order,
 * inside one transaction (`db.batch`): the child file/finding/event rows are
 * deleted and the gate's representative-scan pointer is nulled *before* the
 * scan rows themselves go, so nothing is left dangling.
 */
export async function pruneRetentionData(
  db: AppDb,
  nowMs: number = Date.now(),
): Promise<RetentionPruneResult> {
  const scanCutoff = new Date(nowMs - SCAN_RETENTION_DAYS * DAY_MS);
  const eventCutoff = new Date(nowMs - SCAN_EVENT_RETENTION_DAYS * DAY_MS);

  // The reference cleanups below target scans through this subquery rather than a
  // materialized id list, so they are not bound by D1's 100-parameter cap on
  // inArray and stay index-backed (scans_created_at_idx). The batch runs in array
  // order, so every statement that reads this subquery executes before the scans
  // delete that empties it.
  const expiredScanIds = db
    .select({ id: scans.id })
    .from(scans)
    .where(lt(scans.createdAt, scanCutoff));

  const expiredScanFindingPredicate = inArray(scanFindings.scanId, expiredScanIds);
  const expiredScanFilePredicate = inArray(scanFiles.scanId, expiredScanIds);
  const expiredScanEventPredicate = or(
    lt(scanEvents.createdAt, eventCutoff),
    inArray(scanEvents.scanId, expiredScanIds),
  );
  const expiredGateScanPredicate = inArray(githubWorkflowGates.scanId, expiredScanIds);
  const expiredScanPredicate = lt(scans.createdAt, scanCutoff);

  const [findingsCount, filesCount, eventsCount, gateCount, scansCount] = await db.batch([
    db.select({ rowCount: count() }).from(scanFindings).where(expiredScanFindingPredicate),
    db.select({ rowCount: count() }).from(scanFiles).where(expiredScanFilePredicate),
    db.select({ rowCount: count() }).from(scanEvents).where(expiredScanEventPredicate),
    db.select({ rowCount: count() }).from(githubWorkflowGates).where(expiredGateScanPredicate),
    db.select({ rowCount: count() }).from(scans).where(expiredScanPredicate),
    db.delete(scanFindings).where(expiredScanFindingPredicate),
    db.delete(scanFiles).where(expiredScanFilePredicate),
    // Past the (shorter) event window, plus any event still tied to a scan being
    // pruned: a late decision can write an event younger than the event window
    // onto an already-expired scan, and leaving it would dangle on a gone scan.
    db.delete(scanEvents).where(expiredScanEventPredicate),
    // github_workflow_gates.scan_id is declared ON DELETE SET NULL; with FK
    // enforcement off we clear the representative-scan pointer ourselves before
    // its scan disappears. Gates are not otherwise pruned here.
    db.update(githubWorkflowGates).set({ scanId: null }).where(expiredGateScanPredicate),
    db.delete(scans).where(expiredScanPredicate),
  ]);

  return {
    scansPruned: scansCount[0]?.rowCount ?? 0,
    scanFilesPruned: filesCount[0]?.rowCount ?? 0,
    scanFindingsPruned: findingsCount[0]?.rowCount ?? 0,
    scanEventsPruned: eventsCount[0]?.rowCount ?? 0,
    gateScanRefsCleared: gateCount[0]?.rowCount ?? 0,
  };
}
