import type { SeverityCounts, SeverityKey } from "../components";

export const SEVERITY_RANK: Record<SeverityKey, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  ok: 5,
};

export function normalizeSeverityKey(value: string | undefined): SeverityKey | null {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
    case "ok":
      return value;
    default:
      return null;
  }
}

export function compareSeverity(a: string | undefined, b: string | undefined): number {
  const aRank = SEVERITY_RANK[normalizeSeverityKey(a) ?? "info"] ?? SEVERITY_RANK.info;
  const bRank = SEVERITY_RANK[normalizeSeverityKey(b) ?? "info"] ?? SEVERITY_RANK.info;
  return aRank - bRank;
}

export function sortFindingsBySeverity<T extends { severity?: string }>(findings: T[]): T[] {
  return findings.slice().sort((a, b) => compareSeverity(a.severity, b.severity));
}

export function highestFindingRisk(findings: Array<{ severity?: string }>): string {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  return "low";
}

export function countSeverities(findings: Array<{ severity?: string }>): SeverityCounts {
  const counts: SeverityCounts = {};
  for (const finding of findings) {
    const key = normalizeSeverityKey(finding.severity);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
