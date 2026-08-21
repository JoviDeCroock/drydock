import {
  SCAN_ARTIFACT_STORAGE_VERSION,
  type ScanArtifactDescriptor,
  type ScanArtifactFileRow,
  type ScanArtifactFindingRow,
  type ScanArtifactsDetail,
  type ScanArtifactsManifest,
} from "./types";
/**
 * Parsers for artifact bodies read back from R2.
 *
 * These run over bytes that already passed the digest check, so they are
 * guarding against version skew and legacy shapes rather than tampering —
 * every one of them returns null instead of throwing so a single unreadable
 * artifact degrades to the D1 fallback rather than failing the request.
 */
import {
  normalizeFindingDiffStatus,
  redactFindings,
  type DiffEntry,
  type Finding,
  type FindingDiffAnnotation,
} from "../../review";
import { parsePersistedAiReview } from "../../ai-review/contract";
import { displayedAiResult, type AiReview } from "../../ai-review/types";

export function parseManifest(text: string): ScanArtifactsManifest | null {
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

export function parseFilesArtifact(text: string, scanId: string): ScanArtifactFileRow[] | null {
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

export function parseReportArtifactMetadata(
  text: string,
  scanId: string,
): ScanArtifactsDetail | null {
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

export function parseDiffArtifact(text: string, scanId: string): DiffEntry[] | null {
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
export function parseReportFindings(
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
