import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  annotateFindingsWithDiffStatus,
  type CodePatternSet,
  computeRisk,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  normalizeFindingDiffStatus,
  normalizeRisk,
  type PackageJsonSummary,
} from "../lib/review";
import { emitOperationalEvent } from "../lib/observability";
import { normalizeScanRiskBreakdown, type ScanRiskBreakdown } from "../lib/risk";
import { readScanArtifact, ScanArtifactError, scanArtifactSampleMap } from "../lib/scan-artifacts";
import type { AppDb } from "./client";
import { recordScanEvent, redactScanEventForClient } from "./events";
import { scanEvents, scanFiles, scanFindings, scans } from "./schema";

export interface PersistedScanInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
  packageJson?: PackageJsonSummary | null;
  previousPackageJson?: PackageJsonSummary | null;
  risk: string;
  status: string;
  summary: unknown;
  ai: unknown;
  files: FileRecord[];
  previousFiles?: FileRecord[];
  diff: DiffEntry[];
  findings: Finding[];
  codePatternSet?: CodePatternSet;
  riskSummary?: ScanRiskBreakdown;
  report?: { version: number; digest: string };
}

export interface ScanRiskSummary {
  artifactRisk: string;
  releaseRisk: string;
  contextRisk: string;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
}

export interface CreateScanJobInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
  source?: ScanSource;
}

export const SCAN_SOURCES = ["manual", "auto_discovery", "workflow_gate"] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export async function createScanJob(db: AppDb, input: CreateScanJobInput) {
  const now = new Date();
  await db.insert(scans).values({
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    risk: "unknown",
    status: "pending",
    source: input.source ?? "manual",
    createdAt: now,
    updatedAt: now,
  });
  return getScan(db, input.id, input.organizationId);
}

export async function deletePendingScanJob(db: AppDb, scanId: string, organizationId: string) {
  await db
    .delete(scans)
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        eq(scans.status, "pending"),
      ),
    );
}

export async function listExistingScanStageIds(
  db: AppDb,
  organizationId: string,
  stageIds: string[],
) {
  if (!stageIds.length) return new Set<string>();
  const rows = await db
    .select({ stageId: scans.stageId })
    .from(scans)
    .where(
      and(
        inArray(scans.stageId, stageIds),
        or(eq(scans.organizationId, organizationId), eq(scans.status, "complete")),
      ),
    );
  return new Set(rows.map((row) => row.stageId));
}

const NON_TERMINAL_STATUSES = ["pending", "running"] as const;

export async function claimScanForRun(db: AppDb, scanId: string, organizationId: string) {
  const now = new Date();
  const claimed = await db
    .update(scans)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        inArray(scans.status, [...NON_TERMINAL_STATUSES]),
      ),
    )
    .returning({ id: scans.id, status: scans.status });
  return claimed.length > 0;
}

export async function markScanFailed(
  db: AppDb,
  scanId: string,
  organizationId: string,
  error: { message: string; code?: string; detail?: string },
) {
  await db
    .update(scans)
    .set({
      status: "failed",
      risk: "unknown",
      errorJson: error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        inArray(scans.status, [...NON_TERMINAL_STATUSES]),
      ),
    );
}

