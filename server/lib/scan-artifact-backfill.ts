import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { scanFiles, scanFindings, scans } from "../db/schema";
import { describeOperationalError, emitOperationalEvent } from "./observability";
import { redactJson, type DiffEntry, type Finding, type PackageJsonSummary } from "./review";
import { writeScanArtifacts } from "./scan-artifacts";
import { sha256Hex, stableJson } from "./stable-json";
import { parsePackageJson, type ParsedFile } from "./tar-parser.js";

export interface ScanArtifactsBackfillResult {
  scanned: number;
  backfilled: number;
  alreadyBacked: number;
  digestMismatch: number;
  failed: number;
  nextCursor: string | null;
}

export const SCAN_ARTIFACT_BACKFILL_DEFAULT_LIMIT = 10;
export const SCAN_ARTIFACT_BACKFILL_MAX_LIMIT = 50;

type BackfillCandidate = typeof scans.$inferSelect;

export async function backfillScanArtifactsBatch(
  db: AppDb,
  bucket: R2Bucket,
  organizationId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<ScanArtifactsBackfillResult> {
  const limit = Math.min(
    SCAN_ARTIFACT_BACKFILL_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? SCAN_ARTIFACT_BACKFILL_DEFAULT_LIMIT)),
  );
  const page = await listCandidates(db, organizationId, limit + 1, options.cursor ?? null);
  const hasMore = page.length > limit;
  const candidates = hasMore ? page.slice(0, limit) : page;
  const result: ScanArtifactsBackfillResult = {
    scanned: candidates.length,
    backfilled: 0,
    alreadyBacked: 0,
    digestMismatch: 0,
    failed: 0,
    nextCursor: hasMore ? candidates[candidates.length - 1].id : null,
  };

  for (const candidate of candidates) {
    const outcome = await backfillOneScan(db, bucket, candidate).catch((err) => {
      emitOperationalEvent("error", "scan.artifacts.backfill_failed", {
        scanId: candidate.id,
        organizationId,
        error: describeOperationalError(err),
      });
      return "failed" as const;
    });
    result[outcome] += 1;
  }

  return result;
}

async function listCandidates(
  db: AppDb,
  organizationId: string,
  limit: number,
  cursor: string | null,
): Promise<BackfillCandidate[]> {
  const conditions = [
    eq(scans.organizationId, organizationId),
    eq(scans.status, "complete"),
    isNull(scans.artifactStorageVersion),
  ];
  if (cursor) conditions.push(sql`${scans.id} > ${cursor}`);
  return db
    .select()
    .from(scans)
    .where(and(...conditions))
    .orderBy(asc(scans.id))
    .limit(limit);
}

type BackfillOutcome = "backfilled" | "alreadyBacked" | "digestMismatch" | "failed";

async function backfillOneScan(
  db: AppDb,
  bucket: R2Bucket,
  scan: BackfillCandidate,
): Promise<BackfillOutcome> {
  if (!scan.organizationId || !scan.reportDigest || !scan.reportVersion) return "digestMismatch";

  const [files, findings] = await Promise.all([
    db.select().from(scanFiles).where(eq(scanFiles.scanId, scan.id)),
    db
      .select()
      .from(scanFindings)
      .where(eq(scanFindings.scanId, scan.id))
      .orderBy(sql`rowid`),
  ]);
  const report = reconstructReport(scan, files, findings);
  if (!report) return "digestMismatch";

  const reportJson = stableJson(report.payload);
  const digest = await sha256Hex(reportJson);
  if (digest !== scan.reportDigest) {
    emitOperationalEvent("warn", "scan.artifacts.backfill_digest_mismatch", {
      scanId: scan.id,
      organizationId: scan.organizationId,
      reportVersion: scan.reportVersion,
    });
    return "digestMismatch";
  }

  const metadata = await writeScanArtifacts(bucket, {
    organizationId: scan.organizationId,
    scanId: scan.id,
    reportJson,
    reportDigest: digest,
    files: report.files,
    diff: report.diff,
    generatedAt: report.generatedAt,
  });

  const updated = await db
    .update(scans)
    .set({
      artifactStorageVersion: metadata.artifactStorageVersion,
      artifactManifestKey: metadata.artifactManifestKey,
      artifactManifestDigest: metadata.artifactManifestDigest,
      artifactManifestSize: metadata.artifactManifestSize,
      reportArtifactKey: metadata.reportArtifactKey,
      fileSamplesArtifactKey: metadata.fileSamplesArtifactKey,
      diffArtifactKey: metadata.diffArtifactKey,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scans.id, scan.id),
        eq(scans.organizationId, scan.organizationId),
        eq(scans.status, "complete"),
        isNull(scans.artifactStorageVersion),
      ),
    )
    .returning({ id: scans.id });

  if (!updated.length) return "alreadyBacked";
  emitOperationalEvent("info", "scan.artifacts.backfilled", {
    scanId: scan.id,
    organizationId: scan.organizationId,
    reportVersion: scan.reportVersion,
  });
  return "backfilled";
}

