import type { DiffEntry, FileRecord } from "./review";
import { describeOperationalError, emitOperationalEvent } from "./observability";
import { sha256Hex, stableJson, utf8Size } from "./stable-json";

export const SCAN_ARTIFACT_STORAGE_VERSION = 1;
export const SCAN_ARTIFACT_WRITE_ATTEMPTS = 3;
const ARTIFACT_CONTENT_TYPE = "application/json; charset=utf-8";

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
}

export function scanArtifactReadBucket(
  env: Pick<Cloudflare.Env, "ARTIFACTS" | "SCAN_ARTIFACT_READS_DISABLED">,
): R2Bucket | undefined {
  return env.SCAN_ARTIFACT_READS_DISABLED === "true" || env.SCAN_ARTIFACT_READS_DISABLED === "1"
    ? undefined
    : env.ARTIFACTS;
}

interface ScanArtifactDescriptor {
  key: string;
  digest: string;
  size: number;
  contentType: string;
  count?: number;
}

interface ScanArtifactsManifest {
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

export function scanFileRowsForArtifacts(
  files: FileRecord[],
  diff: DiffEntry[],
): ScanArtifactFileRow[] {
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  return files.map((file) => {
    const entry = diffByPath.get(file.path);
    return {
      path: file.path,
      status: entry?.status || "unknown",
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flags,
      textSample: file.textSample || null,
    };
  });
}

export async function maybeWriteScanArtifacts(
  bucket: R2Bucket | undefined,
  input: WriteScanArtifactsInput,
): Promise<ScanArtifactMetadata | null> {
  if (!bucket) {
    emitOperationalEvent("warn", "scan.artifacts.binding_missing", {
      scanId: input.scanId,
      organizationId: input.organizationId,
    });
    return null;
  }
  for (let attempt = 1; attempt <= SCAN_ARTIFACT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await writeScanArtifacts(bucket, input);
    } catch (err) {
      const finalAttempt = attempt === SCAN_ARTIFACT_WRITE_ATTEMPTS;
      emitOperationalEvent(finalAttempt ? "error" : "warn", "scan.artifacts.write_failed", {
        scanId: input.scanId,
        organizationId: input.organizationId,
        attempt,
        finalAttempt,
        error: describeOperationalError(err),
      });
      if (finalAttempt) return null;
    }
  }
  return null;
}

export async function writeScanArtifacts(
  bucket: R2Bucket,
  input: WriteScanArtifactsInput,
): Promise<ScanArtifactMetadata> {
  const keys = artifactKeys(input.organizationId, input.scanId);
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
    storageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    reportSize: descriptors.report.size,
    fileSampleCount: files.length,
    diffCount: input.diff.length,
  });

  return {
    artifactStorageVersion: SCAN_ARTIFACT_STORAGE_VERSION,
    artifactManifestKey: manifestDescriptor.key,
    artifactManifestDigest: manifestDescriptor.digest,
    artifactManifestSize: manifestDescriptor.size,
    reportArtifactKey: descriptors.report.key,
    fileSamplesArtifactKey: descriptors.files.key,
    diffArtifactKey: descriptors.diff.key,
  };
}

export async function loadScanArtifacts(
  bucket: R2Bucket | undefined,
  scan: ScanArtifactScanRow,
): Promise<ScanArtifactsDetail | null> {
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

    const reportText = await readVerifiedJsonText(bucket, {
      ...manifest.artifacts.report,
      scanId: scan.id,
      kind: "report",
    });
    const reportDigest = await sha256Hex(reportText);
    if (reportDigest !== scan.reportDigest) {
      emitArtifactFallback("report_digest_mismatch", scan, {
        expectedDigest: scan.reportDigest,
        actualDigest: reportDigest,
      });
      return null;
    }

    const [filesText, diffText] = await Promise.all([
      readVerifiedJsonText(bucket, {
        ...manifest.artifacts.files,
        scanId: scan.id,
        kind: "files",
      }),
      readVerifiedJsonText(bucket, {
        ...manifest.artifacts.diff,
        scanId: scan.id,
        kind: "diff",
      }),
    ]);

    const files = parseFilesArtifact(filesText, scan.id);
    const diff = parseDiffArtifact(diffText, scan.id);
    if (!files || !diff) {
      emitArtifactFallback("artifact_payload_invalid", scan);
      return null;
    }
    return { files, diff };
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

async function putVerifiedJson(
  bucket: R2Bucket,
  key: string,
  body: string,
  digest: string,
  customMetadata: Record<string, string>,
): Promise<ScanArtifactDescriptor> {
  const size = utf8Size(body);
  await bucket.put(key, body, {
    httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE },
    customMetadata: {
      ...customMetadata,
      digest,
      storageVersion: String(SCAN_ARTIFACT_STORAGE_VERSION),
    },
  });
  await readVerifiedJsonText(bucket, {
    key,
    digest,
    size,
    scanId: customMetadata.scanId,
    kind: customMetadata.artifactKind,
  });
  return { key, digest, size, contentType: ARTIFACT_CONTENT_TYPE };
}

