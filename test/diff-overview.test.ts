import { describe, expect, test } from "vitest";
import { diffOverviewMarkers, type DiffOverviewRow } from "../src/components/diff-overview.ts";

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