function reconstructReport(
  scan: BackfillCandidate,
  files: Array<typeof scanFiles.$inferSelect>,
  findings: Array<typeof scanFindings.$inferSelect>,
): {
  payload: Record<string, unknown>;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    textSample?: string;
    flags: string[];
  }>;
  diff: DiffEntry[];
  generatedAt: string;
} | null {
  const summary = readObject(scan.summaryJson);
  const report = readObject(summary?.report);
  const version = typeof report?.version === "number" ? report.version : scan.reportVersion;
  const rulesVersion = typeof report?.rulesVersion === "string" ? report.rulesVersion : null;
  const generatedAt =
    typeof report?.generatedAt === "string" ? report.generatedAt : new Date().toISOString();
  const baseline = readObject(summary?.baseline);
  const risk = readObject(summary?.risk);
  const safety = readObject(summary?.safety);
  const stagedPublish = readObject(summary?.stagedPublish);
  const packageJsonDiff = readObject(summary?.packageJsonDiff);
  const diff = readDiff(summary?.diff);
  if (!version || !rulesVersion || !baseline || !risk || !safety || !packageJsonDiff || !diff) {
    return null;
  }

  const fileRecords = files.map((file) => ({
    path: file.path,
    size: file.size ?? 0,
    sha256: file.sha256 ?? "",
    flags: readStringArray(file.flagsJson),
    ...(file.textSample ? { textSample: file.textSample } : {}),
  }));
  const packageJson = readPackageJsonSummary(fileRecords, scan);
  const annotations = readReportFindingAnnotations(summary?.findingAnnotations, findings);
  if (!annotations) return null;

  return {
    generatedAt,
    files: fileRecords,
    diff,
    payload: {
      version,
      rulesVersion,
      stageId: scan.stageId,
      stagedPublish,
      package: {
        name: scan.packageName,
        stagedVersion: scan.stagedVersion,
        stagedTag: typeof stagedPublish?.tag === "string" ? stagedPublish.tag : null,
        previousVersion: scan.previousVersion,
      },
      baseline,
      fileCount: fileRecords.length,
      previousFileCount: countPreviousFiles(diff),
      packageJson,
      packageJsonDiff,
      diff,
      // The report's ruleFindings hold deterministic rows only; a completed AI
      // review's rows (source "ai", inserted after the rule rows so rowid order
      // matches the report's combined annotation index space) are carried by
      // the aiFindings envelope instead — the shape persistResults digested.
      ruleFindings: findings.filter((row) => row.source === "rule").map(findingRowToReportFinding),
      findingAnnotations: annotations,
      aiFindings: scan.aiJson,
      risk,
      safety,
    },
  };
}

function readPackageJsonSummary(
  files: ParsedFile[],
  scan: Pick<BackfillCandidate, "packageName" | "stagedVersion">,
): PackageJsonSummary | null {
  const parsed = parsePackageJson(files);
  if (parsed) return redactJson(parsed as PackageJsonSummary);
  if (!scan.packageName && !scan.stagedVersion) return null;
  return {
    ...(scan.packageName ? { name: scan.packageName } : {}),
    ...(scan.stagedVersion ? { version: scan.stagedVersion } : {}),
  };
}

function readReportFindingAnnotations(
  value: unknown,
  findings: Array<typeof scanFindings.$inferSelect>,
): Array<{ findingIndex: number; diffStatus: string; releaseDelta: boolean }> | null {
  if (!Array.isArray(value)) return findings.length ? null : [];
  const byId = new Map<string, { diffStatus: string; releaseDelta: boolean }>();
  for (const item of value) {
    const entry = readObject(item);
    if (!entry || typeof entry.id !== "string" || typeof entry.diffStatus !== "string") {
      return null;
    }
    byId.set(entry.id, {
      diffStatus: entry.diffStatus,
      releaseDelta: Boolean(entry.releaseDelta),
    });
  }
  const out: Array<{ findingIndex: number; diffStatus: string; releaseDelta: boolean }> = [];
  for (let index = 0; index < findings.length; index += 1) {
    const annotation = byId.get(findings[index].id);
    if (!annotation) return null;
    out.push({ findingIndex: index, ...annotation });
  }
  return out;
}

function findingRowToReportFinding(row: typeof scanFindings.$inferSelect): Finding {
  return {
    severity: normalizeSeverity(row.severity),
    file: row.file,
    evidence: row.evidence,
    reason: row.reason,
    ...(row.line !== null ? { line: row.line } : {}),
    ...(row.ruleId !== null ? { ruleId: row.ruleId } : {}),
    ...(row.ruleVersion !== null ? { ruleVersion: row.ruleVersion } : {}),
  };
}

function normalizeSeverity(value: string): Finding["severity"] {
  return value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
    ? value
    : "medium";
}

function countPreviousFiles(diff: DiffEntry[]): number {
  return diff.filter((entry) => entry.status !== "added").length;
}

function readDiff(value: unknown): DiffEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: DiffEntry[] = [];
  for (const item of value) {
    const entry = readObject(item);
    if (!entry || typeof entry.path !== "string" || typeof entry.status !== "string") return null;
    if (
      entry.status !== "added" &&
      entry.status !== "removed" &&
      entry.status !== "modified" &&
      entry.status !== "unchanged"
    ) {
      return null;
    }
    out.push({
      path: entry.path,
      status: entry.status,
      ...(typeof entry.previousSize === "number" ? { previousSize: entry.previousSize } : {}),
      ...(typeof entry.stagedSize === "number" ? { stagedSize: entry.stagedSize } : {}),
      ...(typeof entry.previousSha256 === "string" ? { previousSha256: entry.previousSha256 } : {}),
      ...(typeof entry.stagedSha256 === "string" ? { stagedSha256: entry.stagedSha256 } : {}),
      flags: readStringArray(entry.flags),
    });
  }
  return out;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
