import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubWorkflowGates, scans } from "./schema";

export const SCAN_MAINTENANCE_LEASE_MS = 60 * 60 * 1000;

export const SCAN_MAINTENANCE_KINDS = {
  retention: "retention",
  retentionArtifactsRemoved: "retention-artifacts-removed",
} as const;

type ScanMaintenanceKind = (typeof SCAN_MAINTENANCE_KINDS)[keyof typeof SCAN_MAINTENANCE_KINDS];

export interface ClaimedScanMaintenance {
  artifactStorageVersion: number | null;
  kind: ScanMaintenanceKind;
  token: string;
}

interface ScanMaintenanceClaimInput {
  scanId: string;
  organizationId: string;
  token: string;
  claimedAt: Date;
  staleBefore: Date;
}

/**
 * Claim a still-private scan for retention before leaving D1 for R2.
 *
 * Retention may recover any stale maintenance lease. If the previous retention
 * pass already removed R2 evidence, the explicit tombstone kind survives the
 * ownership rotation so sharing remains closed across every retry.
 */
export async function claimScanForRetention(
  db: AppDb,
  input: ScanMaintenanceClaimInput,
): Promise<ClaimedScanMaintenance | null> {
  // SQLite evaluates SET expressions against the pre-update row, so this keeps
  // the irreversible phase while atomically rotating the owner token.
  const claimedKind = sql<ScanMaintenanceKind>`case
    when ${scans.maintenanceKind} = ${SCAN_MAINTENANCE_KINDS.retentionArtifactsRemoved}
    then ${SCAN_MAINTENANCE_KINDS.retentionArtifactsRemoved}
    else ${SCAN_MAINTENANCE_KINDS.retention}
  end`;
  const claimed = await db
    .update(scans)
    .set({
      maintenanceKind: claimedKind,
      maintenanceToken: input.token,
      maintenanceClaimedAt: input.claimedAt,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        isNull(scans.publicShareToken),
        or(
          and(isNull(scans.maintenanceKind), isNull(scans.maintenanceToken)),
          and(
            sql`${scans.maintenanceKind} is not null`,
            sql`${scans.maintenanceToken} is not null`,
            or(
              isNull(scans.maintenanceClaimedAt),
              lt(scans.maintenanceClaimedAt, input.staleBefore),
            ),
          ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(githubWorkflowGates)
            .where(
              and(
                eq(githubWorkflowGates.status, "pending"),
                or(
                  eq(githubWorkflowGates.id, scans.gateId),
                  eq(githubWorkflowGates.scanId, scans.id),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({
      artifactStorageVersion: scans.artifactStorageVersion,
      kind: scans.maintenanceKind,
      token: scans.maintenanceToken,
    });
  return normalizeScanMaintenanceClaim(claimed[0]);
}

/** Release a failed maintenance attempt without disturbing a newer owner. */
export async function releaseScanMaintenanceClaim(
  db: AppDb,
  input: { scanId: string; organizationId: string; token: string },
): Promise<boolean> {
  const released = await db
    .update(scans)
    .set({ maintenanceKind: null, maintenanceToken: null, maintenanceClaimedAt: null })
    .where(ownedScanMaintenance(input))
    .returning({ id: scans.id });
  return released.length > 0;
}

/**
 * Persist the irreversible retention phase and make it immediately reclaimable.
 * This is deliberately not a release: sharing must stay closed after R2 evidence
 * is gone, even when later D1 teardown fails repeatedly.
 */
export async function markScanRetentionArtifactsRemoved(
  db: AppDb,
  input: { scanId: string; organizationId: string; token: string },
): Promise<boolean> {
  const updated = await db
    .update(scans)
    .set({
      maintenanceKind: SCAN_MAINTENANCE_KINDS.retentionArtifactsRemoved,
      maintenanceClaimedAt: new Date(0),
    })
    .where(ownedScanMaintenance(input))
    .returning({ id: scans.id });
  return updated.length > 0;
}

function ownedScanMaintenance(input: { scanId: string; organizationId: string; token: string }) {
  return and(
    eq(scans.id, input.scanId),
    eq(scans.organizationId, input.organizationId),
    eq(scans.maintenanceToken, input.token),
  );
}

function normalizeScanMaintenanceClaim(
  row:
    | {
        artifactStorageVersion: number | null;
        kind: ScanMaintenanceKind | null;
        token: string | null;
      }
    | undefined,
): ClaimedScanMaintenance | null {
  if (!row?.kind || !row.token) return null;
  return {
    artifactStorageVersion: row.artifactStorageVersion,
    kind: row.kind,
    token: row.token,
  };
}
