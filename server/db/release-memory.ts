import { and, desc, eq, ne } from "drizzle-orm";
import { loadScanArtifacts } from "../lib/scan/artifacts";
import type { ProfileFindingInput } from "../lib/scan/release-memory";
import type { AppDb } from "./client";
import { scans } from "./schema";

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
 * Findings live in the digest-verified R2 report.json, so the artifact bucket is
 * required to build a profile at all; without a readable report this returns
 * null and the caller degrades to "none".
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
  // The prior's findings live only in its report.json, so a report that could
  // not be read (missing binding, digest mismatch, transient R2 error —
  // loadScanArtifacts returns null rather than throwing) must not be reported as
  // an empty profile: that would mark every current finding "new" (a false
  // "diverged"). Return null so the caller degrades to "none" instead.
  if (!artifactDetail) return null;
  // Release memory compares deterministic profiles only: the report also carries
  // the prior review's AI rows (source "ai"), which are advisory and
  // non-deterministic, so they must not enter the profile.
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
