import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "./client";
import { scanReportShares } from "./schema";

export interface ScanReportShareStatus {
  active: boolean;
  createdAt: Date | null;
}

// Read-only status for the settings/detail UI: whether an unrevoked share link
// exists for the scan. The token itself is never recoverable from the database.
export async function getScanReportShareStatus(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<ScanReportShareStatus> {
  const rows = await db
    .select({ createdAt: scanReportShares.createdAt, revokedAt: scanReportShares.revokedAt })
    .from(scanReportShares)
    .where(
      and(eq(scanReportShares.scanId, scanId), eq(scanReportShares.organizationId, organizationId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return { active: false, createdAt: null };
  return { active: true, createdAt: row.createdAt };
}

// Create the share row for a scan, or rotate it in place: the previous token
// hash is replaced, which invalidates every previously issued link.
export async function upsertScanReportShare(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    createdByUserId: string;
    tokenHash: string;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(scanReportShares)
    .values({
      id: crypto.randomUUID(),
      scanId: input.scanId,
      organizationId: input.organizationId,
      tokenHash: input.tokenHash,
      createdByUserId: input.createdByUserId,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: scanReportShares.scanId,
      set: {
        tokenHash: input.tokenHash,
        createdByUserId: input.createdByUserId,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
}

export async function revokeScanReportShare(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(scanReportShares)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(scanReportShares.scanId, scanId),
        eq(scanReportShares.organizationId, organizationId),
        isNull(scanReportShares.revokedAt),
      ),
    )
    .returning({ id: scanReportShares.id });
  return result.length > 0;
}

// Resolve an unrevoked share token hash to the scan it exposes. This is the
// only authorization step on the public report path, so it must never match a
// revoked row.
export async function getScanReportShareByTokenHash(
  db: AppDb,
  tokenHash: string,
): Promise<{ scanId: string; organizationId: string } | null> {
  const rows = await db
    .select({
      scanId: scanReportShares.scanId,
      organizationId: scanReportShares.organizationId,
    })
    .from(scanReportShares)
    .where(and(eq(scanReportShares.tokenHash, tokenHash), isNull(scanReportShares.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}
