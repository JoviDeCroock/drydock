import { describe, expect, test } from "vitest";
import {
  buildDisplaySegments,
  GAP_CONTEXT_LINES,
  GAP_EXPAND_STEP,
  GAP_MIN_HIDDEN,
  type HunkRowLike,
} from "../src/components/diff-hunks";

function unchangedRows(count: number, startLine = 1): HunkRowLike[] {
  return Array.from({ length: count }, (_, index) => ({
    tone: "unchanged" as const,
    afterLine: startLine + index,
  }));
}

function rowIndexes(segments: ReturnType<typeof buildDisplaySegments>): number[] {
  return segments.filter((segment) => segment.kind === "row").map((segment) => segment.index);
}

function gaps(segments: ReturnType<typeof buildDisplaySegments>) {
  return segments.filter((segment) => segment.kind === "gap");
}

describe("buildDisplaySegments", () => {
  test("keeps changed rows and context, collapses the long unchanged middle", () => {
    const rows: HunkRowLike[] = [
      ...unchangedRows(50),
      { tone: "removed", afterLine: null },
      { tone: "added", afterLine: 51 },
      ...unchangedRows(50, 52),
    ];
    const segments = buildDisplaySegments(rows, new Set(), {}, "k");

    const visible = rowIndexes(segments);
    // Change block at indexes 50/51 plus GAP_CONTEXT_LINES on each side.
    expect(visible).toEqual([47, 48, 49, 50, 51, 52, 53, 54]);
    const collapsed = gaps(segments);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].hiddenCount).toBe(47);
    expect(collapsed[1].hiddenCount).toBe(47);
    // Leading gap renders before its context rows, trailing gap after.
    expect(segments[0].kind).toBe("gap");
    expect(segments[segments.length - 1].kind).toBe("gap");
  });

  test("renders short unchanged runs in full", () => {
    const rows: HunkRowLike[] = [
      { tone: "added", afterLine: 1 },
      ...unchangedRows(GAP_CONTEXT_LINES * 2 + GAP_MIN_HIDDEN - 1, 2),
      { tone: "added", afterLine: 100 },
    ];
    const segments = buildDisplaySegments(rows, new Set(), {}, "k");
    expect(gaps(segments)).toHaveLength(0);
    expect(rowIndexes(segments)).toHaveLength(rows.length);
  });

  test("a fully unchanged table becomes a single gap", () => {
    const segments = buildDisplaySegments(unchangedRows(100), new Set(), {}, "k");
    expect(segments).toEqual([{ kind: "gap", key: "k:0", hiddenCount: 100 }]);
  });

  test("rows with pinned findings never collapse and keep their own context", () => {
    const rows = unchangedRows(200);
    const segments = buildDisplaySegments(rows, new Set([100]), {}, "k");

    const visible = rowIndexes(segments);
    // afterLine 100 is index 99; it and its context must be visible.
    expect(visible).toEqual([96, 97, 98, 99, 100, 101, 102]);
    expect(gaps(segments).map((gap) => gap.hiddenCount)).toEqual([96, 97]);
  });

  test("expansion reveals rows from both edges of the gap", () => {
    const rows: HunkRowLike[] = [{ tone: "added", afterLine: 1 }, ...unchangedRows(500, 2)];
    const collapsedFirst = buildDisplaySegments(rows, new Set(), {}, "k");
    const gapKey = gaps(collapsedFirst)[0].key;

    const segments = buildDisplaySegments(rows, new Set(), { [gapKey]: GAP_EXPAND_STEP }, "k");
    const gap = gaps(segments)[0];
    expect(gap.hiddenCount).toBe(gaps(collapsedFirst)[0].hiddenCount - 2 * GAP_EXPAND_STEP);
    // Revealed rows appear on both sides of the remaining gap.
    const gapPosition = segments.indexOf(gap);
    expect(segments[gapPosition - 1].kind).toBe("row");
    expect(segments[gapPosition + 1].kind).toBe("row");
  });

  test("expansion that leaves a tiny residual reveals the whole run", () => {
    const rows = unchangedRows(2 * GAP_EXPAND_STEP + GAP_MIN_HIDDEN - 1);
    const segments = buildDisplaySegments(rows, new Set(), { "k:0": GAP_EXPAND_STEP }, "k");
    expect(gaps(segments)).toHaveLength(0);
    expect(rowIndexes(segments)).toHaveLength(rows.length);
  });

  test("expanding by the gap's hidden count reveals the whole run (show all)", () => {
    const rows: HunkRowLike[] = [{ tone: "added", afterLine: 1 }, ...unchangedRows(500, 2)];
    const collapsed = buildDisplaySegments(rows, new Set(), {}, "k");
    const gapKey = gaps(collapsed)[0].key;
    // Partially expanded first, then "show all" adds the remaining hidden
    // count on top of the existing expansion — exactly what the UI does.
    const partial = buildDisplaySegments(rows, new Set(), { [gapKey]: GAP_EXPAND_STEP }, "k");
    const segments = buildDisplaySegments(
      rows,
      new Set(),
      { [gapKey]: GAP_EXPAND_STEP + gaps(partial)[0].hiddenCount },
      "k",
    );
    expect(gaps(segments)).toHaveLength(0);
    expect(rowIndexes(segments)).toHaveLength(rows.length);
  });

  test("over-expansion clamps instead of producing negative gaps", () => {
    const rows = unchangedRows(30);
    const segments = buildDisplaySegments(rows, new Set(), { "k:0": 10_000 }, "k");
    expect(gaps(segments)).toHaveLength(0);
    expect(rowIndexes(segments)).toHaveLength(30);
  });

  test("gap keys embed the caller prefix so stale expansions cannot collide", () => {
    const rows = unchangedRows(100);
    const fromOtherFile = buildDisplaySegments(rows, new Set(), { "other:0": 50 }, "current");
    expect(gaps(fromOtherFile)[0].hiddenCount).toBe(100);
  });
});
