import type { DiffEntry } from "../../../server/lib/review";
import { maxSeverity } from "../../components/diff-annotations";
import type { FindingWithDiffStatus } from "./types";

export interface FindingCount {
  count: number;
  maxSeverity: string;
}

// Per-file finding counts (with the highest severity for tone), keyed by the
// finding's file path. FileTree bubbles these up to parent folders. Feeds the
// tree-count surface from the same finding set as the inline diff annotations
// and the risk-signals index, so all three stay in sync.
export function findingCountsByPath(findings: FindingWithDiffStatus[]): Map<string, FindingCount> {
  const counts = new Map<string, FindingCount>();
  for (const { finding } of findings) {
    const existing = counts.get(finding.file);
    if (existing) {
      existing.count += 1;
      existing.maxSeverity =
        maxSeverity(existing.maxSeverity, finding.severity) ?? existing.maxSeverity;
    } else {
      counts.set(finding.file, { count: 1, maxSeverity: finding.severity });
    }
  }
  return counts;
}

const DIFF_STATUS_RANK: Record<DiffEntry["status"], number> = {
  added: 0,
  modified: 1,
  removed: 2,
  unchanged: 3,
};

// Applies the file-tree filter box and the "changed only" toggle, then orders
// entries so the release delta reads first (added, modified, removed) and
// unchanged package context sinks to the bottom.
export function filterDiffEntries(
  entries: DiffEntry[],
  rawFilter: string,
  changedOnly: boolean,
): DiffEntry[] {
  const filter = rawFilter.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (changedOnly && entry.status === "unchanged") return false;
      if (!filter) return true;
      return entry.path.toLowerCase().includes(filter);
    })
    .sort((a, b) => {
      const status = DIFF_STATUS_RANK[a.status] - DIFF_STATUS_RANK[b.status];
      return status || a.path.localeCompare(b.path);
    });
}
