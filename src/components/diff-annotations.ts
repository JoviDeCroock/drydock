export interface DiffFinding {
  id: string;
  // Advisory comments deliberately carry no severity. Findings always do;
  // consumers fall back defensively when handed a malformed annotation.
  severity?: string | null;
  line?: number | null;
  sourceLine?: number | null;
  ruleId?: string | null;
  reason: string;
  evidence?: string | null;
  // Who produced this: "rule" for a deterministic rule, "ai" for the assistant.
  // Drives the caption only — an AI finding is pinned, styled, and ranked by the
  // same severity machinery as a deterministic one.
  source?: string | null;
  // "comment" marks an advisory assistant note rather than a finding. Notes
  // carry no severity of their own (they render in the neutral info group) and
  // never appear in the risk-signals index or the file-tree counts.
  kind?: "finding" | "comment";
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

// The mono caption above a pinned finding: `ruleId · line N`. Either part may be
// absent; returns null when neither is present so the caption can be skipped.
// The line is always the artifact's own line, never the reformatted view's row.
// An assistant finding has no ruleId, so it is captioned by its origin instead —
// otherwise it reads as an unattributed claim sitting on the same line as
// deterministic evidence, which is exactly the distinction a maintainer weighs.
export function annotationLabel(
  finding: Pick<DiffFinding, "ruleId" | "line" | "sourceLine" | "source" | "kind">,
): string | null {
  const parts: string[] = [];
  // A comment's origin is already on its badge, so it takes the line alone.
  if (finding.ruleId) parts.push(finding.ruleId);
  else if (finding.source === "ai" && finding.kind !== "comment") parts.push("assistant");
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
