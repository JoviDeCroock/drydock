import { deleteArtifactsByPrefix, putVerifiedJson } from "./json-io";
import { artifactKeys, scanArtifactRunPrefix } from "./keys";
import {
  SCAN_ARTIFACT_STORAGE_VERSION,
  SCAN_ARTIFACT_WRITE_ATTEMPTS,
  type ScanArtifactFileRow,
  type ScanArtifactsManifest,
  type WriteScanArtifactsInput,
  type WrittenScanArtifacts,
} from "./types";
import { type DiffEntry, type FileRecord } from "../../review";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import { SCAN_FILE_SAMPLE_LIMIT } from "../../sample-retention";
import { sha256Hex } from "../../platform/crypto-utils";
import { stableJson } from "../../platform/stable-json";

export function scanFileRowsForArtifacts(
  files: FileRecord[],
  diff: DiffEntry[],
): ScanArtifactFileRow[] {
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  return files.map((file) => {
    const entry = diffByPath.get(file.path);
    const { textSample, flags } = clipDisplaySample(file.textSample, file.flags);
    return {
      path: file.path,
      status: entry?.status || "unknown",
      size: file.size,
      sha256: file.sha256,
      flagsJson: flags,
      textSample,
    };
  });
}

// Bound the persisted/display sample without touching the scanned text. The
// `truncated` flag is added here (not in the sandbox) because truncation is now
// a display concern: the full file was already scanned. Detection/AI consume the
// in-memory FileRecord, so this never strips a flag they rely on.
function clipDisplaySample(
  textSample: string | undefined,
  flags: string[],
): { textSample: string | null; flags: string[] } {
  if (!textSample) return { textSample: textSample ?? null, flags };
  if (textSample.length <= SCAN_FILE_SAMPLE_LIMIT) return { textSample, flags };
  const clippedFlags = flags.includes("truncated") ? flags : [...flags, "truncated"];
  return { textSample: textSample.slice(0, SCAN_FILE_SAMPLE_LIMIT), flags: clippedFlags };
}

export async function writeScanArtifactsWithRetry(
  bucket: R2Bucket | undefined,
  input: WriteScanArtifactsInput,
): Promise<WrittenScanArtifacts> {
  if (!bucket) {
    emitOperationalEvent("error", "scan.artifacts.binding_missing", {
      scanId: input.scanId,
      organizationId: input.organizationId,
    });
    throw new Error("ARTIFACTS binding is required to persist a completed scan");
  }
  // One run id for the whole retry loop: a retry is the *same* completion
  // attempt, so it replaces its own partial objects instead of orphaning them.
  // Concurrent completion attempts each run this function, so they still get
  // disjoint prefixes.
  const runId = crypto.randomUUID();
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCAN_ARTIFACT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await writeScanArtifacts(bucket, input, { runId });
    } catch (err) {
      lastError = err;
      const finalAttempt = attempt === SCAN_ARTIFACT_WRITE_ATTEMPTS;
      emitOperationalEvent(finalAttempt ? "error" : "warn", "scan.artifacts.write_failed", {
        scanId: input.scanId,
        organizationId: input.organizationId,
        runId,
        attempt,
        finalAttempt,
        error: describeOperationalError(err),
      });
      if (finalAttempt) {
        // D1 persistence has not started, so nothing can reference this run.
        // Sweep any objects a later put/readback failure left behind before the
        // queue retries with a new run id. The helper is fail-soft: cleanup
        // failure is logged without replacing the original write error.
        await deleteArtifactsByPrefix(
          bucket,
          scanArtifactRunPrefix(input.organizationId, input.scanId, runId),
          {
            organizationId: input.organizationId,
            scanId: input.scanId,
            scope: "run",
            reason: "write_failed",
          },
        );
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("scan artifact write failed");
}

/**
 * `options.runId` lets the retry loop above reuse one prefix across attempts.
 * Left unset, each call mints its own — which is what an isolated caller wants.
 */
export async function writeScanArtifacts(
  bucket: R2Bucket,
  input: WriteScanArtifactsInput,
  options: { runId?: string } = {},
): Promise<WrittenScanArtifacts> {
  const runId = options.runId ?? crypto.randomUUID();
  const keys = artifactKeys(input.organizationId, input.scanId, runId);
  const files = scanFileRowsForArtifacts(input.files, input.diff);
  const filesJson = stableJson({
    version: SCAN_ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    files,
  });
  const diffJson = stableJson({
    version: SCAN_ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    diff: input.diff,
  });

  const descriptors = {
    report: await putVerifiedJson(bucket, keys.report, input.reportJson, input.reportDigest, {
      scanId: input.scanId,
      artifactKind: "report",
    }),
    files: await putVerifiedJson(bucket, keys.files, filesJson, await sha256Hex(filesJson), {
      scanId: input.scanId,
      artifactKind: "files",
      count: String(files.length),
    }),
    diff: await putVerifiedJson(bucket, keys.diff, diffJson, await sha256Hex(diffJson), {
      scanId: input.scanId,
      artifactKind: "diff",
      count: String(input.diff.length),
    }),
  };

  const manifest: ScanArtifactsManifest = {
    version: SCAN_ARTIFACT_STORAGE_VERSION,
    scanId: input.scanId,
    organizationId: input.organizationId,
    generatedAt: input.generatedAt,
    artifacts: {
      report: descriptors.report,
      files: { ...descriptors.files, count: files.length },
      diff: { ...descriptors.diff, count: input.diff.length },
    },
  };
  const manifestJson = stableJson(manifest);
  const manifestDigest = await sha256Hex(manifestJson);
  const manifestDescriptor = await putVerifiedJson(
    bucket,
    keys.manifest,
    manifestJson,
    manifestDigest,
    {
      scanId: input.scanId,
      artifactKind: "manifest",
    },
  );

  emitOperationalEvent("info", "scan.artifacts.written", {
    scanId: input.scanId,
    organizationId: input.organizationId,
    runId,
    storageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    reportSize: descriptors.report.size,
    fileSampleCount: files.length,
    diffCount: input.diff.length,
  });

  return {
    artifactRunPrefix: scanArtifactRunPrefix(input.organizationId, input.scanId, runId),
    artifactStorageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    artifactManifestKey: manifestDescriptor.key,
    artifactManifestDigest: manifestDescriptor.digest,
    artifactManifestSize: manifestDescriptor.size,
    reportArtifactKey: descriptors.report.key,
    fileSamplesArtifactKey: descriptors.files.key,
    diffArtifactKey: descriptors.diff.key,
  };
}