export async function discardScanAttempt(db: AppDb, scanId: string, organizationId: string) {
  await db.delete(scans).where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)));
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  const diffByPath = new Map(input.diff.map((entry) => [entry.path, entry]));
  const fileRows = input.files.map((file) => {
    const entry = diffByPath.get(file.path);
    return {
      id: crypto.randomUUID(),
      scanId: input.id,
      path: file.path,
      status: entry?.status || "unknown",
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flags,
      textSample: file.textSample || null,
    };
  });
  const findingRows = input.findings.map((finding) => ({
    id: crypto.randomUUID(),
    scanId: input.id,
    severity: finding.severity,
    file: finding.file,
    evidence: finding.evidence,
    reason: finding.reason,
    line: finding.line ?? null,
    source: "rule",
    ruleId: finding.ruleId ?? null,
    ruleVersion: finding.ruleVersion ?? null,
  }));
  const annotatedFindings = annotateFindingsWithDiffStatus(findingRows, input.diff, {
    previousFiles: input.previousFiles ?? [],
    stagedFiles: input.files,
    codePatternSet: input.codePatternSet,
  });
  const findingAnnotations = annotatedFindings.map((finding) => ({
    id: finding.id,
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));

  const isComplete = input.status === "complete";
  const changedFileCount = isComplete ? countChangedFileEntries(input.diff) : null;
  const findingCount = isComplete ? findingRows.length : null;
  const riskSummary: ScanRiskBreakdown | null = isComplete
    ? (input.riskSummary ??
      readPersistedListRiskSummary(input.summary) ??
      computeRiskSummary(input.risk, annotatedFindings))
    : null;

  const scanValues = {
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    packageName: input.packageJson?.name || null,
    stagedVersion: input.packageJson?.version || null,
    previousVersion: input.previousPackageJson?.version || null,
    risk: input.risk,
    status: input.status,
    summaryJson: withFindingAnnotations(input.summary, findingAnnotations),
    aiJson: input.ai,
    errorJson: null,
    changedFileCount,
    findingCount,
    riskSummaryJson: riskSummary,
    reportVersion: input.report?.version ?? null,
    reportDigest: input.report?.digest ?? null,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const updated = await db
    .update(scans)
    .set({
      packageName: scanValues.packageName,
      stagedVersion: scanValues.stagedVersion,
      previousVersion: scanValues.previousVersion,
      risk: scanValues.risk,
      status: scanValues.status,
      summaryJson: scanValues.summaryJson,
      aiJson: scanValues.aiJson,
      errorJson: scanValues.errorJson,
      changedFileCount: scanValues.changedFileCount,
      findingCount: scanValues.findingCount,
      riskSummaryJson: scanValues.riskSummaryJson,
      reportVersion: scanValues.reportVersion,
      reportDigest: scanValues.reportDigest,
      completedAt: scanValues.completedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.id),
        eq(scans.organizationId, input.organizationId),
        inArray(scans.status, [...NON_TERMINAL_STATUSES]),
      ),
    )
    .returning({ id: scans.id });

  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: scans.id, status: scans.status, reportDigest: scans.reportDigest })
      .from(scans)
      .where(and(eq(scans.id, input.id), eq(scans.organizationId, input.organizationId)))
      .limit(1);
    if (existing) return { persisted: false, reason: "already_terminal" as const };
    await db.insert(scans).values(scanValues).onConflictDoNothing({ target: scans.id });
  }

  await Promise.all([
    db.delete(scanFiles).where(eq(scanFiles.scanId, input.id)),
    db.delete(scanFindings).where(eq(scanFindings.scanId, input.id)),
  ]);

  // D1 caps bound parameters at 100 per query, so insert in chunks sized to
  // each row's column count. Without this, packages with more than ~12 files
  // silently drop their scan_files rows and the scan-detail view renders as
  // "No file content available." for every entry.
  await Promise.all([
    ...chunkForD1(fileRows, 8).map((chunk) => db.insert(scanFiles).values(chunk)),
    ...chunkForD1(findingRows, 10).map((chunk) => db.insert(scanFindings).values(chunk)),
  ]);

  return { persisted: true as const };
}

export interface MarkScanArtifactBackedInput {
  scanId: string;
  organizationId: string;
  storageVersion: number;
  key: string;
  digest: string;
  size: number;
}

export async function markScanArtifactBacked(db: AppDb, input: MarkScanArtifactBackedInput) {
  await db
    .update(scans)
    .set({
      artifactStorageVersion: input.storageVersion,
      artifactKey: input.key,
      artifactDigest: input.digest,
      artifactSize: input.size,
      updatedAt: new Date(),
    })
    .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)));
}

export interface ScanArtifactBackfillCandidate {
  id: string;
  organizationId: string;
  reportVersion: number | null;
  reportDigest: string | null;
  summaryJson: unknown;
  files: Array<{ path: string; textSample: string | null }>;
}

/**
 * Completed scans that have not yet been written to R2, oldest first. Backfill
 * is naturally idempotent: a successful write sets `artifact_storage_version`,
 * which removes the scan from this candidate set on the next sweep.
 */
export async function listScanArtifactBackfillCandidates(
  db: AppDb,
  limit: number,
): Promise<ScanArtifactBackfillCandidate[]> {
  const scanRows = await db
    .select({
      id: scans.id,
      organizationId: scans.organizationId,
      reportVersion: scans.reportVersion,
      reportDigest: scans.reportDigest,
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(
      and(
        eq(scans.status, "complete"),
        isNull(scans.artifactStorageVersion),
        isNotNull(scans.organizationId),
      ),
    )
    .orderBy(asc(scans.createdAt), asc(scans.id))
    .limit(Math.max(1, Math.floor(limit)));

  if (!scanRows.length) return [];

  const ids = scanRows.map((row) => row.id);
  const fileRows = await db
    .select({ scanId: scanFiles.scanId, path: scanFiles.path, textSample: scanFiles.textSample })
    .from(scanFiles)
    .where(inArray(scanFiles.scanId, ids));

  const filesByScan = new Map<string, Array<{ path: string; textSample: string | null }>>();
  for (const file of fileRows) {
    const list = filesByScan.get(file.scanId) ?? [];
    list.push({ path: file.path, textSample: file.textSample });
    filesByScan.set(file.scanId, list);
  }

  return scanRows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId as string,
    reportVersion: row.reportVersion,
    reportDigest: row.reportDigest,
    summaryJson: row.summaryJson,
    files: filesByScan.get(row.id) ?? [],
  }));
}

