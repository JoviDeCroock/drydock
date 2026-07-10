import { and, desc, eq, gte, ne } from "drizzle-orm";
import {
  BURST_LOOKBACK_DAYS,
  type OrgScanHistoryRow,
  type PackageScanHistoryRow,
} from "../lib/release-fingerprint";
import type { AppDb } from "./client";
import { githubWorkflowGates, scans } from "./schema";

// History reads for the release-process fingerprint rules. Every query is
// organization-scoped; the row caps keep a single scan's history read bounded
// (the pure module treats a capped org read as "history unknown" and stays
// silent rather than claiming a burst is unprecedented on partial data).

/** Org history rows fetched per scan. Rides `scans_org_created_idx`. */
export const RELEASE_FINGERPRINT_ORG_HISTORY_CAP = 500;
/** Prior package scans fetched per scan. Rides `scans_package_idx`. */
export const RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP = 100;

export interface ReleaseFingerprintHistory {
  orgHistory: OrgScanHistoryRow[];
  orgHistoryTruncated: boolean;
  packageHistory: PackageScanHistoryRow[];
  /**
   * Source + gate identity of the current scan's pending row, when it exists.
   * Scans always run against a pre-created row today, but the pipeline must
   * not depend on that: a missing row degrades to "source unknown" and the
   * source-drift rule stays silent.
   */
  currentScan: {
    source: string;
    gateRepositoryFullName: string | null;
    gateEnvironment: string | null;
  } | null;
}

export async function loadReleaseFingerprintHistory(
  db: AppDb,
  args: {
    organizationId: string;
    scanId: string;
    packageName: string | null;
    now?: Date;
  },
): Promise<ReleaseFingerprintHistory> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - BURST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // The gate join carries its own organization guard so a (never expected)
  // cross-org gate_id reference can never leak another org's repo/environment.
  const gateJoin = and(
    eq(githubWorkflowGates.id, scans.gateId),
    eq(githubWorkflowGates.organizationId, args.organizationId),
  );

  const [orgRows, currentRows, packageRows] = await Promise.all([
    db
      .select({
        id: scans.id,
        packageName: scans.packageName,
        status: scans.status,
        createdAt: scans.createdAt,
      })
      .from(scans)
      .where(
        and(
          eq(scans.organizationId, args.organizationId),
          gte(scans.createdAt, since),
          ne(scans.id, args.scanId),
        ),
      )
      .orderBy(desc(scans.createdAt), desc(scans.id))
      .limit(RELEASE_FINGERPRINT_ORG_HISTORY_CAP),
    db
      .select({
        source: scans.source,
        gateRepositoryFullName: githubWorkflowGates.repositoryFullName,
        gateEnvironment: githubWorkflowGates.environment,
      })
      .from(scans)
      .leftJoin(githubWorkflowGates, gateJoin)
      .where(and(eq(scans.id, args.scanId), eq(scans.organizationId, args.organizationId)))
      .limit(1),
    args.packageName
      ? db
          .select({
            id: scans.id,
            status: scans.status,
            source: scans.source,
            gateRepositoryFullName: githubWorkflowGates.repositoryFullName,
            gateEnvironment: githubWorkflowGates.environment,
          })
          .from(scans)
          .leftJoin(githubWorkflowGates, gateJoin)
          .where(
            and(
              eq(scans.organizationId, args.organizationId),
              eq(scans.packageName, args.packageName),
              eq(scans.status, "complete"),
              ne(scans.id, args.scanId),
            ),
          )
          .orderBy(desc(scans.createdAt), desc(scans.id))
          .limit(RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP)
      : Promise.resolve([]),
  ]);

  return {
    orgHistory: orgRows,
    orgHistoryTruncated: orgRows.length >= RELEASE_FINGERPRINT_ORG_HISTORY_CAP,
    packageHistory: packageRows,
    currentScan: currentRows[0] ?? null,
  };
}
