import { describe, expect, test } from "vitest";
import { filterDiffEntries, findingCountsByPath } from "../src/features/review/diff-entries.ts";

describe("findingCountsByPath", () => {
  const item = (file, severity) => ({
    finding: { id: `${file}:${severity}`, file, severity },
    diffStatus: "modified",
    releaseDelta: true,
  });

  test("counts findings per file path and keeps the highest severity", () => {
    const counts = findingCountsByPath([
      item("lib/a.js", "low"),
      item("lib/a.js", "critical"),
      item("lib/a.js", "medium"),
      item("b.js", "info"),
    ]);
    expect(counts.get("lib/a.js")).toEqual({ count: 3, maxSeverity: "critical" });
    expect(counts.get("b.js")).toEqual({ count: 1, maxSeverity: "info" });
  });

  test("returns an empty map for no findings", () => {
    expect(findingCountsByPath([]).size).toBe(0);
  });
});

describe("filterDiffEntries", () => {
  const entries = [
    { path: "z.js", status: "unchanged" },
    { path: "a.js", status: "added" },
    { path: "m.js", status: "modified" },
    { path: "b.js", status: "added" },
  ];

  test("drops unchanged entries and sorts by status rank then path", () => {
    const out = filterDiffEntries(entries, "", true).map((e) => e.path);
    expect(out).toEqual(["a.js", "b.js", "m.js"]);
  });

  test("keeps unchanged entries when changedOnly is false", () => {
    const out = filterDiffEntries(entries, "", false).map((e) => e.path);
    expect(out).toEqual(["a.js", "b.js", "m.js", "z.js"]);
  });

  test("filters by case-insensitive path substring", () => {
    const out = filterDiffEntries(entries, "M", true).map((e) => e.path);
    expect(out).toEqual(["m.js"]);
  });
});
