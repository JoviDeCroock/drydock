// Scheduled retention pass.
//
// Runs on every cron tick after the staged-publish discovery sweep. Three of the
// four sweeps are unconditional storage hygiene (audit events past their flat
// window, expired Better Auth sessions, expired verification tokens); the fourth,
// time-based scan retention, deletes reviews and is therefore OFF unless an
// operator sets `SCAN_RETENTION_DAYS`.
//
// Every sweep is bounded (LIMIT + iterate, batch cap per tick) and independently
// wrapped: one failing sweep must not stop the others, and none may throw into
// the scheduled handler.

import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "../db/audit-log";
import { createDb, type AppDb } from "../db/client";
import {
  deleteScanWithChildren,
  listScansOlderThan,
  pruneExpiredSessions,
  pruneExpiredVerifications,
  type BoundedSweepResult,
} from "../db/retention";
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
 * Scans deleted per tick. Each one costs four D1 statements plus an R2 list +
 * delete, so this bounds the sweep's share of a scheduled invocation's CPU
 * budget. A backlog drains across ticks (one every 15 minutes).
 */
const SCAN_RETENTION_MAX_PER_TICK = 50;

export interface RetentionSweepResult {
  auditEvents: BoundedSweepResult | null;
  sessions: BoundedSweepResult | null;
  verifications: BoundedSweepResult | null;
  scans: ScanRetentionResult | null;
}

interface ScanRetentionResult {
  retentionDays: number;
  candidates: number;
  deleted: number;
  /** Rows left in place because their R2 prefix could not be swept this tick. */
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
    emitOperationalEvent("error", "retention.scans.misconfigured", {
      reason: "not_a_positive_number",
      value: raw,
    });
    return null;
  }
  if (Math.floor(days) < SCAN_RETENTION_MIN_DAYS) {
    emitOperationalEvent("error", "retention.scans.misconfigured", {
      reason: "below_minimum",
      value: raw,
      minimumDays: SCAN_RETENTION_MIN_DAYS,
    });
    return null;
  }
  return Math.floor(days);
}

export async function runRetentionSweep(
  env: Cloudflare.Env,
  options: { now?: Date } = {},
): Promise<RetentionSweepResult> {
  const startedAtMs = Date.now();
  const now = options.now ?? new Date();
  const db = createDb(env.DB);

  const result: RetentionSweepResult = {
    auditEvents: await sweep("audit_events", () =>
      pruneAuditEventsOlderThan(db, cutoff(now, AUDIT_LOG_RETENTION_DAYS)),
    ),
    sessions: await sweep("sessions", () => pruneExpiredSessions(db, now)),
    verifications: await sweep("verifications", () => pruneExpiredVerifications(db, now)),
    scans: await sweepScans(db, env, now),
  };

  emitOperationalEvent("info", "retention.swept", {
    durationMs: durationMsSince(startedAtMs),
    auditEventsDeleted: result.auditEvents?.deleted ?? null,
    sessionsDeleted: result.sessions?.deleted ?? null,
    verificationsDeleted: result.verifications?.deleted ?? null,
    scansDeleted: result.scans?.deleted ?? null,
    scanRetentionDays: result.scans?.retentionDays ?? null,
  });
  return result;
}

async function sweep(
  name: string,
  run: () => Promise<BoundedSweepResult>,
): Promise<BoundedSweepResult | null> {
  try {
    const outcome = await run();
    emitOperationalEvent("info", `retention.${name}.pruned`, {
      deleted: outcome.deleted,
      batches: outcome.batches,
      moreRemaining: outcome.moreRemaining,
    });
    return outcome;
  } catch (err) {
    emitOperationalEvent("error", `retention.${name}.prune_failed`, {
      error: describeOperationalError(err),
    });
    return null;
  }
}

/**
 * Time-based scan retention. Destructive and therefore opt-in, and it holds to
 * the deletion-lifecycle rules in docs/artifact-storage.md:
 *
 * - The R2 prefix is swept BEFORE the D1 row, so redacted evidence can never
 *   outlive the metadata that points at it. If the sweep cannot drain the prefix,
 *   the row stays and the next tick retries — the reverse order would leave
 *   objects no longer reachable from any row.
 * - It requires the `ARTIFACTS` binding. Without it there is no way to reach a
 *   scan's objects, so deleting rows would strand them; the sweep is skipped.
 */
async function sweepScans(
  db: AppDb,
  env: Cloudflare.Env,
  now: Date,
): Promise<ScanRetentionResult | null> {
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

  try {
    const candidates = await listScansOlderThan(
      db,
      cutoff(now, retentionDays),
      SCAN_RETENTION_MAX_PER_TICK,
    );
    let deleted = 0;
    let deferred = 0;
    let objectsDeleted = 0;
    for (const candidate of candidates) {
      // A scan with no organization cannot be org-scoped-deleted and cannot have
      // an artifact prefix; leave it rather than widen the delete predicate.
      if (!candidate.organizationId) {
        deferred += 1;
        continue;
      }
      const swept = await deleteScanArtifacts(bucket, candidate.organizationId, candidate.id);
      if (!swept.ok) {
        deferred += 1;
        continue;
      }
      objectsDeleted += swept.objectsDeleted;
      if (await deleteScanWithChildren(db, candidate.id, candidate.organizationId)) deleted += 1;
    }
    const outcome: ScanRetentionResult = {
      retentionDays,
      candidates: candidates.length,
      deleted,
      deferred,
      objectsDeleted,
    };
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

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
