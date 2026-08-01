import {
  normalizeFindingDiffStatus,
  redactFindings,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
} from "../review";
import { parsePersistedAiReview } from "../ai-review/contract";
import { displayedAiResult, type AiReview } from "../ai-review/types";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { SCAN_FILE_SAMPLE_LIMIT } from "../sample-retention";
import { sha256Hex, stableJson, utf8Size } from "../platform/stable-json";

const SCAN_ARTIFACT_STORAGE_VERSION = 1;
export const SCAN_ARTIFACT_WRITE_ATTEMPTS = 3;
const ARTIFACT_CONTENT_TYPE = "application/json; charset=utf-8";

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
  /**
   * The persisted `ai_json`, when the caller has it. D1 is authoritative for the
   * advisory review: a deferred review is patched into this column and into a
   * republished report, and if that republish ever failed the column is the one
   * that is right. Absent falls back to the report's own `aiFindings` envelope.
   */
  aiJson?: unknown;
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

  // The three payloads are independent objects under the same scan prefix, and
  // each put is a network round trip followed by a verifying read. Awaiting them
  // in sequence tripled the wall-clock cost of the persistence phase for no
  // ordering benefit: the manifest below is what makes the set readable, and it
  // is written only after all three resolve. A rejection still fails the whole
  // phase (`maybeWriteScanArtifacts` retries, then fails closed).
  const [reportDescriptor, filesDescriptor, diffDescriptor] = await Promise.all([
    putVerifiedJson(bucket, keys.report, input.reportJson, input.reportDigest, {
      scanId: input.scanId,
      artifactKind: "report",
    }),
    sha256Hex(filesJson).then((digest) =>
      putVerifiedJson(bucket, keys.files, filesJson, digest, {
        scanId: input.scanId,
        artifactKind: "files",
        count: String(files.length),
      }),
    ),
    sha256Hex(diffJson).then((digest) =>
      putVerifiedJson(bucket, keys.diff, diffJson, digest, {
        scanId: input.scanId,
        artifactKind: "diff",
        count: String(input.diff.length),
      }),
    ),
  ]);
  const descriptors = {
    report: reportDescriptor,
    files: filesDescriptor,
    diff: diffDescriptor,
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

/** Bump when the deferred-review evidence envelope changes shape. */
export const AI_REVIEW_INPUT_VERSION = 1;

/**
 * Evidence snapshot for a deferred AI review, plus everything the follow-up
 * needs to re-score the scan without re-downloading or re-parsing anything.
 *
 * This is post-sandbox, post-redaction data — byte-for-byte the same records the
 * inline reviewer would have been handed, and the same trust level as
 * `files.json`. It is deliberately *not* raw package bytes and carries nothing
 * credential-derived. It is deleted as soon as the review reaches a terminal
 * state.
 */
export interface AiReviewInputPayload {
  version: number;
  scanId: string;
  stageId: string;
  ecosystem: string;
  codePatternSet?: string;
  previousVersionAvailable: boolean;
  baselineComparisonSkipped: boolean;
  files: FileRecord[];
  previousFiles: FileRecord[];
  diff: DiffEntry[];
  packageJsonDiff: PackageJsonDiff;
  releaseRuleFindings: Finding[];
  /** Deterministic findings with their persisted diff annotations, for re-scoring. */
  annotatedFindings: Array<Finding & FindingDiffAnnotation>;
  releaseConsistency: unknown;
}

export interface AiReviewInputDescriptor {
  key: string;
  digest: string;
  size: number;
}

export async function writeAiReviewInput(
  bucket: R2Bucket,
  organizationId: string,
  payload: AiReviewInputPayload,
): Promise<AiReviewInputDescriptor> {
  const key = artifactKeys(organizationId, payload.scanId).aiInput;
  const body = stableJson(payload);
  const digest = await sha256Hex(body);
  const descriptor = await putVerifiedJson(bucket, key, body, digest, {
    scanId: payload.scanId,
    artifactKind: "ai-input",
  });
  return { key: descriptor.key, digest: descriptor.digest, size: descriptor.size };
}

export async function loadAiReviewInput(
  bucket: R2Bucket,
  scanId: string,
  descriptor: AiReviewInputDescriptor,
): Promise<AiReviewInputPayload | null> {
  const text = await readVerifiedJsonText(bucket, {
    ...descriptor,
    scanId,
    kind: "ai-input",
  });
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  if (parsed.version !== AI_REVIEW_INPUT_VERSION || parsed.scanId !== scanId) return null;
  if (
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.previousFiles) ||
    !Array.isArray(parsed.diff) ||
    !Array.isArray(parsed.releaseRuleFindings) ||
    !Array.isArray(parsed.annotatedFindings)
  ) {
    return null;
  }
  return parsed as unknown as AiReviewInputPayload;
}

export async function deleteAiReviewInput(
  bucket: R2Bucket | undefined,
  organizationId: string,
  scanId: string,
): Promise<void> {
  if (!bucket) return;
  try {
    await bucket.delete(artifactKeys(organizationId, scanId).aiInput);
  } catch (err) {
    // A leaked evidence object is recoverable by the per-scan prefix sweep; it
    // must never turn a finished review into a failed queue message.
    emitOperationalEvent("warn", "scan.artifacts.ai_input_delete_failed", {
      scanId,
      organizationId,
      error: describeOperationalError(err),
    });
  }
}

