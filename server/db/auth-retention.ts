import { inArray, lt } from "drizzle-orm";
import type { AppDb } from "./client";
import { runBoundedSweep, type BoundedSweepOptions, type BoundedSweepResult } from "./retention";
import { session, verification } from "./schema";

/**
 * Grace period applied on top of a row's own `expires_at` before the sweep will
 * delete it. Better Auth refreshes a session by writing a new `expires_at` on
 * the same row, so a row that is merely a few seconds past expiry may still be
 * mid-refresh. A day of slack keeps the sweep well clear of that window while
 * still bounding how long dead rows (and the `ip_address` / `user_agent` they
 * carry) survive.
 */
export const AUTH_ROW_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface PrunedAuthRowCounts {
  sessions: number;
  verifications: number;
  /** True when a batch cap was hit, so rows may still be eligible next tick. */
  moreRemaining: boolean;
}

/**
 * Delete Better Auth rows whose own expiry passed more than the grace period
 * ago. Better Auth's Drizzle adapter never removes them: an expired session is
 * rejected at auth time but its row stays forever, so `session` grows with every
 * sign-in and keeps each dead session's IP address and user agent indefinitely.
 * `verification` has the same shape — short-lived email-verification and
 * password-reset values that are consumed or abandoned but never cleaned up.
 *
 * Deleting an expired row cannot sign anyone out: Better Auth already treats
 * `expires_at` in the past as no session at all, and a consumed verification
 * value is single-use. This is purely removing rows that can no longer
 * authenticate anything.
 *
 * Both sweeps are batched (LIMIT + iterate, capped per call) because this runs on
 * a scheduled invocation with a fixed CPU budget: the first tick after a long
 * backlog would otherwise issue a DELETE whose size is whatever the table
 * accumulated. A capped call reports `moreRemaining` and the next tick continues.
 * The `expires_at` predicates are served by `session_expires_idx` /
 * `verification_expires_idx`.
 */
export async function pruneExpiredAuthRows(
  db: AppDb,
  now: Date = new Date(),
  options: BoundedSweepOptions = {},
): Promise<PrunedAuthRowCounts> {
  const cutoff = new Date(now.getTime() - AUTH_ROW_RETENTION_GRACE_MS);

  const sessions = await runBoundedSweep(options, (limit) =>
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
  const verifications: BoundedSweepResult = await runBoundedSweep(options, (limit) =>
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

  return {
    sessions: sessions.deleted,
    verifications: verifications.deleted,
    moreRemaining: sessions.moreRemaining || verifications.moreRemaining,
  };
}
