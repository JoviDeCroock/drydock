import { and, desc, eq, ne } from "drizzle-orm";
import { loadScanArtifacts } from "../lib/scan/artifacts";
import type { ProfileFindingInput } from "../lib/scan/release-memory";
import type { AppDb } from "./client";
import { scanEcosystemSql } from "./scan-query";
import { scans } from "./schema";

export interface PriorApprovedScanQuery {
  organizationId: string;
  packageName: string;
  /**
   * The registry the in-flight scan reviews, from the pipeline's adapter and
   * never from the package. The same name in another registry is another
   * package, and its approval says nothing about this one.
   */
  ecosystem: string;
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
 * package in the SAME ecosystem that a maintainer decided "publish", plus its
 * deterministic rule findings. Organization scoping is mandatory: release
 * memory must never leak another organization's review history.
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
        // A completed gate row whose summary predates the provenance snapshot
        // names no ecosystem, compares as NULL, and drops out: an approval that
        // cannot be attributed to a registry discounts nothing.
        eq(scanEcosystemSql, query.ecosystem),
      ),
    )
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(1);

  const prior = rows[0];
  if (!prior) return null;

  const artifactDetail = await loadScanArtifacts(artifactBucket, prior);
  // Missing evidence is not an empty prior profile.
  if (!artifactDetail) return null;
  // Advisory AI findings must not affect the deterministic release profile.
  const findingRows = artifactDetail.findings.filter((finding) => finding.source === "rule");

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
