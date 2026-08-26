import { describe, expect, test } from "vitest";

const {
  compactSummaryDiff,
  normalizeSummaryDiffStats,
  summaryDiffStatusCounts,
  SUMMARY_DIFF_MAX_ENTRIES,
  SUMMARY_DIFF_STATS_VERSION,
} = await import("../server/lib/scan/summary-diff");

function entry(path, status, overrides = {}) {
  return {
    path,
    status,
    previousSize: 10,
    stagedSize: 20,
    previousSha256: "a".repeat(64),
    stagedSha256: "b".repeat(64),
    flags: [],
    ...overrides,
  };
}

const diff = [
  entry("added.js", "added"),
  entry("index.js", "modified"),
  entry("gone.js", "removed"),
  entry("README.md", "unchanged"),
  entry("license", "unchanged"),
];

describe("summaryDiffStatusCounts", () => {
  test("counts every status over the full diff", () => {
    expect(summaryDiffStatusCounts(diff)).toEqual({
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 2,
    });
  });

  test("ignores an unknown status rather than inventing a bucket", () => {
    expect(summaryDiffStatusCounts([entry("x", "bogus")])).toEqual({
      added: 0,
      removed: 0,
      modified: 0,
      unchanged: 0,
    });
  });
});

describe("compactSummaryDiff", () => {
  test("keeps the release delta, drops unchanged entries and the sha256 digests", () => {
    const compacted = compactSummaryDiff(diff);
    expect(compacted.diff.map((item) => item.path)).toEqual(["added.js", "index.js", "gone.js"]);
    for (const item of compacted.diff) {
      expect(item).not.toHaveProperty("previousSha256");
      expect(item).not.toHaveProperty("stagedSha256");
      // Sizes and flags stay: they are a few bytes and are what makes the
      // fallback file list readable.
      expect(item.previousSize).toBe(10);
      expect(item.stagedSize).toBe(20);
      expect(item.flags).toEqual([]);
    }
  });

  test("records the shape of the real diff, not the retained subset", () => {
    expect(compactSummaryDiff(diff).diffStats).toEqual({
      version: SUMMARY_DIFF_STATS_VERSION,
      compacted: true,
      counts: { added: 1, removed: 1, modified: 1, unchanged: 2 },
      totalCount: 5,
      changedCount: 3,
      omittedChangedCount: 0,
    });
  });

  test("preserves optional fields only when present", () => {
    const sparse = [{ path: "a.js", status: "added", stagedSize: 5, flags: ["binary"] }];
    expect(compactSummaryDiff(sparse).diff).toEqual([
      { path: "a.js", status: "added", stagedSize: 5, flags: ["binary"] },
    ]);
  });

  test("caps retained entries and reports how many changed entries it dropped", () => {
    // The first scan of a package has no baseline, so every file reads as
    // `added` — the one shape where "changed only" is still the whole tarball.
    const firstScan = Array.from({ length: SUMMARY_DIFF_MAX_ENTRIES + 25 }, (_unused, index) =>
      entry(`src/file-${index}.js`, "added"),
    );
    const compacted = compactSummaryDiff(firstScan);
    expect(compacted.diff).toHaveLength(SUMMARY_DIFF_MAX_ENTRIES);
    expect(compacted.diffStats.changedCount).toBe(SUMMARY_DIFF_MAX_ENTRIES + 25);
    expect(compacted.diffStats.omittedChangedCount).toBe(25);
  });

  test("is materially smaller than the full embed", () => {
    const full = JSON.stringify(diff);
    const compact = JSON.stringify(compactSummaryDiff(diff).diff);
    expect(compact.length).toBeLessThan(full.length / 2);
  });

  test("an all-unchanged diff compacts to nothing but keeps its counts", () => {
    const compacted = compactSummaryDiff([entry("a", "unchanged"), entry("b", "unchanged")]);
    expect(compacted.diff).toEqual([]);
    expect(compacted.diffStats.counts.unchanged).toBe(2);
    expect(compacted.diffStats.changedCount).toBe(0);
  });
});

describe("normalizeSummaryDiffStats", () => {
  test("round-trips a persisted blob", () => {
    const stats = compactSummaryDiff(diff).diffStats;
    expect(normalizeSummaryDiffStats(JSON.parse(JSON.stringify(stats)))).toEqual(stats);
  });

  test("reads null for rows written before the field existed", () => {
    expect(normalizeSummaryDiffStats(undefined)).toBeNull();
    expect(normalizeSummaryDiffStats(null)).toBeNull();
  });

  test("reads null for malformed blobs instead of throwing", () => {
    expect(normalizeSummaryDiffStats([])).toBeNull();
    expect(normalizeSummaryDiffStats("nope")).toBeNull();
    expect(normalizeSummaryDiffStats({ compacted: true })).toBeNull();
    expect(normalizeSummaryDiffStats({ version: 1 })).toBeNull();
    expect(normalizeSummaryDiffStats({ version: 1, counts: [] })).toBeNull();
  });

  test("coerces junk counts to zero rather than propagating them", () => {
    const stats = normalizeSummaryDiffStats({
      version: 1,
      compacted: true,
      counts: { added: -4, removed: "x", modified: 2.7, unchanged: null },
      totalCount: Number.NaN,
      changedCount: 3,
    });
    expect(stats).toEqual({
      version: 1,
      compacted: true,
      counts: { added: 0, removed: 0, modified: 2, unchanged: 0 },
      totalCount: 0,
      changedCount: 3,
      omittedChangedCount: 0,
    });
  });
});
