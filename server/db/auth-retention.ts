import { lt } from "drizzle-orm";
import type { AppDb } from "./client";
import { session, verification } from "./schema";

// Avoid racing Better Auth session refreshes at the expiry boundary.
export const AUTH_ROW_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface PrunedAuthRowCounts {
  sessions: number;
  verifications: number;
}

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
