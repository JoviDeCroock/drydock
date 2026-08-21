/**
 * Risk summaries persisted alongside a scan.
 *
 * A scan row carries a denormalized risk breakdown so the list view can rank
 * and filter without loading findings. These readers are the single place that
 * knows how to get a breakdown back out of a persisted `summaryJson`, whether
 * it was written by the current pipeline or an older one.
 */
import { computeRisk, normalizeRisk } from "../lib/review";
import { normalizeScanRiskBreakdown, type ScanRiskBreakdown } from "../lib/review/risk";

export interface ScanRiskSummary {
  artifactRisk: string;
  releaseRisk: string;
  contextRisk: string;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
}

export function readScanRiskBreakdown(value: unknown): ScanRiskSummary | null {
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

export function countChangedFileEntries(diff: Array<{ status?: unknown }>): number {
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
export function computeRiskSummary(
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
    // Recomputation can't reconstruct which context findings a prior release
    // already covered — that needs the release-memory lookup — so an unset value
    // means "no adjustment", matching how scans written before the field scored.
    priorApprovedContextFindingCount: persistedBreakdown?.priorApprovedContextFindingCount ?? 0,
  };
}

export function readPersistedListRiskSummary(summaryJson: unknown): ScanRiskBreakdown | null {
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
    // Deliberately not part of the completeness guard above: scans persisted
    // before release memory affected scoring have no such field, and requiring
    // it would drop every one of them back to the recompute path.
    priorApprovedContextFindingCount: partial.priorApprovedContextFindingCount ?? 0,
  };
}

export function readPersistedRiskBreakdown(summaryJson: unknown) {
  const summary = summaryJson && typeof summaryJson === "object" ? summaryJson : null;
  const risk = summary && !Array.isArray(summary) ? (summary as { risk?: unknown }).risk : null;
  return normalizeScanRiskBreakdown(risk);
}
