import { describe, expect, test } from "vitest";
import { buildDisplaySegments, type HunkRowLike } from "../src/components/diff-hunks.ts";
import {
  diffOverviewMarkers,
  displayOverviewRows,
  type DiffOverviewRow,
} from "../src/components/diff-overview.ts";

describe("diffOverviewMarkers", () => {
  test("collapses contiguous changed rows into overview regions", () => {
    const rows: DiffOverviewRow[] = [
      { tone: "unchanged", line: 1 },
      { tone: "added", line: 2 },
      { tone: "added", line: 3 },
      { tone: "removed", line: null },
      { tone: "unchanged", line: 4 },
      { tone: "removed", line: null },
    ];

    const markers = diffOverviewMarkers(rows, new Map());
    expect(markers).toMatchObject([
      { kind: "change", tone: "added" },
      { kind: "change", tone: "removed" },
      { kind: "change", tone: "removed" },
    ]);
    expect(markers[0].topPercent).toBeCloseTo(100 / 6);
    expect(markers[0].heightPercent).toBeCloseTo(100 / 3);
    expect(markers[1].topPercent).toBeCloseTo(50);
    expect(markers[2].topPercent).toBeCloseTo(500 / 6);
  });

  test("adds highest-severity finding markers for pinned rendered lines", () => {
    const rows: DiffOverviewRow[] = [
      { tone: "unchanged", line: 1 },
      { tone: "unchanged", line: 2 },
      { tone: "unchanged", line: 3 },
    ];
    const pinned = new Map([
      [2, [{ severity: "low" }, { severity: "critical" }]],
      [3, [{ severity: "medium" }]],
    ]);

    const markers = diffOverviewMarkers(rows, pinned);
    expect(markers).toMatchObject([
      { kind: "finding", tone: "danger" },
      { kind: "finding", tone: "warn" },
    ]);
    expect(markers[0].topPercent).toBeCloseTo(100 / 3);
    expect(markers[1].topPercent).toBeCloseTo(200 / 3);
  });

  test("keeps single-line regions visible on large files", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      tone: index === 250 ? "added" : "unchanged",
      line: index + 1,
    })) satisfies DiffOverviewRow[];

    expect(diffOverviewMarkers(rows, new Map())).toMatchObject([
      { kind: "change", tone: "added", topPercent: 50, heightPercent: 1.4 },
    ]);
  });
});

describe("displayOverviewRows", () => {
  function unchangedRows(count: number, startLine = 1): HunkRowLike[] {
    return Array.from({ length: count }, (_, index) => ({
      tone: "unchanged" as const,
      afterLine: startLine + index,
    }));
  }

  test("collapses each gap to the single expander row it occupies on screen", () => {
    const rows: HunkRowLike[] = [
      ...unchangedRows(50),
      { tone: "added", afterLine: 51 },
      ...unchangedRows(50, 52),
    ];
    const segments = buildDisplaySegments(rows, new Set(), {}, "k");
    const overview = displayOverviewRows(segments, rows);

    // 2 gaps + 3 context rows on each side + the changed row.
    expect(overview).toHaveLength(9);
    expect(overview[0]).toEqual({ tone: "unchanged", line: null });
    expect(overview[4]).toEqual({ tone: "added", line: 51 });
    expect(overview[8]).toEqual({ tone: "unchanged", line: null });
  });

  test("keeps the marker's strip position aligned with its scroll position", () => {
    const rows: HunkRowLike[] = [
      ...unchangedRows(10_000),
      { tone: "added", afterLine: 10_001 },
      ...unchangedRows(10, 10_002),
    ];
    const segments = buildDisplaySegments(rows, new Set(), {}, "k");
    const overview = displayOverviewRows(segments, rows);
    const markers = diffOverviewMarkers(overview, new Map());

    // The change sits one gap row + 3 context rows into the collapsed view,
    // near the top of the scrollable space — not at 99.9% like its logical
    // line number would suggest.
    expect(overview.length).toBeLessThan(20);
    expect(markers[0].topPercent).toBeCloseTo((4 / overview.length) * 100);
  });

  test("reflows markers as a gap expands", () => {
    const rows: HunkRowLike[] = [...unchangedRows(1000), { tone: "added", afterLine: 1001 }];
    const collapsed = buildDisplaySegments(rows, new Set(), {}, "k");
    const expanded = buildDisplaySegments(rows, new Set(), { "k:0": 100 }, "k");

    expect(displayOverviewRows(expanded, rows).length).toBeGreaterThan(
      displayOverviewRows(collapsed, rows).length,
    );
  });
});
