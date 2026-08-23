// Scheduled retention pass.
//
// Runs on every cron tick after the staged-publish discovery sweep. Two of the
// three sweeps are unconditional storage hygiene (audit events past their flat
// window, expired Better Auth session/verification rows); the third, time-based
// scan retention, deletes reviews and is therefore OFF unless an operator sets
// `SCAN_RETENTION_DAYS`.
//
// Every sweep is bounded (LIMIT + iterate, batch cap per tick) and independently
// wrapped: one failing sweep must not stop the others, and none may throw into
// the scheduled handler.

import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "../db/audit-log";
import { pruneExpiredAuthRows, type PrunedAuthRowCounts } from "../db/auth-retention";
import { createDb, type AppDb } from "../db/client";
import {
  clearScanArtifactMetadata,
  deleteScanWithChildren,
  expiredScanCursor,
  listScansOlderThan,
  type BoundedSweepResult,
  type ExpiredScanCursor,
  type ExpiredScanRow,
} from "../db/retention";
import {
  claimScanForRetention,
  markScanRetentionArtifactsRemoved,
  releaseScanMaintenanceClaim,
  SCAN_MAINTENANCE_KINDS,
  SCAN_MAINTENANCE_LEASE_MS,
} from "../db/scan-maintenance";
import { deleteScanArtifacts } from "./scan/artifacts";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./platform/observability";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Floor for `SCAN_RETENTION_DAYS`. Scan deletion is irreversible and the review
 * history is the product's memory (release memory reads prior approved scans), so
 * a fat-fingered `SCAN_RETENTION_DAYS=1` must fail safe rather than empty the
 * table. A value below the floor disables the sweep and logs.
 */
export const SCAN_RETENTION_MIN_DAYS = 90;

/**
 * Scans deleted per tick. Each one costs a handful of D1 statements plus an R2
 * list + delete, so this bounds the sweep's share of a scheduled invocation. A
 * backlog drains across ticks (one every 15 minutes).
 */
const SCAN_RETENTION_MAX_PER_TICK = 50;

/**
 * How many pages of candidates the sweep will walk in one tick. Deferrals are
 * transient (an R2 sweep that failed), but without paging past them a page made
 * entirely of stuck rows would come back identical every tick and no deletable
 * scan behind them would ever be reached.
 */
const SCAN_RETENTION_MAX_PAGES = 4;

export interface RetentionSweepResult {
  auditEvents: BoundedSweepResult | null;
  authRows: PrunedAuthRowCounts | null;
  scans: ScanRetentionResult | null;
}

interface ScanRetentionResult {
  retentionDays: number;
  candidates: number;
  deleted: number;
  /** Rows left in place because their teardown could not complete this tick. */
  deferred: number;
  objectsDeleted: number;
}

/**
 * Parse the scan-retention window. Unset (the default), unparseable, non-positive,
 * or below `SCAN_RETENTION_MIN_DAYS` all mean "no scan deletion": enabling
 * destructive retention has to be an explicit, in-range operator decision.
 */
export function parseScanRetentionDays(
  env: Pick<Cloudflare.Env, "SCAN_RETENTION_DAYS">,
): number | null {
  const raw = env.SCAN_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || Math.floor(days) <= 0) {
    reportMisconfiguration({ reason: "not_a_positive_number", value: raw });
    return null;
  }
  if (Math.floor(days) < SCAN_RETENTION_MIN_DAYS) {
    reportMisconfiguration({
      reason: "below_minimum",
      value: raw,
      minimumDays: SCAN_RETENTION_MIN_DAYS,
    });
    return null;
  }
  return Math.floor(days);
}

// A misconfigured window is a standing condition, not an event: the cron fires
// every 15 minutes, so logging it per tick would put ~96 identical error lines a
// day into Workers Logs and bury the things that happened once. Report it the
// first time an isolate sees a given value and stay quiet after that.
let misconfigurationReported: string | null = null;

function reportMisconfiguration(fields: { reason: string; value: string; minimumDays?: number }) {
  const key = `${fields.reason}:${fields.value}`;
  if (misconfigurationReported === key) return;
  misconfigurationReported = key;
  emitOperationalEvent("error", "retention.scans.misconfigured", fields);
}

