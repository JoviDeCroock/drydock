import { lt } from "drizzle-orm";
import type { AppDb } from "./client";
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
 */
export async function pruneExpiredAuthRows(
  db: AppDb,
  now: Date = new Date(),
): Promise<PrunedAuthRowCounts> {
  const cutoff = new Date(now.getTime() - AUTH_ROW_RETENTION_GRACE_MS);

  const deletedSessions = await db
    .delete(session)
    .where(lt(session.expiresAt, cutoff))
    .returning({ id: session.id });
  const deletedVerifications = await db
    .delete(verification)
    .where(lt(verification.expiresAt, cutoff))
    .returning({ id: verification.id });

  return { sessions: deletedSessions.length, verifications: deletedVerifications.length };
}
