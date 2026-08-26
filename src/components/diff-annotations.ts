export interface DiffFinding {
  id: string;
  severity: string;
  line?: number | null;
  sourceLine?: number | null;
  ruleId?: string | null;
  reason: string;
  evidence?: string | null;
}

export type SeverityGroup = "danger" | "warn" | "info" | "ok";

export function severityGroup(severity: string): SeverityGroup {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warn";
  if (severity === "ok") return "ok";
  return "info";
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
  ok: 0,
};

export function maxSeverity(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return (SEVERITY_RANK[a] ?? -1) >= (SEVERITY_RANK[b] ?? -1) ? a : b;
}

export function annotationLabel(
  finding: Pick<DiffFinding, "ruleId" | "line" | "sourceLine">,
): string | null {
  const parts: string[] = [];
  if (finding.ruleId) parts.push(finding.ruleId);
  const line = finding.sourceLine ?? finding.line;
  if (typeof line === "number") parts.push(`line ${line}`);
  return parts.length ? parts.join(" · ") : null;
}

export interface PartitionedFindings<T> {
  pinned: Map<number, T[]>;
  unpinned: T[];
}

export function partitionFindingsByLine<T extends { line?: number | null }>(
  findings: readonly T[],
  presentLines: ReadonlySet<number>,
): PartitionedFindings<T> {
  const pinned = new Map<number, T[]>();
  const unpinned: T[] = [];
  for (const finding of findings) {
    const line = finding.line;
    if (typeof line === "number" && presentLines.has(line)) {
      const bucket = pinned.get(line);
      if (bucket) bucket.push(finding);
      else pinned.set(line, [finding]);
    } else {
      unpinned.push(finding);
    }
  }
  return { pinned, unpinned };
}