async function readVerifiedJsonText(
  bucket: R2Bucket,
  descriptor: {
    key: string;
    digest: string;
    size: number;
    scanId: string;
    kind: string;
  },
): Promise<string> {
  const object = await bucket.get(descriptor.key);
  if (!object) {
    throw new Error(`missing ${descriptor.kind} artifact`);
  }
  const bytes = await object.arrayBuffer();
  const actualSize = bytes.byteLength;
  if (actualSize !== descriptor.size) {
    throw new Error(
      `${descriptor.kind} artifact size mismatch: expected ${descriptor.size}, got ${actualSize}`,
    );
  }
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== descriptor.digest) {
    throw new Error(`${descriptor.kind} artifact digest mismatch`);
  }
  return new TextDecoder().decode(bytes);
}

function artifactKeys(organizationId: string, scanId: string) {
  const base = `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/v${SCAN_ARTIFACT_STORAGE_VERSION}`;
  return {
    report: `${base}/report.json`,
    files: `${base}/files.json`,
    diff: `${base}/diff.json`,
    manifest: `${base}/manifest.json`,
  };
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function parseManifest(text: string): ScanArtifactsManifest | null {
  const parsed = parseJsonObject(text);
  const artifacts = parsed?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  const manifest = parsed as Partial<ScanArtifactsManifest>;
  if (
    typeof manifest.version !== "number" ||
    typeof manifest.scanId !== "string" ||
    typeof manifest.organizationId !== "string" ||
    typeof manifest.generatedAt !== "string"
  ) {
    return null;
  }
  const report = parseDescriptor((artifacts as Record<string, unknown>).report);
  const files = parseDescriptor((artifacts as Record<string, unknown>).files);
  const diff = parseDescriptor((artifacts as Record<string, unknown>).diff);
  if (!report || !files || !diff) return null;
  return {
    version: manifest.version,
    scanId: manifest.scanId,
    organizationId: manifest.organizationId,
    generatedAt: manifest.generatedAt,
    artifacts: { report, files, diff },
  };
}

function parseDescriptor(value: unknown): ScanArtifactDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<ScanArtifactDescriptor>;
  if (
    typeof item.key !== "string" ||
    typeof item.digest !== "string" ||
    typeof item.size !== "number" ||
    typeof item.contentType !== "string"
  ) {
    return null;
  }
  return {
    key: item.key,
    digest: item.digest,
    size: item.size,
    contentType: item.contentType,
    ...(typeof item.count === "number" ? { count: item.count } : {}),
  };
}

function parseFilesArtifact(text: string, scanId: string): ScanArtifactFileRow[] | null {
  const parsed = parseJsonObject(text);
  if (parsed?.version !== SCAN_ARTIFACT_STORAGE_VERSION || parsed.scanId !== scanId) return null;
  if (!Array.isArray(parsed.files)) return null;
  const files: ScanArtifactFileRow[] = [];
  for (const file of parsed.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return null;
    const item = file as Partial<ScanArtifactFileRow>;
    if (typeof item.path !== "string" || typeof item.status !== "string") return null;
    files.push({
      path: item.path,
      status: item.status,
      size: typeof item.size === "number" ? item.size : null,
      sha256: typeof item.sha256 === "string" ? item.sha256 : null,
      flagsJson: Array.isArray(item.flagsJson) ? item.flagsJson : [],
      textSample: typeof item.textSample === "string" ? item.textSample : null,
    });
  }
  return files;
}

function parseDiffArtifact(text: string, scanId: string): DiffEntry[] | null {
  const parsed = parseJsonObject(text);
  if (parsed?.version !== SCAN_ARTIFACT_STORAGE_VERSION || parsed.scanId !== scanId) return null;
  if (!Array.isArray(parsed.diff)) return null;
  const diff: DiffEntry[] = [];
  for (const entry of parsed.diff) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Partial<DiffEntry>;
    if (typeof item.path !== "string" || typeof item.status !== "string") return null;
    if (
      item.status !== "added" &&
      item.status !== "removed" &&
      item.status !== "modified" &&
      item.status !== "unchanged"
    ) {
      return null;
    }
    diff.push({
      path: item.path,
      status: item.status,
      ...(typeof item.previousSize === "number" ? { previousSize: item.previousSize } : {}),
      ...(typeof item.stagedSize === "number" ? { stagedSize: item.stagedSize } : {}),
      ...(typeof item.previousSha256 === "string" ? { previousSha256: item.previousSha256 } : {}),
      ...(typeof item.stagedSha256 === "string" ? { stagedSha256: item.stagedSha256 } : {}),
      flags: Array.isArray(item.flags)
        ? item.flags.filter((flag): flag is string => typeof flag === "string")
        : [],
    });
  }
  return diff;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emitArtifactFallback(
  reason: string,
  scan: Pick<ScanArtifactScanRow, "id" | "organizationId">,
  extra: Record<string, unknown> = {},
) {
  emitOperationalEvent("warn", "scan.artifacts.fallback_read", {
    scanId: scan.id,
    organizationId: scan.organizationId,
    reason,
    ...extra,
  });
}
