import { deleteArtifactsByPrefix, putVerifiedJson, readVerifiedJsonText } from "./json-io";
import { artifactKeys, scanArtifactRunPrefix } from "./keys";
import { parseDiffArtifact, parseFilesArtifact } from "./parse";
import { loadScanArtifactsManifest } from "./read";
import {
  SCAN_ARTIFACT_STORAGE_VERSION,
  type ScanArtifactScanRow,
  type ScanArtifactsManifest,
  type WrittenScanArtifacts,
} from "./types";
import { canonicalJson } from "../../platform/canonical-json";
import { sha256Hex } from "../../platform/crypto-utils";

/**
 * Copy a completed scan's artifact set to another scan of the same
 * organization, for a gate that reuses an approved review instead of running
 * it again (PyPI PEP 694 two-gate staging).
 *
 * Every source object is read digest-verified first. The report is copied
 * byte for byte, so the copy keeps the source's report digest; the files and
 * diff payloads embed their scan id, so they are re-keyed to the target. The
 * copy lives under the target's own prefix, so deleting either scan never
 * strands the other. Returns null when the source set cannot be read intact.
 */
export async function copyScanArtifacts(
  bucket: R2Bucket | undefined,
  source: ScanArtifactScanRow,
  targetScanId: string,
): Promise<WrittenScanArtifacts | null> {
  if (!bucket || !source.organizationId) return null;
  const organizationId = source.organizationId;
  const detail = await loadScanArtifactsManifest(bucket, source);
  if (!detail || detail.manifest.artifacts.report.digest !== source.reportDigest) return null;
  const { artifacts } = detail.manifest;
  const [reportText, filesText, diffText] = await Promise.all([
    readVerifiedJsonText(bucket, { ...artifacts.report, scanId: source.id, kind: "report" }),
    readVerifiedJsonText(bucket, { ...artifacts.files, scanId: source.id, kind: "files" }),
    readVerifiedJsonText(bucket, { ...artifacts.diff, scanId: source.id, kind: "diff" }),
  ]);
  if (!parseFilesArtifact(filesText, source.id) || !parseDiffArtifact(diffText, source.id)) {
    return null;
  }
  const filesJson = canonicalJson({ ...JSON.parse(filesText), scanId: targetScanId });
  const diffJson = canonicalJson({ ...JSON.parse(diffText), scanId: targetScanId });

  const runId = crypto.randomUUID();
  const keys = artifactKeys(organizationId, targetScanId, runId);
  const meta = (artifactKind: string) => ({ scanId: targetScanId, artifactKind });
  try {
    const report = await putVerifiedJson(
      bucket,
      keys.report,
      reportText,
      artifacts.report.digest,
      meta("report"),
    );
    const files = await putVerifiedJson(
      bucket,
      keys.files,
      filesJson,
      await sha256Hex(filesJson),
      meta("files"),
    );
    const diff = await putVerifiedJson(
      bucket,
      keys.diff,
      diffJson,
      await sha256Hex(diffJson),
      meta("diff"),
    );
    const manifest: ScanArtifactsManifest = {
      version: SCAN_ARTIFACT_STORAGE_VERSION,
      scanId: targetScanId,
      organizationId,
      generatedAt: new Date().toISOString(),
      artifacts: {
        report,
        files: {
          ...files,
          ...(artifacts.files.count === undefined ? {} : { count: artifacts.files.count }),
        },
        diff: {
          ...diff,
          ...(artifacts.diff.count === undefined ? {} : { count: artifacts.diff.count }),
        },
      },
    };
    const manifestJson = canonicalJson(manifest);
    const written = await putVerifiedJson(
      bucket,
      keys.manifest,
      manifestJson,
      await sha256Hex(manifestJson),
      meta("manifest"),
    );
    return {
      artifactRunPrefix: scanArtifactRunPrefix(organizationId, targetScanId, runId),
      artifactStorageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
      artifactManifestKey: written.key,
      artifactManifestDigest: written.digest,
      artifactManifestSize: written.size,
      reportArtifactKey: report.key,
      fileSamplesArtifactKey: files.key,
      diffArtifactKey: diff.key,
    };
  } catch (err) {
    // Nothing references this run yet; sweep it before the caller retries.
    await deleteArtifactsByPrefix(
      bucket,
      scanArtifactRunPrefix(organizationId, targetScanId, runId),
      {
        organizationId,
        scanId: targetScanId,
        scope: "run",
        reason: "copy_failed",
      },
    );
    throw err;
  }
}
