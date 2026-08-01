import { and, desc, eq, ne } from "drizzle-orm";
import { loadScanArtifacts } from "../lib/scan/artifacts";
import { readPersistedFindingProfile, type ProfileFindingInput } from "../lib/scan/release-memory";
import { emitOperationalEvent } from "../lib/platform/observability";
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
 * Scans completed after `finding_profile_json` was added carry the profile on the
 * row itself, which is all this lookup needs — that is the fast path and it costs
 * one D1 read. Rows written before the column fall back to projecting the
 * profile out of the prior scan's artifacts: for artifact-backed scans those
 * findings live in the digest-verified R2 report.json (persistScan stopped
 * duplicating them into `scan_findings`), so pass the artifact bucket to read
 * those; legacy/degraded scans fall back further to the D1 rows.
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
      findingProfileJson: scans.findingProfileJson,
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

  // Fast path: the profile the prior scan recorded at completion. Every scan used
  // to download and digest-verify the prior release's ENTIRE artifact bundle
  // (report.json + files.json + diff.json) just to project (ruleId, severity,
  // file) out of it — three fields per finding, off tens of MiB of evidence.
  const persistedProfile = readPersistedFindingProfile(prior.findingProfileJson);
  if (persistedProfile) {
    return {
      scanId: prior.id,
      stagedVersion: prior.stagedVersion,
      decidedAt: prior.decidedAt,
      findings: persistedProfile,
    };
  }
  if (prior.findingProfileJson !== null) {
    // A stored-but-unreadable profile is a bug or a shape change, not a normal
    // legacy row: surface it, then fall through to the artifact projection rather
    // than trusting a blob we could not parse.
    emitOperationalEvent("warn", "scan.release_memory.profile_unreadable", {
      scanId: prior.id,
      organizationId: prior.organizationId,
    });
  }

  const artifactDetail = await loadScanArtifacts(artifactBucket, prior);
  // An artifact-backed prior keeps NO scan_findings rows in D1, so if its report
  // could not be read (missing binding, digest mismatch, transient R2 error —
  // loadScanArtifacts returns null rather than throwing) the D1 fallback query
  // below would return zero rows and we would report a fabricated empty profile,
  // marking every current finding "new" (a false "diverged"). Return null so the
  // caller degrades to "none" instead of trusting a corrupt-empty profile.
  if (prior.artifactStorageVersion !== null && !artifactDetail) return null;
  // Release memory compares deterministic profiles only: artifact-backed
  // details also carry the prior review's AI rows (source "ai"), which are
  // advisory and non-deterministic, so they must not enter the profile —
  // mirroring the D1 fallback's `source = 'rule'` predicate below.
  const findingRows = artifactDetail
    ? artifactDetail.findings.filter((finding) => finding.source === "rule")
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
