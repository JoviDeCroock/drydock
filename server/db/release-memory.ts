import { and, desc, eq, ne } from "drizzle-orm";
import { loadScanArtifacts } from "../lib/scan-artifacts";
import type { ProfileFindingInput } from "../lib/release-memory";
import type { AppDb } from "./client";
import { scanFindings, scans } from "./schema";

export interface PriorApprovedScanQuery {
  organizationId: string;
  packageName: string;
  /** The in-flight scan; excluded so a re-run never compares against itself. */
  excludeScanId: string;
}

export interface PriorApprovedScanFindings {
  scanId: string;
  stagedVersion: string | null;
  decidedAt: Date | null;
  findings: ProfileFindingInput[];
}

/**
 * Fetch the most recent completed scan in the SAME organization for the SAME
 * package that a maintainer decided "publish", plus its deterministic rule
 * findings. Organization scoping is mandatory: release memory must never leak
 * another organization's review history.
 *
 * Findings for artifact-backed scans live in the digest-verified R2 report.json
 * (persistScan stopped duplicating them into `scan_findings`), so pass the
 * artifact bucket to read those; legacy/degraded scans fall back to the D1 rows.
 */
export async function getPriorApprovedScanFindings(
  db: AppDb,
  query: PriorApprovedScanQuery,
  artifactBucket?: R2Bucket,
): Promise<PriorApprovedScanFindings | null> {
  const rows = await db
    .select({
      id: scans.id,
      organizationId: scans.organizationId,
      stagedVersion: scans.stagedVersion,
      decidedAt: scans.decidedAt,
      reportDigest: scans.reportDigest,
      artifactStorageVersion: scans.artifactStorageVersion,
      artifactManifestKey: scans.artifactManifestKey,
      artifactManifestDigest: scans.artifactManifestDigest,
      artifactManifestSize: scans.artifactManifestSize,
      reportArtifactKey: scans.reportArtifactKey,
      fileSamplesArtifactKey: scans.fileSamplesArtifactKey,
      diffArtifactKey: scans.diffArtifactKey,
    })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, query.organizationId),
        eq(scans.packageName, query.packageName),
        eq(scans.status, "complete"),
        eq(scans.decision, "publish"),
        ne(scans.id, query.excludeScanId),
      ),
    )
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(1);

  const prior = rows[0];
  if (!prior) return null;

  const artifactDetail = await loadScanArtifacts(artifactBucket, prior);
  const findingRows = artifactDetail
    ? artifactDetail.findings
    : await db
        .select({
          ruleId: scanFindings.ruleId,
          severity: scanFindings.severity,
          file: scanFindings.file,
        })
        .from(scanFindings)
        .where(and(eq(scanFindings.scanId, prior.id), eq(scanFindings.source, "rule")));

  return {
    scanId: prior.id,
    stagedVersion: prior.stagedVersion,
    decidedAt: prior.decidedAt,
    findings: findingRows.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      file: finding.file,
    })),
  };
}
