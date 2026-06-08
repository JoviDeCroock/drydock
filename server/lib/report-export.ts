import type { getScan } from "../db/scans";

// A persisted scan detail, as returned by getScan (never null at the call site).
type ScanDetail = NonNullable<Awaited<ReturnType<typeof getScan>>>;

// Schema tag for the exported report document. Bump the suffix when the export
// shape changes in a way consumers must branch on.
export const REPORT_EXPORT_SCHEMA = "drydock.report.v1";

// Build a self-contained, archivable view of a completed review from the data
// already persisted for it: provenance metadata, package/baseline identity, the
// risk summary, the manifest and file diffs, and the deterministic findings.
//
// This is the persisted *record*, not a re-derivation of the digested payload —
// the stored report digest is carried through for reference, but reproducing it
// byte-for-byte from the database is deliberately out of scope here.
export function buildReportExport(detail: ScanDetail) {
  const { scan } = detail;
  const summary = isRecord(scan.summaryJson) ? scan.summaryJson : {};
  return {
    schema: REPORT_EXPORT_SCHEMA,
    report: summary.report ?? null,
    scan: {
      id: scan.id,
      stageId: scan.stageId,
      status: scan.status,
      source: scan.source,
      risk: scan.risk,
      decision: scan.decision ?? null,
      createdAt: toIso(scan.createdAt),
      completedAt: toIso(scan.completedAt),
    },
    package: {
      name: scan.packageName ?? null,
      stagedVersion: scan.stagedVersion ?? null,
      previousVersion: scan.previousVersion ?? null,
    },
    baseline: summary.baseline ?? null,
    safety: summary.safety ?? null,
    riskSummary: detail.riskSummary ?? null,
    packageJsonDiff: summary.packageJsonDiff ?? null,
    diff: summary.diff ?? null,
    findings: [...detail.findings].sort(compareFindings).map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line ?? null,
      ruleId: finding.ruleId ?? null,
      ruleVersion: finding.ruleVersion ?? null,
      source: finding.source,
      diffStatus: finding.diffStatus ?? null,
      releaseDelta: finding.releaseDelta ?? null,
      evidence: finding.evidence,
      reason: finding.reason,
    })),
  };
}

// Serialize the export with stable key ordering so the same evidence always
// produces byte-identical output — the property two report artifacts need to be
// comparable, and a prerequisite for signing later.
export function serializeReportExport(detail: ScanDetail): string {
  return stableStringify(buildReportExport(detail));
}

function compareFindings(
  a: ScanDetail["findings"][number],
  b: ScanDetail["findings"][number],
): number {
  return (
    cmp(a.file, b.file) ||
    cmp(a.ruleId ?? "", b.ruleId ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmp(a.severity, b.severity)
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => cmp(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
