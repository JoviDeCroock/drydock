import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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
import { normalizeScanRiskBreakdown, type ScanRiskBreakdown } from "../lib/risk";
import {
  deleteScanArtifacts,
  loadScanArtifactFile,
  loadScanArtifactMetadata,
  loadScanArtifacts,
  scanFileRowsForArtifacts,
  type ScanArtifactFileRow,
  type ScanArtifactMetadata,
} from "../lib/scan-artifacts";
import type { AppDb } from "./client";
import { recordScanEvent, redactScanEventForClient } from "./events";
import { githubWorkflowGates, scanEvents, scanFiles, scanFindings, scans } from "./schema";

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
  /**
   * Findings a completed AI review contributed, already projected into the
   * deterministic Finding shape (see mergeAiFindings). Persisted as
   * `scan_findings` rows with source "ai" so they count into `finding_count`
   * and the risk summary; the full review stays in `ai_json`.
   */
  aiFindingRecords?: Finding[];
  codePatternSet?: CodePatternSet;
  riskSummary?: ScanRiskBreakdown;
  report?: { version: number; digest: string };
  artifacts?: ScanArtifactMetadata | null;
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
  /** Links a workflow-gate review scan back to its gate. */
  gateId?: string | null;
  /**
   * Package identity known before the tarball is inspected (from the staged
   * publishes listing or the gate bundle). Lets failed scans — including ones
   * whose tarball never parsed — still carry a display label; the pipeline
   * overwrites both with tarball-derived values when it completes.
   */
  packageName?: string | null;
  stagedVersion?: string | null;
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
    gateId: input.gateId ?? null,
    packageName: input.packageName ?? null,
    stagedVersion: input.stagedVersion ?? null,
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

export type DeleteFailedScanResult =
  | { outcome: "deleted"; source: string }
  | { outcome: "not_found" }
  | { outcome: "not_failed" };

/**
 * Delete one user-visible failed scan. The status predicate belongs on the
 * mutation itself so a stale client can never delete a scan that is still
 * running or has since completed.
 */
export async function deleteFailedScan(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<DeleteFailedScanResult> {
  const deleted = await db
    .delete(scans)
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        eq(scans.status, "failed"),
      ),
    )
    .returning({ source: scans.source });
  if (deleted[0]) return { outcome: "deleted", source: deleted[0].source };

  const [existing] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  return existing ? { outcome: "not_failed" } : { outcome: "not_found" };
}

