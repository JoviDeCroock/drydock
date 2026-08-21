/**
 * Shapes and caps for scan artifacts stored in R2.
 *
 * An artifact set is the offloaded body of a scan — its files, its diff, and
 * its report — written once and thereafter read back digest-verified.
 */
import { type DiffEntry, type FileRecord, type FindingDiffAnnotation } from "../../review";
import { SCAN_FILE_SAMPLE_LIMIT } from "../../sample-retention";

export const SCAN_ARTIFACT_STORAGE_VERSION = 1;
export const SCAN_ARTIFACT_WRITE_ATTEMPTS = 3;
export const ARTIFACT_CONTENT_TYPE = "application/json; charset=utf-8";

// Per-file display sample bound. Deterministic detection runs over the WHOLE
// retained body of the reviewed side in the parent worker (the sandbox does not
// clip the staged text; see issue #191), so this cap is purely about what we
// persist for the diff/file viewer — it never narrows the review window. A
// finding past this bound is surfaced in the UI's out-of-sample banner rather
// than pinned to a hunk. Lives in `sample-retention.ts` next to the baseline
// wire cap it is sized against; re-exported here because this is where the clip
// is applied.
export { SCAN_FILE_SAMPLE_LIMIT };

export interface ScanArtifactMetadata {
  artifactStorageVersion: number;
  artifactManifestKey: string;
  artifactManifestDigest: string;
  artifactManifestSize: number;
  reportArtifactKey: string;
  fileSamplesArtifactKey: string;
  diffArtifactKey: string;
}

export interface ScanArtifactFileRow {
  path: string;
  status: string;
  size: number | null;
  sha256: string | null;
  flagsJson: unknown;
  textSample: string | null;
}

// Mirrors `scan_findings.$inferSelect` so an R2-sourced finding is a drop-in
// replacement for a D1 row on the read path. The id is derived from the finding
// index (`artifactFindingId`) rather than a persisted UUID, so it stays stable
// across reads without a per-finding D1 row.
export interface ScanArtifactFindingRow {
  id: string;
  scanId: string;
  severity: string;
  file: string;
  evidence: string;
  reason: string;
  line: number | null;
  source: string;
  ruleId: string | null;
  ruleVersion: string | null;
}

export interface ScanArtifactScanRow {
  id: string;
  organizationId: string | null;
  reportDigest: string | null;
  artifactStorageVersion: number | null;
  artifactManifestKey: string | null;
  artifactManifestDigest: string | null;
  artifactManifestSize: number | null;
  reportArtifactKey: string | null;
  fileSamplesArtifactKey: string | null;
  diffArtifactKey: string | null;
}

export interface ScanArtifactsDetail {
  files: ScanArtifactFileRow[];
  diff: DiffEntry[];
  // Deterministic findings + their diff annotations, parsed from the canonical
  // report.json. These let the detail read source findings from R2 once the
  // duplicate `scan_findings` rows are no longer written to D1.
  findings: ScanArtifactFindingRow[];
  findingAnnotations: Map<string, FindingDiffAnnotation>;
}

export interface ScanArtifactsManifestDetail {
  manifest: ScanArtifactsManifest;
}

export interface ScanArtifactDescriptor {
  key: string;
  digest: string;
  size: number;
  contentType: string;
  count?: number;
}

export interface ScanArtifactsManifest {
  version: number;
  scanId: string;
  organizationId: string;
  generatedAt: string;
  artifacts: {
    report: ScanArtifactDescriptor;
    files: ScanArtifactDescriptor;
    diff: ScanArtifactDescriptor;
  };
}

export interface WriteScanArtifactsInput {
  organizationId: string;
  scanId: string;
  reportJson: string;
  reportDigest: string;
  files: FileRecord[];
  diff: DiffEntry[];
  generatedAt: string;
}