/** Test seam: pool workers reuse isolates across files, so the latch is reused too. */
export function resetRetentionMisconfigurationLatch(): void {
  misconfigurationReported = null;
}

export async function runRetentionSweep(
  env: Cloudflare.Env,
  options: { now?: Date } = {},
): Promise<RetentionSweepResult> {
  const startedAtMs = Date.now();
  const now = options.now ?? new Date();

  const result: RetentionSweepResult = {
    auditEvents: await sweepAuditEvents(env, now),
    authRows: await sweepAuthRows(env, now),
    scans: await sweepScans(env, now),
  };

  emitOperationalEvent("info", "retention.swept", {
    durationMs: durationMsSince(startedAtMs),
    auditEventsDeleted: result.auditEvents?.deleted ?? null,
    sessionsDeleted: result.authRows?.sessions ?? null,
    verificationsDeleted: result.authRows?.verifications ?? null,
    scansDeleted: result.scans?.deleted ?? null,
    scanRetentionDays: result.scans?.retentionDays ?? null,
  });
  return result;
}

// Flat-window retention for the organization audit log. The event names are the
// ones operators already watch; only the fields grew.
async function sweepAuditEvents(
  env: Cloudflare.Env,
  now: Date,
): Promise<BoundedSweepResult | null> {
  const cutoff = auditEventCutoff(now);
  try {
    const outcome = await pruneAuditEventsOlderThan(createDb(env.DB), cutoff);
    emitOperationalEvent("info", "audit_events.pruned", {
      retentionDays: AUDIT_LOG_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
      deleted: outcome.deleted,
      batches: outcome.batches,
      moreRemaining: outcome.moreRemaining,
    });
    return outcome;
  } catch (err) {
    emitOperationalEvent("error", "audit_events.prune_failed", {
      error: describeOperationalError(err),
    });
    return null;
  }
}

// Better Auth never removes its own expired rows. `pruneExpiredAuthRows` owns the
// grace period that keeps this clear of Better Auth's session refresh.
async function sweepAuthRows(env: Cloudflare.Env, now: Date): Promise<PrunedAuthRowCounts | null> {
  try {
    const pruned = await pruneExpiredAuthRows(createDb(env.DB), now);
    if (pruned.sessions > 0 || pruned.verifications > 0) {
      emitOperationalEvent("info", "auth_rows.pruned", {
        sessions: pruned.sessions,
        verifications: pruned.verifications,
        moreRemaining: pruned.moreRemaining,
      });
    }
    return pruned;
  } catch (err) {
    emitOperationalEvent("error", "auth_rows.prune_failed", {
      error: describeOperationalError(err),
    });
    return null;
  }
}

/**
 * Time-based scan retention. Destructive and therefore opt-in, and it holds to
 * the deletion-lifecycle rules in docs/artifact-storage.md:
 *
 * - Per scan: sweep the R2 prefix, clear the artifact metadata, then delete the
 *   row. If the prefix cannot be drained the row stays completely untouched
 *   (counted as `deferred`) and the next tick retries. A later D1 failure can
 *   leave a transient row that the next tick finishes; `deleteOneExpiredScan`
 *   and `clearScanArtifactMetadata` document those residual states.
 * - It requires the `ARTIFACTS` binding. Without it there is no way to reach a
 *   scan's objects, so deleting rows would strand them; the sweep is skipped.
 */
