import { describe, expect, test } from "vitest";
import { singleSidedTone } from "../src/components/DiffView";
import type { DiffEntry } from "../server/lib/review";
import {
  initialReportPath,
  publicReportDiffEntries,
  publicReportFindingItems,
  verdictSummary,
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

describe("initialReportPath", () => {
  const entry = (path: string, status: DiffEntry["status"]): DiffEntry => ({
    path,
    status,
    flags: [],
  });
  const finding = (file: string, severity: string): PublicReportFinding => ({
    severity,
    file,
    line: 1,
    ruleId: "rule",
    diffStatus: "modified",
    releaseDelta: true,
    evidence: "",
    reason: "",
  });
  const entries = [
    entry("README.md", "modified"),
    entry("index.js", "modified"),
    entry("old.js", "removed"),
    entry("secrets.txt", "added"),
    entry("LICENSE", "unchanged"),
  ];

  test("opens on the changed file carrying the most severe finding", () => {
    expect(
      initialReportPath(entries, [
        finding("index.js", "medium"),
        finding("secrets.txt", "critical"),
      ]),
    ).toBe("secrets.txt");
  });

  test("never opens on a removed file, whose body the report does not carry", () => {
    expect(
      initialReportPath(entries, [finding("old.js", "critical"), finding("index.js", "low")]),
    ).toBe("index.js");
  });

  test("falls back to the first file with a staged body when no changed file has a finding", () => {
    expect(initialReportPath(entries, [finding("LICENSE", "high")])).toBe("README.md");
    expect(initialReportPath([entry("gone.js", "removed")], [])).toBe("gone.js");
    expect(initialReportPath([], [])).toBe(null);
  });
});

// The header names the version pair and the verdict card names the risk, so
// this sentence says only what was found — never "against its previous
// version", and never "0 pre-existing".
describe("verdictSummary", () => {
  const summary = (releaseFindingCount: number, contextFindingCount: number) => ({
    releaseRisk: "high",
    contextRisk: "low",
    releaseFindingCount,
    contextFindingCount,
  });

  test("counts release findings and leaves a zero pre-existing count out", () => {
    expect(verdictSummary(summary(1, 0))).toBe(
      "Deterministic review of the staged release — 1 release finding.",
    );
    expect(verdictSummary(summary(2, 3))).toBe(
      "Deterministic review of the staged release — 2 release findings, 3 pre-existing.",
    );
  });

  test("a clean release says so in words", () => {
    expect(verdictSummary(summary(0, 0))).toBe(
      "Deterministic review of the staged release — no release findings.",
    );
  });

  test("a report without a risk summary still reads as a sentence", () => {
    expect(verdictSummary(null)).toBe("Deterministic review of the staged release.");
  });
});
