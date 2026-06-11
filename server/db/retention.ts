import { inArray, lt, or } from "drizzle-orm";
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

  const [findingsResult, filesResult, eventsResult, gateResult, scansResult] = await db.batch([
    db
      .delete(scanFindings)
      .where(inArray(scanFindings.scanId, expiredScanIds))
      .returning({ id: scanFindings.id }),
    db
      .delete(scanFiles)
      .where(inArray(scanFiles.scanId, expiredScanIds))
      .returning({ id: scanFiles.id }),
    // Past the (shorter) event window, plus any event still tied to a scan being
    // pruned: a late decision can write an event younger than the event window
    // onto an already-expired scan, and leaving it would dangle on a gone scan.
    db
      .delete(scanEvents)
      .where(or(lt(scanEvents.createdAt, eventCutoff), inArray(scanEvents.scanId, expiredScanIds)))
      .returning({ id: scanEvents.id }),
    // github_workflow_gates.scan_id is declared ON DELETE SET NULL; with FK
    // enforcement off we clear the representative-scan pointer ourselves before
    // its scan disappears. Gates are not otherwise pruned here.
    db
      .update(githubWorkflowGates)
      .set({ scanId: null })
      .where(inArray(githubWorkflowGates.scanId, expiredScanIds))
      .returning({ id: githubWorkflowGates.id }),
    db.delete(scans).where(lt(scans.createdAt, scanCutoff)).returning({ id: scans.id }),
  ]);

  return {
    scansPruned: scansResult.length,
    scanFilesPruned: filesResult.length,
    scanFindingsPruned: findingsResult.length,
    scanEventsPruned: eventsResult.length,
    gateScanRefsCleared: gateResult.length,
  };
}
