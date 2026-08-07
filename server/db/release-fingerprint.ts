import { and, desc, eq, ne } from "drizzle-orm";
import type { PackageScanHistoryRow } from "../lib/release-fingerprint";
import type { AppDb } from "./client";
import { githubWorkflowGates, scans } from "./schema";

// History reads for the release-process fingerprint rules. Every query is
// organization-scoped; the row cap keeps a single scan's history read bounded.

/** Prior package scans fetched per scan. Rides `scans_package_idx`. */
const RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP = 100;

export interface ReleaseFingerprintHistory {
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
  },
): Promise<ReleaseFingerprintHistory> {
  // The gate join carries its own organization guard so a (never expected)
  // cross-org gate_id reference can never leak another org's repo/environment.
  const gateJoin = and(
    eq(githubWorkflowGates.id, scans.gateId),
    eq(githubWorkflowGates.organizationId, args.organizationId),
  );

  const [currentRows, packageRows] = await Promise.all([
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
    packageHistory: packageRows,
    currentScan: currentRows[0] ?? null,
  };
}
