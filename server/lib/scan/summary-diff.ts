// Compaction for the diff embedded in `scans.summary_json`.
//
// The pipeline used to embed the WHOLE file diff — one entry per file including
// every unchanged one, up to the parser's 2,500-file cap, each carrying two
// sha256 hex digests — into the D1 scan row, even though R2 already holds the
// authoritative `diff.json` (and a second copy inside `report.json`). For an
// artifact-backed scan that embed is pure duplication of large, immutable data
// in the metadata store.
//
// It is not dead, though: docs/artifact-storage.md commits to the R2 fallback
// read returning "the summary-embedded diff" for compacted scans, so it is the
// last-resort copy when an R2 read fails closed. So it is compacted rather than
// dropped: keep the release delta (added/removed/modified) plus aggregate
// per-status counts, drop the unchanged entries and the two redundant sha256
// digests (which no reader consumes and which files.json / scan_files already
// hold).
//
// The degraded path (no ARTIFACTS binding) keeps the FULL embed: D1 is then the
// only copy, and the artifact backfill reconstructs a digest-identical
// `report.json` from it — a compacted embed would make those rows permanently
// un-backfillable. See docs/artifact-storage.md.

import type { DiffEntry } from "../review";

/** Bump when the compacted shape changes in a way a reader must branch on. */
export const SUMMARY_DIFF_STATS_VERSION = 1;

/**
 * Upper bound on retained entries. Nearly every release changes a handful of
 * files, but the FIRST scan of a package has no baseline, so every file reads as
 * `added` — the one shape where "changed only" is still the whole tarball. The
 * cap keeps that case off the D1 row; `omittedChangedCount` records what the
 * embed dropped, and R2 still holds the complete diff.
 */
export const SUMMARY_DIFF_MAX_ENTRIES = 500;

export interface SummaryDiffStatusCounts {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

export interface SummaryDiffStats {
  version: number;
  /** Whether `summary.diff` is a reduced view of the scan's real diff. */
  compacted: boolean;
  /** Per-status entry counts over the FULL diff, not the retained subset. */
  counts: SummaryDiffStatusCounts;
  /** Entries in the full diff. */
  totalCount: number;
  /** Changed (added/removed/modified) entries in the full diff. */
  changedCount: number;
  /** Changed entries left out of `summary.diff` by SUMMARY_DIFF_MAX_ENTRIES. */
  omittedChangedCount: number;
}

export interface SummaryDiff {
  diff: DiffEntry[];
  diffStats: SummaryDiffStats;
}

const CHANGED_STATUSES = new Set<DiffEntry["status"]>(["added", "removed", "modified"]);

export function summaryDiffStatusCounts(diff: readonly DiffEntry[]): SummaryDiffStatusCounts {
  const counts: SummaryDiffStatusCounts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const entry of diff) {
    if (entry.status in counts) counts[entry.status] += 1;
  }
  return counts;
}

/**
 * The compact summary embed for an artifact-backed scan: changed entries only,
 * capped, with the two sha256 digests stripped. R2's `diff.json` stays the
 * authoritative full copy.
 */
export function compactSummaryDiff(
  diff: readonly DiffEntry[],
  maxEntries = SUMMARY_DIFF_MAX_ENTRIES,
): SummaryDiff {
  const counts = summaryDiffStatusCounts(diff);
  const changed = diff.filter((entry) => CHANGED_STATUSES.has(entry.status));
  const retained = changed.slice(0, Math.max(0, maxEntries));
  return {
    diff: retained.map(compactSummaryDiffEntry),
    diffStats: {
      version: SUMMARY_DIFF_STATS_VERSION,
      compacted: true,
      counts,
      totalCount: diff.length,
      changedCount: changed.length,
      omittedChangedCount: changed.length - retained.length,
    },
  };
}

/**
 * The full embed, for the degraded (no-R2) path where D1 is the only copy.
 * Carries stats too so every completed scan describes its own diff the same way.
 */
export function fullSummaryDiff(diff: readonly DiffEntry[]): SummaryDiff {
  const counts = summaryDiffStatusCounts(diff);
  return {
    diff: [...diff],
    diffStats: {
      version: SUMMARY_DIFF_STATS_VERSION,
      compacted: false,
      counts,
      totalCount: diff.length,
      changedCount: counts.added + counts.removed + counts.modified,
      omittedChangedCount: 0,
    },
  };
}

/**
 * Tolerant reader for the persisted `summary.diffStats` blob. Rows written
 * before compaction have no such field and every reader must treat that as "the
 * embed is whatever it is" rather than break, so anything unusable reads null.
 */
export function normalizeSummaryDiffStats(value: unknown): SummaryDiffStats | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof SummaryDiffStats, unknown>>;
  if (typeof item.version !== "number") return null;
  const counts = item.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const raw = counts as Partial<Record<keyof SummaryDiffStatusCounts, unknown>>;
  return {
    version: Math.floor(item.version),
    compacted: Boolean(item.compacted),
    counts: {
      added: normalizeCount(raw.added),
      removed: normalizeCount(raw.removed),
      modified: normalizeCount(raw.modified),
      unchanged: normalizeCount(raw.unchanged),
    },
    totalCount: normalizeCount(item.totalCount),
    changedCount: normalizeCount(item.changedCount),
    omittedChangedCount: normalizeCount(item.omittedChangedCount),
  };
}

// Only the fields a reader of the compact embed actually consumes: `path` and
// `status` (finding annotation, changed-file counts, the fallback file tree) and
// `flags` (rendering hints). The two sha256 digests are ~128 bytes per entry and
// nothing reads them off a diff entry — files.json/scan_files carry per-file
// hashes — so they are the first thing to go. Sizes are kept: they are a few
// bytes each and are what makes a fallback file list readable.
function compactSummaryDiffEntry(entry: DiffEntry): DiffEntry {
  return {
    path: entry.path,
    status: entry.status,
    ...(entry.previousSize !== undefined ? { previousSize: entry.previousSize } : {}),
    ...(entry.stagedSize !== undefined ? { stagedSize: entry.stagedSize } : {}),
    flags: entry.flags,
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
