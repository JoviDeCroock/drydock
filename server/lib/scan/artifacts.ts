import {
  normalizeFindingDiffStatus,
  redactFindings,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
} from "../review";
import { parsePersistedAiReview } from "../ai-review/contract";
import { displayedAiResult, type AiReview } from "../ai-review/types";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { sha256Hex, stableJson, utf8Size } from "../platform/stable-json";

const SCAN_ARTIFACT_STORAGE_VERSION = 1;
export const SCAN_ARTIFACT_WRITE_ATTEMPTS = 3;
const ARTIFACT_CONTENT_TYPE = "application/json; charset=utf-8";

// Per-file display sample bound. Deterministic detection runs over the WHOLE
// file in the parent worker (the sandbox no longer clips the scanned text; see
// issue #191), so this cap is purely about what we persist for the diff/file
// viewer — it never narrows the review window. A finding past this bound is
// surfaced in the UI's out-of-sample banner rather than pinned to a hunk.
export const SCAN_FILE_SAMPLE_LIMIT = 128 * 1024;

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
interface ScanArtifactFindingRow {
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

interface ScanArtifactsManifestDetail {
  manifest: ScanArtifactsManifest;
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
      if (finalAttempt) throw err;
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

export async function deleteOrganizationArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
): Promise<void> {
  if (!bucket) return;
  await deleteArtifactsByPrefix(bucket, organizationArtifactPrefix(organizationId), {
    organizationId,
    scope: "organization",
  });
}

export async function deleteScanArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
  scanId: string,
): Promise<void> {
  if (!bucket) return;
  await deleteArtifactsByPrefix(bucket, scanArtifactPrefix(organizationId, scanId), {
    organizationId,
    scanId,
    scope: "scan",
  });
}

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

async function readDigestVerifiedJsonText(
  bucket: R2Bucket,
  descriptor: {
    key: string;
    digest: string;
    scanId: string;
    kind: string;
  },
): Promise<string> {
  const object = await bucket.get(descriptor.key);
  if (!object) {
    throw new Error(`missing ${descriptor.kind} artifact`);
  }
  const bytes = await object.arrayBuffer();
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== descriptor.digest) {
    throw new Error(`${descriptor.kind} artifact digest mismatch`);
  }
  return new TextDecoder().decode(bytes);
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

// Deletion prefixes intentionally stop *before* the `v{N}` segment so a cleanup
// removes every storage version of the scan/org, not just the current one. They
// must match the `artifactKeys` layout exactly or a sweep would miss objects.
function organizationArtifactPrefix(organizationId: string): string {
  return `orgs/${safeSegment(organizationId)}/`;
}

function scanArtifactPrefix(organizationId: string, scanId: string): string {
  return `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/`;
}

// R2 caps list() and delete() at 1000 keys per call, so we page until the prefix
// is drained. Caller-supplied logFields identify the scope (org vs scan) for the
// emitted event.
const ARTIFACT_LIST_PAGE = 1000;

async function deleteArtifactsByPrefix(
  bucket: R2Bucket,
  prefix: string,
  logFields: Record<string, unknown>,
): Promise<void> {
  try {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix, limit: ARTIFACT_LIST_PAGE, cursor });
      const keys = listed.objects.map((object) => object.key);
      if (keys.length > 0) {
        await bucket.delete(keys);
        deleted += keys.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    if (deleted > 0) {
      emitOperationalEvent("info", "scan.artifacts.deleted", {
        ...logFields,
        objectsDeleted: deleted,
      });
    }
  } catch (err) {
    emitOperationalEvent("error", "scan.artifacts.delete_failed", {
      ...logFields,
      error: describeOperationalError(err),
    });
  }
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

function parseReportArtifactMetadata(text: string, scanId: string): ScanArtifactsDetail | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const reportFindings = parseReportFindingsObject(parsed, scanId);
  const diff = parseDiffEntries(parsed.diff);
  if (!diff || !reportFindings) return null;
  return {
    files: scanFileRowsForDiffMetadata(diff),
    diff,
    findings: reportFindings.findings,
    findingAnnotations: reportFindings.annotations,
  };
}

function scanFileRowsForDiffMetadata(diff: DiffEntry[]): ScanArtifactFileRow[] {
  return diff.flatMap((entry) => {
    if (entry.status === "removed") return [];
    return [
      {
        path: entry.path,
        status: entry.status,
        size: entry.stagedSize ?? null,
        sha256: entry.stagedSha256 ?? null,
        flagsJson: entry.flags,
        textSample: null,
      },
    ];
  });
}

