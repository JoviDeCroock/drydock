import { emitArtifactFallback, readDigestVerifiedJsonText, readVerifiedJsonText } from "./json-io";
import {
  parseDiffArtifact,
  parseFilesArtifact,
  parseManifest,
  parseReportArtifactMetadata,
  parseReportFindings,
} from "./parse";
import {
  SCAN_ARTIFACT_STORAGE_VERSION,
  type ScanArtifactFileRow,
  type ScanArtifactScanRow,
  type ScanArtifactsDetail,
  type ScanArtifactsManifestDetail,
} from "./types";
/**
 * Reading a scan body back, with the D1 fallback.
 */
import {} from "../../review";
import { describeOperationalError } from "../../platform/observability";

export function scanArtifactReadBucket(
  env: Pick<Cloudflare.Env, "ARTIFACTS" | "SCAN_ARTIFACT_READS_DISABLED">,
): R2Bucket | undefined {
  return env.SCAN_ARTIFACT_READS_DISABLED === "true" || env.SCAN_ARTIFACT_READS_DISABLED === "1"
    ? undefined
    : env.ARTIFACTS;
}

export async function loadScanArtifacts(
  bucket: R2Bucket | undefined,
  scan: ScanArtifactScanRow,
  // `includeFileSamples: false` skips the files.json read while keeping the
  // report + diff artifacts (and therefore findings and their diff annotations)
  // exactly as they are with it. The file-samples payload is by far the largest
  // artifact — one redacted sample per file, capped at SCAN_FILE_SAMPLE_LIMIT
  // each — so callers that never read `files` should not pay for it.
  options: { includeFileSamples?: boolean } = {},
): Promise<ScanArtifactsDetail | null> {
  const manifestDetail = await loadScanArtifactsManifest(bucket, scan);
  if (!manifestDetail) return null;
  const { manifest } = manifestDetail;

  // The detail read also sources findings from report.json (they are no longer
  // duplicated into D1), so the verified manifest's report descriptor must match
  // the digest D1 recorded for the scan. readVerifiedJsonText then ties the
  // report bytes to that digest, making the parsed findings authoritative.
  if (manifest.artifacts.report.digest !== scan.reportDigest) {
    emitArtifactFallback("report_digest_mismatch", scan, {
      expectedDigest: scan.reportDigest,
      actualDigest: manifest.artifacts.report.digest,
    });
    return null;
  }

  const includeFileSamples = options.includeFileSamples ?? true;
  try {
    const [reportText, filesText, diffText] = await Promise.all([
      readVerifiedJsonText(bucket as R2Bucket, {
        ...manifest.artifacts.report,
        scanId: scan.id,
        kind: "report",
      }),
      includeFileSamples
        ? readVerifiedJsonText(bucket as R2Bucket, {
            ...manifest.artifacts.files,
            scanId: scan.id,
            kind: "files",
          })
        : null,
      readVerifiedJsonText(bucket as R2Bucket, {
        ...manifest.artifacts.diff,
        scanId: scan.id,
        kind: "diff",
      }),
    ]);

    const reportFindings = parseReportFindings(reportText, scan.id);
    const files = filesText === null ? [] : parseFilesArtifact(filesText, scan.id);
    const diff = parseDiffArtifact(diffText, scan.id);
    if (!files || !diff || !reportFindings) {
      emitArtifactFallback("artifact_payload_invalid", scan);
      return null;
    }
    return {
      files,
      diff,
      findings: reportFindings.findings,
      findingAnnotations: reportFindings.annotations,
    };
  } catch (err) {
    emitArtifactFallback("read_failed", scan, { error: describeOperationalError(err) });
    return null;
  }
}

export async function loadScanArtifactMetadata(
  bucket: R2Bucket | undefined,
  scan: ScanArtifactScanRow,
): Promise<ScanArtifactsDetail | null> {
  if (!bucket || !hasReportArtifactMetadata(scan)) return null;

  try {
    const reportText = await readDigestVerifiedJsonText(bucket, {
      key: scan.reportArtifactKey,
      digest: scan.reportDigest,
      scanId: scan.id,
      kind: "report",
    });
    const detail = parseReportArtifactMetadata(reportText, scan.id);
    if (!detail) {
      emitArtifactFallback("artifact_payload_invalid", scan);
      return null;
    }
    return detail;
  } catch (err) {
    emitArtifactFallback("read_failed", scan, { error: describeOperationalError(err) });
    return null;
  }
}