export async function listExistingScanStageIds(
  db: AppDb,
  organizationId: string,
  stageIds: string[],
) {
  if (!stageIds.length) return new Set<string>();
  // Discovery passes every staged publish it saw, which is unbounded; each id
  // is one bound parameter, so chunk below D1's cap (reserving a slot for the
  // organizationId parameter) or the sweep throws "too many SQL variables"
  // once an org stages ~100 items.
  const known = new Set<string>();
  for (const chunk of chunkForD1([...new Set(stageIds)], 1, 1)) {
    const rows = await db
      .select({ stageId: scans.stageId })
      .from(scans)
      .where(and(inArray(scans.stageId, chunk), eq(scans.organizationId, organizationId)));
    for (const row of rows) known.add(row.stageId);
  }
  return known;
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

/**
 * Remove every scan attached to a gate. Used to discard a partially-completed
 * review batch before it is re-run, so a retry does not leave orphaned
 * per-package scans behind (cascades to scan_files / scan_findings). Safe only
 * once the caller holds the gate's review claim and no representative scan is
 * attached. A prior attempt may have completed some packages and written their
 * R2 artifacts, so pass the ARTIFACTS bucket to tear those down too — the scan
 * ids are read before the D1 delete so the per-scan artifact prefixes are known.
 */
export async function discardGateScans(
  db: AppDb,
  gateId: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
) {
  const condition = and(eq(scans.gateId, gateId), eq(scans.organizationId, organizationId));
  const discarded = artifactBucket
    ? await db.select({ id: scans.id }).from(scans).where(condition)
    : [];
  await db.delete(scans).where(condition);
  await Promise.all(
    discarded.map(({ id }) => deleteScanArtifacts(artifactBucket, organizationId, id)),
  );
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  const artifactFileRows = scanFileRowsForArtifacts(input.files, input.diff);
  const fileRows = artifactFileRows.map((file) => {
    return {
      id: crypto.randomUUID(),
      scanId: input.id,
      path: file.path,
      status: file.status,
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flagsJson,
      textSample: file.textSample,
    };
  });
  // Rule rows first, AI rows after them — the same order the report artifact's
  // findingAnnotations index over, so both stores agree on finding identity.
  const findingRows = [
    ...input.findings.map((finding) => ({ finding, source: "rule" })),
    ...(input.aiFindingRecords ?? []).map((finding) => ({ finding, source: "ai" })),
  ].map(({ finding, source }) => ({
    id: crypto.randomUUID(),
    scanId: input.id,
    severity: finding.severity,
    file: finding.file,
    evidence: finding.evidence,
    reason: finding.reason,
    line: finding.line ?? null,
    source,
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
    artifactStorageVersion: input.artifacts?.artifactStorageVersion ?? null,
    artifactManifestKey: input.artifacts?.artifactManifestKey ?? null,
    artifactManifestDigest: input.artifacts?.artifactManifestDigest ?? null,
    artifactManifestSize: input.artifacts?.artifactManifestSize ?? null,
    reportArtifactKey: input.artifacts?.reportArtifactKey ?? null,
    fileSamplesArtifactKey: input.artifacts?.fileSamplesArtifactKey ?? null,
    diffArtifactKey: input.artifacts?.diffArtifactKey ?? null,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const claimToken = `persist:${crypto.randomUUID()}`;
  const existing = await db
    .select({ id: scans.id, status: scans.status, reportDigest: scans.reportDigest })
    .from(scans)
    .where(and(eq(scans.id, input.id), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  if (existing[0] && !NON_TERMINAL_STATUSES.some((status) => status === existing[0]?.status)) {
    return { persisted: false, reason: "already_terminal" as const };
  }

  // D1 rejects SQL BEGIN/SAVEPOINT in Workers, so use a batch: D1 applies the
  // statements atomically. The temporary reportDigest token gates every child
  // mutation and is cleared by the final statement before the batch commits.
  const claimScan = existing[0]
    ? db
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
          artifactStorageVersion: scanValues.artifactStorageVersion,
          artifactManifestKey: scanValues.artifactManifestKey,
          artifactManifestDigest: scanValues.artifactManifestDigest,
          artifactManifestSize: scanValues.artifactManifestSize,
          reportArtifactKey: scanValues.reportArtifactKey,
          fileSamplesArtifactKey: scanValues.fileSamplesArtifactKey,
          diffArtifactKey: scanValues.diffArtifactKey,
          completedAt: scanValues.completedAt,
          reportDigest: claimToken,
          updatedAt: now,
        })
        .where(
          and(
            eq(scans.id, input.id),
            eq(scans.organizationId, input.organizationId),
            inArray(scans.status, [...NON_TERMINAL_STATUSES]),
          ),
        )
        .returning({ id: scans.id })
    : db
        .insert(scans)
        .values({ ...scanValues, reportDigest: claimToken })
        .onConflictDoNothing({ target: scans.id })
        .returning({ id: scans.id });

  const claimExists = scanPersistClaimExists(input.id, input.organizationId, claimToken);
  const batch: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    claimScan,
    // Always clear prior detail rows first so a retry — including one that flips a
    // scan from D1-backed to R2-backed — never leaves stale rows behind.
    db.delete(scanFiles).where(and(eq(scanFiles.scanId, input.id), claimExists)),
    db.delete(scanFindings).where(and(eq(scanFindings.scanId, input.id), claimExists)),
  ];

  // When the scan is R2-artifact-backed, its redacted file samples, file
  // metadata, diff, and findings already live in R2 (files.json / diff.json /
  // report.json) and are read back from there, so persisting the same rows into
  // D1 would be a pure duplicate. Only the degraded path — the R2 write was
  // skipped (no bucket) and `artifacts` is null — falls back to storing the
  // detail in D1 so the scan stays readable.
  if (!input.artifacts) {
    // D1 caps bound parameters at 100 per query, so insert in chunks sized to
    // each row's columns plus the claim guard. Without this, packages with more
    // than ~12 files silently drop their scan_files rows and the scan-detail view
    // renders as "No file content available." for every entry.
    for (const chunk of chunkForD1(fileRows, 11)) {
      batch.push(insertScanFilesWhenClaimed(db, chunk, input.organizationId, claimToken));
    }
    for (const chunk of chunkForD1(findingRows, 13)) {
      batch.push(insertScanFindingsWhenClaimed(db, chunk, input.organizationId, claimToken));
    }
  }

  batch.push(
    db
      .update(scans)
      .set({ reportDigest: scanValues.reportDigest, updatedAt: now })
      .where(
        and(
          eq(scans.id, input.id),
          eq(scans.organizationId, input.organizationId),
          eq(scans.reportDigest, claimToken),
        ),
      ),
  );

  const [claimed] = await db.batch(batch);
  if (Array.isArray(claimed) && claimed.length === 0) {
    return { persisted: false, reason: "already_terminal" as const };
  }
  return { persisted: true as const };
}

type ScanFileInsertRow = typeof scanFiles.$inferInsert;
type ScanFindingInsertRow = typeof scanFindings.$inferInsert;

function scanPersistClaimExists(scanId: string, organizationId: string, claimToken: string) {
  return sql`exists (
    select 1
    from ${scans}
    where ${scans.id} = ${scanId}
      and ${scans.organizationId} = ${organizationId}
      and ${scans.reportDigest} = ${claimToken}
  )`;
}

function insertScanFilesWhenClaimed(
  db: AppDb,
  rows: ScanFileInsertRow[],
  organizationId: string,
  claimToken: string,
) {
  return db.insert(scanFiles).select(
    sql.join(
      rows.map(
        (row) => sql`
          select
            ${row.id},
            ${row.scanId},
            ${row.path},
            ${row.status},
            ${row.size},
            ${row.sha256},
            ${JSON.stringify(row.flagsJson)},
            ${row.textSample}
          where ${scanPersistClaimExists(row.scanId, organizationId, claimToken)}
        `,
      ),
      sql.raw(" union all "),
    ),
  );
}

function insertScanFindingsWhenClaimed(
  db: AppDb,
  rows: ScanFindingInsertRow[],
  organizationId: string,
  claimToken: string,
) {
  return db.insert(scanFindings).select(
    sql.join(
      rows.map(
        (row) => sql`
          select
            ${row.id},
            ${row.scanId},
            ${row.severity},
            ${row.file},
            ${row.evidence},
            ${row.reason},
            ${row.line},
            ${row.source},
            ${row.ruleId},
            ${row.ruleVersion}
          where ${scanPersistClaimExists(row.scanId, organizationId, claimToken)}
        `,
      ),
      sql.raw(" union all "),
    ),
  );
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

export function chunkForD1<T>(rows: T[], columnsPerRow: number, reservedParameters = 0): T[][] {
  if (!rows.length) return [];
  const chunkSize = Math.max(
    1,
    Math.floor((D1_MAX_BOUND_PARAMETERS - reservedParameters) / columnsPerRow),
  );
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
    source: string;
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
      source: scans.source,
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
      source: row.source,
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
  artifactBucket?: R2Bucket,
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

  return getScan(db, input.scanId, input.organizationId, artifactBucket);
}

export interface RecordGatePackageDecisionInput extends RecordScanDecisionInput {
  gateId: string;
}

/**
 * Record the one allowed decision for a workflow-gate package while the gate is
 * still pending. This keeps stale concurrent submits from mutating package state
 * after the aggregate gate decision has already released or blocked GitHub.
 */
export async function recordGatePackageDecision(
  db: AppDb,
  input: RecordGatePackageDecisionInput,
  artifactBucket?: R2Bucket,
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
        eq(scans.gateId, input.gateId),
        eq(scans.source, "workflow_gate"),
        sql`${scans.status} in ('complete', 'failed')`,
        isNull(scans.decision),
        sql`exists (
          select 1
          from ${githubWorkflowGates}
          where ${githubWorkflowGates.id} = ${input.gateId}
            and ${githubWorkflowGates.status} = 'pending'
        )`,
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

  return getScan(db, input.scanId, input.organizationId, artifactBucket);
}

export async function getScan(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
  options: { includeFileSamples?: boolean } = {},
) {
  const [scanRows, files, findings, events] = await Promise.all([
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
  const includeFileSamples = options.includeFileSamples ?? true;
  const artifactDetail = includeFileSamples
    ? await loadScanArtifacts(artifactBucket, scan)
    : needsArtifactMetadataFallback(scan, files, findings)
      ? await loadScanArtifactMetadata(artifactBucket, scan)
      : null;
  const detailFiles = artifactDetail ? mergeArtifactFiles(files, artifactDetail.files, id) : files;
  const responseFiles = includeFileSamples ? detailFiles : detailFiles.map(stripFileSampleForList);
  const diff = artifactDetail?.diff ?? diffForFindingAnnotations(scan.summaryJson, detailFiles);
  const findingRows = artifactDetail ? artifactDetail.findings : findings;
  const annotatedFindings = annotateFindingsWithDiffStatus(findingRows, diff, {
    persistedAnnotations: artifactDetail
      ? artifactDetail.findingAnnotations
      : readFindingAnnotations(scan.summaryJson),
  });
  return {
    scan,
    files: responseFiles,
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

export async function getScanFile(
  db: AppDb,
  id: string,
  organizationId: string,
  path: string,
  artifactBucket?: R2Bucket,
) {
  const [scanRows, fileRows] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db
      .select()
      .from(scanFiles)
      .where(and(eq(scanFiles.scanId, id), eq(scanFiles.path, path)))
      .limit(1),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;

  const file = fileRows[0] ?? null;
  const artifactFile = await loadScanArtifactFile(artifactBucket, scan, path);
  if (!file && !artifactFile) return null;
  if (!artifactFile) return file;
  return mergeArtifactFiles(file ? [file] : [], [artifactFile], id)[0] ?? null;
}

export async function getScanStatus(db: AppDb, id: string, organizationId: string) {
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  return scan ?? null;
}

export async function getScanCompareData(
  db: AppDb,
  id: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
) {
  const [scanRows, files, findings] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db.select().from(scanFiles).where(eq(scanFiles.scanId, id)),
    db.select().from(scanFindings).where(eq(scanFindings.scanId, id)),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;
  const artifactDetail = needsArtifactMetadataFallback(scan, files, findings)
    ? await loadScanArtifactMetadata(artifactBucket, scan)
    : null;
  const detailFiles = artifactDetail ? mergeArtifactFiles(files, artifactDetail.files, id) : files;
  const findingRows = artifactDetail ? artifactDetail.findings : findings;
  return { scan, files: detailFiles.map(stripFileSampleForList), findings: findingRows };
}

function needsArtifactMetadataFallback(
  scan: typeof scans.$inferSelect,
  files: Array<typeof scanFiles.$inferSelect>,
  findings: Array<typeof scanFindings.$inferSelect>,
): boolean {
  if (!hasArtifactReferences(scan)) return false;
  if (files.length === 0) return true;
  return typeof scan.findingCount === "number" && findings.length < scan.findingCount;
}

function hasArtifactReferences(scan: typeof scans.$inferSelect): boolean {
  return (
    scan.artifactStorageVersion !== null &&
    scan.artifactManifestKey !== null &&
    scan.artifactManifestDigest !== null &&
    scan.artifactManifestSize !== null &&
    scan.reportArtifactKey !== null &&
    scan.fileSamplesArtifactKey !== null &&
    scan.diffArtifactKey !== null
  );
}

function stripFileSampleForList<T extends { textSample: string | null }>(file: T): T {
  return file.textSample === null ? file : { ...file, textSample: null };
}

function mergeArtifactFiles(
  d1Files: (typeof scanFiles.$inferSelect)[],
  artifactFiles: ScanArtifactFileRow[],
  scanId: string,
): (typeof scanFiles.$inferSelect)[] {
  const d1ByPath = new Map(d1Files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const merged = artifactFiles.map((file) => {
    seen.add(file.path);
    const d1 = d1ByPath.get(file.path);
    return {
      id: d1?.id ?? `${scanId}:${file.path}`,
      scanId: d1?.scanId ?? scanId,
      path: file.path,
      status: d1?.status ?? file.status,
      size: d1?.size ?? file.size,
      sha256: d1?.sha256 ?? file.sha256,
      flagsJson: d1?.flagsJson ?? file.flagsJson,
      textSample: file.textSample ?? d1?.textSample ?? null,
    };
  });
  for (const file of d1Files) {
    if (!seen.has(file.path)) merged.push(file);
  }
  return merged;
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