function withFindingAnnotations(
  summary: unknown,
  annotations: Array<{ id: string; diffStatus: string; releaseDelta: boolean }>,
): Record<string, unknown> {
  const base =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)
      : {};
  return { ...base, findingAnnotations: annotations };
}

const D1_MAX_BOUND_PARAMETERS = 100;

export function chunkForD1<T>(rows: T[], columnsPerRow: number): T[][] {
  if (!rows.length) return [];
  const chunkSize = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS / columnsPerRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}

export const SCAN_DECISIONS = ["publish", "no_publish"] as const;
export type ScanDecision = (typeof SCAN_DECISIONS)[number];

export const SCAN_DECISION_FILTERS = ["undecided", "publish", "no_publish", "all"] as const;
export type ScanDecisionFilter = (typeof SCAN_DECISION_FILTERS)[number];

export interface ListScansOptions {
  cursor?: { createdAtMs: number; id: string } | null;
  limit?: number;
  decisionFilter?: ScanDecisionFilter;
}

export interface ListScansResult {
  scans: Array<{
    id: string;
    stageId: string;
    organizationId: string | null;
    ownerUserId: string | null;
    packageName: string | null;
    stagedVersion: string | null;
    previousVersion: string | null;
    risk: string;
    status: string;
    decision: string | null;
    decisionReason: string | null;
    decidedByUserId: string | null;
    decidedAt: Date | null;
    changedFileCount: number;
    findingCount: number;
    riskSummary: ScanRiskSummary | null;
    reportVersion: number | null;
    reportDigest: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  nextCursor: { createdAtMs: number; id: string } | null;
}

export const LIST_SCANS_DEFAULT_LIMIT = 20;
export const LIST_SCANS_MAX_LIMIT = 100;

export async function listScans(
  db: AppDb,
  organizationId: string,
  options: ListScansOptions = {},
): Promise<ListScansResult> {
  const limit = Math.min(
    LIST_SCANS_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? LIST_SCANS_DEFAULT_LIMIT)),
  );
  const decisionFilter = options.decisionFilter ?? "undecided";

  const conditions = [eq(scans.organizationId, organizationId)];
  if (decisionFilter === "undecided") conditions.push(isNull(scans.decision));
  else if (decisionFilter === "publish") conditions.push(eq(scans.decision, "publish"));
  else if (decisionFilter === "no_publish") conditions.push(eq(scans.decision, "no_publish"));

  if (options.cursor) {
    const cursorDate = new Date(options.cursor.createdAtMs);
    conditions.push(
      or(
        lt(scans.createdAt, cursorDate),
        and(eq(scans.createdAt, cursorDate), lt(scans.id, options.cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: scans.id,
      stageId: scans.stageId,
      organizationId: scans.organizationId,
      ownerUserId: scans.ownerUserId,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      previousVersion: scans.previousVersion,
      risk: scans.risk,
      status: scans.status,
      decision: scans.decision,
      decisionReason: scans.decisionReason,
      decidedByUserId: scans.decidedByUserId,
      decidedAt: scans.decidedAt,
      changedFileCount: scans.changedFileCount,
      findingCount: scans.findingCount,
      riskSummaryJson: scans.riskSummaryJson,
      reportVersion: scans.reportVersion,
      reportDigest: scans.reportDigest,
      startedAt: scans.startedAt,
      completedAt: scans.completedAt,
      createdAt: scans.createdAt,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(and(...conditions))
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? { createdAtMs: new Date(last.createdAt).getTime(), id: last.id } : null;

  if (!page.length) return { scans: [], nextCursor };

  return {
    scans: page.map((row) => ({
      id: row.id,
      stageId: row.stageId,
      organizationId: row.organizationId,
      ownerUserId: row.ownerUserId,
      packageName: row.packageName,
      stagedVersion: row.stagedVersion,
      previousVersion: row.previousVersion,
      risk: row.risk,
      status: row.status,
      decision: row.decision,
      decisionReason: row.decisionReason,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      changedFileCount: row.changedFileCount ?? 0,
      findingCount: row.findingCount ?? 0,
      riskSummary: row.status === "complete" ? readScanRiskBreakdown(row.riskSummaryJson) : null,
      reportVersion: row.reportVersion,
      reportDigest: row.reportDigest,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    nextCursor,
  };
}

function readScanRiskBreakdown(value: unknown): ScanRiskSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof ScanRiskSummary, unknown>>;
  if (
    typeof item.artifactRisk !== "string" ||
    typeof item.releaseRisk !== "string" ||
    typeof item.contextRisk !== "string" ||
    typeof item.releaseFindingCount !== "number" ||
    typeof item.contextFindingCount !== "number" ||
    typeof item.unknownFindingCount !== "number"
  ) {
    return null;
  }
  return {
    artifactRisk: normalizeRisk(item.artifactRisk),
    releaseRisk: normalizeRisk(item.releaseRisk),
    contextRisk: normalizeRisk(item.contextRisk),
    releaseFindingCount: Math.max(0, Math.floor(item.releaseFindingCount)),
    contextFindingCount: Math.max(0, Math.floor(item.contextFindingCount)),
    unknownFindingCount: Math.max(0, Math.floor(item.unknownFindingCount)),
  };
}

const CHANGED_FILE_STATUSES = new Set(["added", "removed", "modified"]);

function countChangedFileEntries(diff: Array<{ status?: unknown }>): number {
  let count = 0;
  for (const entry of diff) {
    if (!entry || typeof entry !== "object") continue;
    const status = (entry as { status?: unknown }).status;
    if (typeof status === "string" && CHANGED_FILE_STATUSES.has(status)) count += 1;
  }
  return count;
}

/**
 * Single risk-summary deriver shared by the persist (list-view) and read
 * (detail-view) paths. `persistedBreakdown` lets the detail path prefer a
 * previously-persisted breakdown field-by-field; when omitted (the persist
 * path), every field is computed from `persistedRisk` + the findings.
 */
function computeRiskSummary(
  persistedRisk: string,
  findings: Array<{ severity?: string | null; releaseDelta: boolean; diffStatus: string }>,
  persistedBreakdown?: Partial<ScanRiskBreakdown> | null,
): ScanRiskBreakdown {
  const releaseFindings = findings.filter((finding) => finding.releaseDelta);
  const contextFindings = findings.filter((finding) => !finding.releaseDelta);
  const unknownFindingCount = contextFindings.filter(
    (finding) => finding.diffStatus === "unknown",
  ).length;
  return {
    artifactRisk: persistedBreakdown?.artifactRisk ?? normalizeRisk(persistedRisk),
    releaseRisk: persistedBreakdown?.releaseRisk ?? computeRisk(releaseFindings),
    contextRisk: persistedBreakdown?.contextRisk ?? computeRisk(contextFindings),
    releaseFindingCount: persistedBreakdown?.releaseFindingCount ?? releaseFindings.length,
    contextFindingCount: persistedBreakdown?.contextFindingCount ?? contextFindings.length,
    unknownFindingCount: persistedBreakdown?.unknownFindingCount ?? unknownFindingCount,
  };
}

function readPersistedListRiskSummary(summaryJson: unknown): ScanRiskBreakdown | null {
  const partial = readPersistedRiskBreakdown(summaryJson);
  if (
    !partial ||
    partial.artifactRisk === undefined ||
    partial.releaseRisk === undefined ||
    partial.contextRisk === undefined ||
    partial.releaseFindingCount === undefined ||
    partial.contextFindingCount === undefined ||
    partial.unknownFindingCount === undefined
  ) {
    return null;
  }
  return {
    artifactRisk: partial.artifactRisk,
    releaseRisk: partial.releaseRisk,
    contextRisk: partial.contextRisk,
    releaseFindingCount: partial.releaseFindingCount,
    contextFindingCount: partial.contextFindingCount,
    unknownFindingCount: partial.unknownFindingCount,
  };
}

export interface RecordScanDecisionInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
  decision: ScanDecision;
  reason?: string | null;
}

export async function recordScanDecision(
  db: AppDb,
  input: RecordScanDecisionInput,
  options: GetScanOptions = {},
) {
  const now = new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const updated = await db
    .update(scans)
    .set({
      decision: input.decision,
      decisionReason: reason,
      decidedByUserId: input.actorUserId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
      ),
    )
    .returning({ id: scans.id });

  if (updated.length === 0) return null;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.decided",
    metadata: { decision: input.decision, reason },
  });

  return getScan(db, input.scanId, input.organizationId, options);
}

export interface GetScanOptions {
  artifacts?: R2Bucket;
}

/**
 * Shadow-read: when a scan is artifact-backed and an R2 binding is available,
 * hydrate redacted file text samples from the verified bundle, preferring R2 and
 * falling back to the D1 rows on a missing object, digest mismatch, or any read
 * error. The fallback is what keeps reads correct before D1 compaction and what
 * makes "flip reads back to D1" the rollback path (drop the binding).
 */
async function hydrateScanFileSamples<T extends { path: string; textSample: string | null }>(
  scan: {
    id: string;
    organizationId: string | null;
    artifactStorageVersion: number | null;
    artifactKey: string | null;
    artifactDigest: string | null;
  },
  files: T[],
  bucket: R2Bucket | undefined,
): Promise<T[]> {
  if (!bucket || scan.artifactStorageVersion == null || !scan.artifactKey) return files;
  try {
    const bundle = await readScanArtifact(bucket, {
      key: scan.artifactKey,
      expectedDigest: scan.artifactDigest,
    });
    if (!bundle) {
      emitOperationalEvent("warn", "scan.artifact.read_fallback", {
        scanId: scan.id,
        organizationId: scan.organizationId,
        reason: "artifact_missing",
      });
      return files;
    }
    const sampleMap = scanArtifactSampleMap(bundle);
    return files.map((file) =>
      sampleMap.has(file.path) ? { ...file, textSample: sampleMap.get(file.path) ?? null } : file,
    );
  } catch (err) {
    emitOperationalEvent("warn", "scan.artifact.read_fallback", {
      scanId: scan.id,
      organizationId: scan.organizationId,
      reason: err instanceof ScanArtifactError ? err.code : "read_error",
    });
    return files;
  }
}

export async function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  options: GetScanOptions = {},
) {
  const [scanRows, fileRows, findings, events] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db.select().from(scanFiles).where(eq(scanFiles.scanId, id)),
    db.select().from(scanFindings).where(eq(scanFindings.scanId, id)),
    db
      .select()
      .from(scanEvents)
      .where(and(eq(scanEvents.scanId, id), eq(scanEvents.organizationId, organizationId)))
      .orderBy(asc(scanEvents.createdAt)),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;
  const files = await hydrateScanFileSamples(scan, fileRows, options.artifacts);
  const diff = diffForFindingAnnotations(scan.summaryJson, files);
  const annotatedFindings = annotateFindingsWithDiffStatus(findings, diff, {
    persistedAnnotations: readFindingAnnotations(scan.summaryJson),
  });
  return {
    scan,
    files,
    findings: annotatedFindings,
    riskSummary:
      scan.status === "complete"
        ? computeRiskSummary(
            scan.risk,
            annotatedFindings,
            readPersistedRiskBreakdown(scan.summaryJson),
          )
        : null,
    events: events.map(redactScanEventForClient),
  };
}

function readPersistedRiskBreakdown(summaryJson: unknown) {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const risk = summary && !Array.isArray(summary) ? (summary as { risk?: unknown }).risk : null;
  return normalizeScanRiskBreakdown(risk);
}

function readFindingAnnotations(summaryJson: unknown): Map<string, FindingDiffAnnotation> {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const annotations =
    summary && !Array.isArray(summary)
      ? (summary as { findingAnnotations?: unknown }).findingAnnotations
      : null;
  const out = new Map<string, FindingDiffAnnotation>();
  if (!Array.isArray(annotations)) return out;
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) continue;
    const id = (annotation as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const diffStatus = normalizeFindingDiffStatus(
      (annotation as { diffStatus?: unknown }).diffStatus,
    );
    out.set(id, {
      diffStatus,
      releaseDelta: Boolean((annotation as { releaseDelta?: unknown }).releaseDelta),
    });
  }
  return out;
}

function diffForFindingAnnotations(
  summaryJson: unknown,
  files: Array<{ path: string; status: string }>,
): Array<{ path: string; status: string }> {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const diff = summary && !Array.isArray(summary) ? (summary as { diff?: unknown }).diff : null;
  if (Array.isArray(diff)) {
    const entries = diff.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const path = (entry as { path?: unknown }).path;
      if (typeof path !== "string") return [];
      return [{ path, status: normalizeFindingDiffStatus((entry as { status?: unknown }).status) }];
    });
    if (entries.length) return entries;
  }
  return files.map((file) => ({
    path: file.path,
    status: normalizeFindingDiffStatus(file.status),
  }));
}