async function sweepScans(env: Cloudflare.Env, now: Date): Promise<ScanRetentionResult | null> {
  const retentionDays = parseScanRetentionDays(env);
  if (retentionDays === null) return null;
  // Deletion uses the raw binding, never scanArtifactReadBucket:
  // SCAN_ARTIFACT_READS_DISABLED is a read kill-switch and must not strand objects.
  const bucket = env.ARTIFACTS;
  if (!bucket) {
    emitOperationalEvent("error", "retention.scans.skipped", {
      reason: "artifacts_binding_missing",
      retentionDays,
    });
    return null;
  }

  const outcome: ScanRetentionResult = {
    retentionDays,
    candidates: 0,
    deleted: 0,
    deferred: 0,
    objectsDeleted: 0,
  };
  try {
    const db = createDb(env.DB);
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const events = auditEventCutoff(now);
    let cursor: ExpiredScanCursor | null = null;

    for (let page = 0; page < SCAN_RETENTION_MAX_PAGES; page += 1) {
      const remaining = SCAN_RETENTION_MAX_PER_TICK - outcome.deleted;
      if (remaining <= 0) break;
      const candidates: ExpiredScanRow[] = await listScansOlderThan(db, cutoff, remaining, cursor);
      if (!candidates.length) break;
      outcome.candidates += candidates.length;

      let deferredThisPage = 0;
      for (const candidate of candidates) {
        // Per candidate, so one bad scan cannot abort the rest of the backlog.
        try {
          const objectsDeleted = await deleteOneExpiredScan(db, bucket, candidate, events, now);
          if (objectsDeleted === null) {
            outcome.deferred += 1;
            deferredThisPage += 1;
            continue;
          }
          outcome.deleted += 1;
          outcome.objectsDeleted += objectsDeleted;
        } catch (err) {
          outcome.deferred += 1;
          deferredThisPage += 1;
          emitOperationalEvent("error", "retention.scans.delete_failed", {
            scanId: candidate.id,
            organizationId: candidate.organizationId,
            error: describeOperationalError(err),
          });
        }
      }

      // Something on this page was deletable, so the window has moved and the next
      // tick will make progress from the top. Only a page that deferred *every*
      // row needs paging past, or the same stuck rows would fill the oldest-first
      // window forever and starve everything behind them.
      if (deferredThisPage < candidates.length) break;
      const last = candidates[candidates.length - 1];
      if (!last) break;
      cursor = expiredScanCursor(last);
    }

    emitOperationalEvent("info", "retention.scans.pruned", { ...outcome });
    return outcome;
  } catch (err) {
    emitOperationalEvent("error", "retention.scans.prune_failed", {
      retentionDays,
      error: describeOperationalError(err),
    });
    return null;
  }
}

/**
 * Tear one scan down. Returns the number of R2 objects deleted, or null when the
 * scan was deferred because its prefix could not be swept.
 */
async function deleteOneExpiredScan(
  db: AppDb,
  bucket: R2Bucket,
  candidate: ExpiredScanRow,
  auditEvents: Date,
  now: Date,
): Promise<number | null> {
  const claimed = await claimScanForRetention(db, {
    scanId: candidate.id,
    organizationId: candidate.organizationId,
    token: crypto.randomUUID(),
    claimedAt: now,
    staleBefore: new Date(now.getTime() - SCAN_MAINTENANCE_LEASE_MS),
  });
  if (!claimed) return null;

  const claimToken = claimed.token;
  let deleted = false;
  let artifactEvidenceRemoved = claimed.kind === SCAN_MAINTENANCE_KINDS.retentionArtifactsRemoved;
  try {
    // Order is load-bearing; see clearScanArtifactMetadata. The D1 lease above
    // is equally load-bearing: sharing checks it before minting a capability.
    const swept = await deleteScanArtifacts(bucket, candidate.organizationId, candidate.id);
    if (!swept.ok) {
      artifactEvidenceRemoved ||=
        claimed.artifactStorageVersion !== null && swept.objectsDeleted > 0;
      return null;
    }
    artifactEvidenceRemoved ||= claimed.artifactStorageVersion !== null;
    if (claimed.artifactStorageVersion !== null) {
      await clearScanArtifactMetadata(db, candidate.id, candidate.organizationId, claimToken);
    }
    deleted = await deleteScanWithChildren(
      db,
      candidate.id,
      candidate.organizationId,
      auditEvents,
      claimToken,
    );
    return deleted ? swept.objectsDeleted : null;
  } finally {
    if (!deleted) {
      if (artifactEvidenceRemoved) {
        await markScanRetentionArtifactsRemoved(db, {
          scanId: candidate.id,
          organizationId: candidate.organizationId,
          token: claimToken,
        });
      } else {
        await releaseScanMaintenanceClaim(db, {
          scanId: candidate.id,
          organizationId: candidate.organizationId,
          token: claimToken,
        });
      }
    }
  }
}

function auditEventCutoff(now: Date): Date {
  return new Date(now.getTime() - AUDIT_LOG_RETENTION_DAYS * DAY_MS);
}