export async function loadScanArtifactFile(
  bucket: R2Bucket | undefined,
  scan: ScanArtifactScanRow,
  path: string,
): Promise<ScanArtifactFileRow | null> {
  const manifestDetail = await loadScanArtifactsManifest(bucket, scan);
  if (!manifestDetail) return null;

  try {
    const filesText = await readVerifiedJsonText(bucket as R2Bucket, {
      ...manifestDetail.manifest.artifacts.files,
      scanId: scan.id,
      kind: "files",
    });
    const files = parseFilesArtifact(filesText, scan.id);
    if (!files) {
      emitArtifactFallback("artifact_payload_invalid", scan);
      return null;
    }
    return files.find((file) => file.path === path) ?? null;
  } catch (err) {
    emitArtifactFallback("read_failed", scan, { error: describeOperationalError(err) });
    return null;
  }
}

// R2 lifecycle cleanup: drop derived artifacts when the D1 rows that point at
// them are deleted, so redacted evidence never outlives its metadata. Both take
// the raw ARTIFACTS bucket — not scanArtifactReadBucket — because deletion is a
// teardown concern, and SCAN_ARTIFACT_READS_DISABLED (a read kill-switch) must
// not strand objects. Both are fail-soft: a delete error is logged, never
// thrown, so it can't abort the surrounding D1 teardown (account/org deletion
// must still complete). A leaked object is recoverable by re-running the sweep.

async function loadScanArtifactsManifest(
  bucket: R2Bucket | undefined,
  scan: ScanArtifactScanRow,
): Promise<ScanArtifactsManifestDetail | null> {
  if (!bucket || !hasArtifactMetadata(scan)) return null;

  try {
    const manifestText = await readVerifiedJsonText(bucket, {
      key: scan.artifactManifestKey,
      digest: scan.artifactManifestDigest,
      size: scan.artifactManifestSize,
      scanId: scan.id,
      kind: "manifest",
    });
    const manifest = parseManifest(manifestText);
    if (
      !manifest ||
      manifest.version !== SCAN_ARTIFACT_STORAGE_VERSION ||
      manifest.scanId !== scan.id ||
      manifest.organizationId !== scan.organizationId ||
      manifest.artifacts.report.key !== scan.reportArtifactKey ||
      manifest.artifacts.files.key !== scan.fileSamplesArtifactKey ||
      manifest.artifacts.diff.key !== scan.diffArtifactKey
    ) {
      emitArtifactFallback("manifest_invalid", scan);
      return null;
    }
    return { manifest };
  } catch (err) {
    emitArtifactFallback("read_failed", scan, { error: describeOperationalError(err) });
    return null;
  }
}

function hasArtifactMetadata(scan: ScanArtifactScanRow): scan is ScanArtifactScanRow & {
  organizationId: string;
  reportDigest: string;
  artifactStorageVersion: number;
  artifactManifestKey: string;
  artifactManifestDigest: string;
  artifactManifestSize: number;
  reportArtifactKey: string;
  fileSamplesArtifactKey: string;
  diffArtifactKey: string;
} {
  return (
    scan.organizationId !== null &&
    scan.reportDigest !== null &&
    scan.artifactStorageVersion === SCAN_ARTIFACT_STORAGE_VERSION &&
    typeof scan.artifactManifestKey === "string" &&
    typeof scan.artifactManifestDigest === "string" &&
    typeof scan.artifactManifestSize === "number" &&
    typeof scan.reportArtifactKey === "string" &&
    typeof scan.fileSamplesArtifactKey === "string" &&
    typeof scan.diffArtifactKey === "string"
  );
}

function hasReportArtifactMetadata(scan: ScanArtifactScanRow): scan is ScanArtifactScanRow & {
  reportDigest: string;
  artifactStorageVersion: number;
  reportArtifactKey: string;
} {
  return (
    scan.reportDigest !== null &&
    scan.artifactStorageVersion === SCAN_ARTIFACT_STORAGE_VERSION &&
    typeof scan.reportArtifactKey === "string"
  );
}