export interface RewrittenReportArtifacts {
  reportDigest: string;
  reportArtifactKey: string;
  artifactManifestKey: string;
  artifactManifestDigest: string;
  artifactManifestSize: number;
}

/**
 * Republish `report.json` + `manifest.json` for a scan whose deferred AI review
 * just landed, under **content-addressed keys** rather than in place.
 *
 * In-place rewriting has a window where R2 holds bytes whose digest is not the
 * one D1 recorded, and the read path (correctly) refuses that pair — a
 * compacted, artifact-backed scan would serve metadata only until D1 caught up.
 * Writing new keys keeps the old pair valid and intact until
 * `applyAiReviewPatch` flips every reference in one statement, so a reader sees
 * either the pre-AI report or the patched one and never a mismatch.
 *
 * Note what content addressing does and does not give you here. Two concurrent
 * follow-ups that produce *different* reviews write different keys and cannot
 * corrupt each other. Two that produce *identical* bytes — the killswitch-off
 * sentinel, the fail-safe result, an AI Gateway cache hit — write the same
 * keys, which is also safe (the bytes are equal) but means the losing delivery
 * must not treat those objects as its own garbage to collect.
 *
 * `mutate` receives the parsed canonical report payload and returns the patched
 * one; the caller is responsible for keeping it canonical (stable ordering is
 * re-applied here through `stableJson`).
 */
export async function rewriteReportWithAiReview(
  bucket: R2Bucket,
  scan: ScanArtifactScanRow,
  mutate: (report: Record<string, unknown>) => Record<string, unknown>,
): Promise<RewrittenReportArtifacts | null> {
  if (!hasArtifactMetadata(scan)) return null;
  const manifestDetail = await loadScanArtifactsManifest(bucket, scan);
  if (!manifestDetail) return null;
  const { manifest } = manifestDetail;
  if (manifest.artifacts.report.digest !== scan.reportDigest) {
    emitArtifactFallback("report_digest_mismatch", scan, {
      expectedDigest: scan.reportDigest,
      actualDigest: manifest.artifacts.report.digest,
    });
    return null;
  }

  const reportText = await readVerifiedJsonText(bucket, {
    ...manifest.artifacts.report,
    scanId: scan.id,
    kind: "report",
  });
  const current = parseJsonObject(reportText);
  if (!current) return null;

  const nextJson = stableJson(mutate(current));
  const nextDigest = await sha256Hex(nextJson);
  const base = artifactKeys(manifest.organizationId, scan.id);
  const reportKey = base.revisedReport(nextDigest);
  const reportDescriptor = await putVerifiedJson(bucket, reportKey, nextJson, nextDigest, {
    scanId: scan.id,
    artifactKind: "report",
  });

  const nextManifest: ScanArtifactsManifest = {
    ...manifest,
    artifacts: { ...manifest.artifacts, report: reportDescriptor },
  };
  const manifestJson = stableJson(nextManifest);
  const manifestDigest = await sha256Hex(manifestJson);
  const manifestDescriptor = await putVerifiedJson(
    bucket,
    base.revisedManifest(nextDigest),
    manifestJson,
    manifestDigest,
    { scanId: scan.id, artifactKind: "manifest" },
  );

  return {
    reportDigest: nextDigest,
    reportArtifactKey: reportDescriptor.key,
    artifactManifestKey: manifestDescriptor.key,
    artifactManifestDigest: manifestDescriptor.digest,
    artifactManifestSize: manifestDescriptor.size,
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

    const reportFindings = parseReportFindings(reportText, scan.id, scan.aiJson);
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
    const detail = parseReportArtifactMetadata(reportText, scan.id, scan.aiJson);
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
    // Deferred-review evidence. Same prefix so the existing per-scan and
    // per-organization delete sweeps reclaim it without knowing about it.
    aiInput: `${base}/ai-input.json`,
    // Content-addressed republications, written when a deferred AI review is
    // patched in. The digest is in the key so a rewrite never overwrites bytes
    // D1 still points at, and so a duplicated follow-up is idempotent.
    revisedReport: (digest: string) => `${base}/report.${digest.slice(0, 16)}.json`,
    revisedManifest: (digest: string) => `${base}/manifest.${digest.slice(0, 16)}.json`,
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

function parseReportArtifactMetadata(
  text: string,
  scanId: string,
  aiReviewOverride?: unknown,
): ScanArtifactsDetail | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const reportFindings = parseReportFindingsObject(parsed, scanId, aiReviewOverride);
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
  aiReviewOverride?: unknown,
): { findings: ScanArtifactFindingRow[]; annotations: Map<string, FindingDiffAnnotation> } | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return parseReportFindingsObject(parsed, scanId, aiReviewOverride);
}

function parseReportFindingsObject(
  parsed: Record<string, unknown>,
  scanId: string,
  aiReviewOverride?: unknown,
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
  // findingAnnotations over. Derived from the review envelope rather than
  // duplicated JSON, so pre-existing reports (whose annotations only cover rule
  // indices) gain their AI rows on read as well; those rows fall back to
  // read-time diff annotation. A malformed or incomplete review parses to
  // null/unavailable and contributes nothing.
  //
  // `aiReviewOverride` is the caller's `scans.ai_json`. It takes precedence
  // because a deferred review is patched into D1 and into a republished report,
  // and only D1's write is the atomic one: if the republish failed, the column
  // still has the review and the reader should still see its findings.
  for (const finding of aiFindingRowsFromReport(aiReviewOverride ?? parsed.aiFindings)) {
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