function parseDiffArtifact(text: string, scanId: string): DiffEntry[] | null {
  const parsed = parseJsonObject(text);
  if (parsed?.version !== SCAN_ARTIFACT_STORAGE_VERSION || parsed.scanId !== scanId) return null;
  return parseDiffEntries(parsed.diff);
}

function parseDiffEntries(value: unknown): DiffEntry[] | null {
  if (!Array.isArray(value)) return null;
  const diff: DiffEntry[] = [];
  for (const entry of value) {
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

// Stable, content-free id for an R2-sourced finding. The detail read and the
// compare endpoint both key findings by id (React keys + annotation joins), so
// the same scan/index must always yield the same id without a persisted UUID.
function artifactFindingId(scanId: string, index: number): string {
  return `${scanId}:finding:${index}`;
}

// Rebuild the deterministic findings and their diff annotations from the
// digest-verified report.json. `ruleFindings` is the ordered finding list and
// `findingAnnotations` references each by `findingIndex`; we re-key both by the
// derived finding id so the annotation join matches the rows we hand back.
// Returns null only when the findings array is structurally invalid — an empty
// array (a clean scan) is valid and yields no findings.
function parseReportFindings(
  text: string,
  scanId: string,
): { findings: ScanArtifactFindingRow[]; annotations: Map<string, FindingDiffAnnotation> } | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return parseReportFindingsObject(parsed, scanId);
}

function parseReportFindingsObject(
  parsed: Record<string, unknown>,
  scanId: string,
): { findings: ScanArtifactFindingRow[]; annotations: Map<string, FindingDiffAnnotation> } | null {
  const rawFindings = parsed?.ruleFindings;
  if (!Array.isArray(rawFindings)) return null;

  const findings: ScanArtifactFindingRow[] = [];
  for (let index = 0; index < rawFindings.length; index += 1) {
    const entry = rawFindings[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Partial<Finding>;
    if (
      typeof item.severity !== "string" ||
      typeof item.file !== "string" ||
      typeof item.evidence !== "string" ||
      typeof item.reason !== "string"
    ) {
      return null;
    }
    findings.push({
      id: artifactFindingId(scanId, index),
      scanId,
      severity: item.severity,
      file: item.file,
      evidence: item.evidence,
      reason: item.reason,
      line: typeof item.line === "number" ? item.line : null,
      source: "rule",
      ruleId: typeof item.ruleId === "string" ? item.ruleId : null,
      ruleVersion: typeof item.ruleVersion === "string" ? item.ruleVersion : null,
    });
  }

  // A completed AI review's findings are rows too, appended after the rule
  // findings — the same combined order persistResults indexes its
  // findingAnnotations over. Derived from the report's aiFindings envelope
  // rather than duplicated JSON, so pre-existing reports (whose annotations
  // only cover rule indices) gain their AI rows on read as well; those rows
  // fall back to read-time diff annotation. A malformed or incomplete review
  // parses to null/unavailable and contributes nothing.
  for (const finding of aiFindingRowsFromReport(parsed.aiFindings)) {
    findings.push({
      id: artifactFindingId(scanId, findings.length),
      scanId,
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
      line: null,
      source: "ai",
      ruleId: null,
      ruleVersion: null,
    });
  }

  const annotations = new Map<string, FindingDiffAnnotation>();
  const rawAnnotations = parsed?.findingAnnotations;
  if (Array.isArray(rawAnnotations)) {
    for (const entry of rawAnnotations) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const index = (entry as { findingIndex?: unknown }).findingIndex;
      if (typeof index !== "number" || !Number.isInteger(index)) continue;
      if (index < 0 || index >= findings.length) continue;
      annotations.set(artifactFindingId(scanId, index), {
        diffStatus: normalizeFindingDiffStatus((entry as { diffStatus?: unknown }).diffStatus),
        releaseDelta: Boolean((entry as { releaseDelta?: unknown }).releaseDelta),
      });
    }
  }

  return { findings, annotations };
}

// Project a completed AI review's findings into the deterministic Finding
// shape, re-redacting as a belt-and-braces invariant (nothing persisted or
// re-derived from the AI path may carry secret material). Shared by the write
// path (mergeAiFindings persists these as `source: "ai"` rows) and the R2 read
// path (aiFindingRowsFromReport re-derives them) so both stores hand back
// byte-identical rows for the same review. An incomplete/invalid/disabled
// review contributes nothing.
export function projectAiReviewFindings(review: AiReview | null | undefined): Finding[] {
  const displayed = displayedAiResult(review ?? null);
  if (displayed?.kind !== "complete" || displayed.findings.length === 0) return [];
  return redactFindings(
    displayed.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
    })),
  );
}

function aiFindingRowsFromReport(value: unknown): Finding[] {
  return projectAiReviewFindings(parsePersistedAiReview(value));
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
