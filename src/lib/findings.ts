import { type SeverityCounts, type SeverityKey } from "../components/SeverityBar";

const SEVERITY_RANK: Record<SeverityKey, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  ok: 5,
};

function normalizeSeverityKey(value: string | undefined): SeverityKey | null {
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

export interface FindingGroupKeySource {
  ruleId?: string | null;
  severity?: string;
  evidence?: string;
  reason?: string;
}

// Findings that share a rule, severity, and wording are one capability observed
// across many files (e.g. a test suite where every file spawns processes).
// Grouping them keeps the report one-row-per-signal instead of one-row-per-file.
// Findings without a ruleId never group: there is no rule identity to share.
export function groupFindingsByRule<T extends FindingGroupKeySource>(
  findings: T[],
): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  let ungroupedIndex = 0;
  for (const finding of findings) {
    const key = finding.ruleId
      ? ["rule", finding.ruleId, finding.severity, finding.evidence, finding.reason].join("\u0000")
      : `ungrouped\u0000${ungroupedIndex++}`;
    const existing = groups.get(key);
    if (existing) existing.push(finding);
    else {
      groups.set(key, [finding]);
      order.push(key);
    }
  }
  return order.map((key) => ({ key, items: groups.get(key) ?? [] }));
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
