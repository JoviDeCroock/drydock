// Pure helpers for pinning findings onto diff lines. Kept JSX-free so the
// row-matching logic is unit-testable without rendering DiffView. The diff is
// the headline (docs/design.md / diff-first direction): deterministic findings are
// pinned to the hunk that triggered them rather than living in a side list.

export interface DiffFinding {
  id: string;
  severity: string;
  line?: number | null;
  ruleId?: string | null;
  reason: string;
  evidence?: string | null;
}

export type SeverityGroup = "danger" | "warn" | "info" | "ok";

// Collapse the six severities onto the four chromatic groups the soft fills and
// borders are keyed on. Unknown severities fall back to the info group so they
// still read as a neutral-blue signal rather than going unstyled.
export function severityGroup(severity: string): SeverityGroup {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warn";
  if (severity === "ok") return "ok";
  return "info";
}

// Severity ordering for "highest wins" aggregation (file-tree finding counts
// bubble the max severity up to parent folders for tone). Unknown severities
// rank below ok so a recognized severity always wins.
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

// The mono caption above a pinned finding: `ruleId · line N`. Either part may be
// absent; returns null when neither is present so the caption can be skipped.
export function annotationLabel(finding: Pick<DiffFinding, "ruleId" | "line">): string | null {
  const parts: string[] = [];
  if (finding.ruleId) parts.push(finding.ruleId);
  if (typeof finding.line === "number") parts.push(`line ${finding.line}`);
  return parts.length ? parts.join(" · ") : null;
}

export interface PartitionedFindings<T> {
  // line number (in the rendered side) → findings pinned beneath that line
  pinned: Map<number, T[]>;
  // findings with no line, or a line outside the rendered sample (e.g. a
  // truncated file). Surfaced in a banner so a clipped sample never hides them.
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
