import { describe, expect, test } from "vitest";
import { singleSidedTone } from "../src/components/DiffView";
import {
  publicReportDiffEntries,
  publicReportFindingItems,
  type PublicReportDiffEntry,
  type PublicReportFinding,
} from "../src/models/public-report";
import { findingCountsByPath } from "../src/features/review/diff-entries";

// The public report renders its diff from the canonical export alone, so these
// cover the two projections between that document and the shared review UI.
describe("publicReportDiffEntries", () => {
  test("carries sizes and hashes through to the diff meta row", () => {
    const [entry] = publicReportDiffEntries([
      {
        path: "dist/index.js",
        status: "modified",
        previousSize: 10,
        stagedSize: 20,
        previousSha256: "aa",
        stagedSha256: "bb",
        flags: ["truncated"],
      },
    ]);
    expect(entry).toEqual({
      path: "dist/index.js",
      status: "modified",
      previousSize: 10,
      stagedSize: 20,
      previousSha256: "aa",
      stagedSha256: "bb",
      flags: ["truncated"],
    });
  });

  test("a report exported before a field existed still renders a tree", () => {
    // Older `summary.diff` rows carry only path and status. Asserting the
    // optionals instead of defaulting them would blank the whole page.
    const entries = publicReportDiffEntries([
      { path: "package.json", status: "modified" },
    ] as PublicReportDiffEntry[]);
    expect(entries[0].flags).toEqual([]);
    expect(entries[0].stagedSize).toBeUndefined();
  });

  test("drops rows the tree could not address and unknown statuses", () => {
    const entries = publicReportDiffEntries([
      { path: "ok.js", status: "added" },
      { status: "added" } as unknown as PublicReportDiffEntry,
      { path: "weird.js", status: "renamed" },
    ]);
    expect(entries.map((entry) => [entry.path, entry.status])).toEqual([
      ["ok.js", "added"],
      ["weird.js", "unchanged"],
    ]);
  });

  test("a report with no diff is empty, not a crash", () => {
    expect(publicReportDiffEntries(null)).toEqual([]);
  });
});

describe("publicReportFindingItems", () => {
  const findings: PublicReportFinding[] = [
    {
      severity: "high",
      file: "install.js",
      line: 4,
      ruleId: "install-script.lifecycle",
      diffStatus: "added",
      releaseDelta: true,
      evidence: "postinstall",
      reason: "install hooks run on consumer machines",
    },
    {
      severity: "low",
      file: "install.js",
      line: null,
      ruleId: null,
      diffStatus: null,
      releaseDelta: null,
      evidence: "",
      reason: "pre-existing",
    },
  ];

  test("splits release deltas from package context", () => {
    const items = publicReportFindingItems(findings);
    expect(items.map((item) => item.releaseDelta)).toEqual([true, false]);
    // A report that never recorded a diff status must not claim one.
    expect(items[1].diffStatus).toBe("unknown");
  });

  test("gives every finding a distinct key, including duplicates of one rule", () => {
    const duplicated = [findings[0], findings[0]];
    const ids = publicReportFindingItems(duplicated).map((item) => item.finding.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("feeds the tree's per-file counts", () => {
    const counts = findingCountsByPath(publicReportFindingItems(findings));
    expect(counts.get("install.js")).toEqual({ count: 2, maxSeverity: "high" });
  });
});

// A public report shares the staged artifact and no baseline, so a `modified`
// file reaches DiffView with one side. Tinting it as an insertion would be a
// claim about the release that is wrong on every line it did not change.
describe("singleSidedTone", () => {
  test("a whole-file insertion or deletion keeps the tone that says so", () => {
    expect(singleSidedTone("added", "after")).toBe("added");
    expect(singleSidedTone("removed", "before")).toBe("removed");
  });

  test("a modified file with one available side renders neutral", () => {
    expect(singleSidedTone("modified", "after")).toBe("unchanged");
    expect(singleSidedTone("modified", "before")).toBe("unchanged");
  });

  test("the surviving side of an added or removed file is never mislabeled", () => {
    expect(singleSidedTone("added", "before")).toBe("unchanged");
    expect(singleSidedTone("removed", "after")).toBe("unchanged");
  });
});
