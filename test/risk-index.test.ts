import { describe, expect, test } from "vitest";
import {
  groupIndexRows,
  isShownInDiff,
  riskSignalCounts,
  unpinnedFindings,
} from "../src/features/review/risk-index";
import type { FindingWithDiffStatus } from "../src/features/review/types";
import { RELEASE_PROCESS_FINDING_FILE } from "../server/lib/release-fingerprint";

function item(
  id: string,
  overrides: Partial<FindingWithDiffStatus["finding"]> = {},
  releaseDelta = true,
): FindingWithDiffStatus {
  return {
    finding: {
      id,
      severity: "high",
      file: "index.js",
      line: 3,
      evidence: "evidence",
      reason: "reason",
      source: "rule",
      ...overrides,
    },
    diffStatus: releaseDelta ? "modified" : "unchanged",
    releaseDelta,
  };
}

describe("unpinnedFindings", () => {
  const diffPaths = new Set(["index.js", "dist/addon.node", "lib/old.js"]);

  test("drops a release finding the diff shows, on its line or in the file banner", () => {
    const shown = [item("pinned"), item("whole-file", { file: "dist/addon.node", line: null })];
    expect(unpinnedFindings(shown, diffPaths)).toEqual([]);
  });

  test("keeps everything the diff does not show, and context the notes do not list", () => {
    const kept = [
      item("context", {}, false),
      item("ai", { source: "ai" }),
      item("release-process", { file: RELEASE_PROCESS_FINDING_FILE }),
      item("outside-comparison", { file: "lib/other.js" }),
    ];
    expect(unpinnedFindings([item("pinned"), ...kept], diffPaths).map((x) => x.finding.id)).toEqual(
      kept.map((x) => x.finding.id),
    );
  });
});

describe("isShownInDiff", () => {
  test("counts a pre-existing finding on a changed file the diff annotates", () => {
    expect(isShownInDiff({ ...item("context", {}, false), diffStatus: "modified" })).toBe(true);
  });

  test("does not count unchanged files, unknown comparisons, or files off screen", () => {
    expect(isShownInDiff(item("context", {}, false))).toBe(false);
    expect(isShownInDiff({ ...item("skipped"), diffStatus: "unknown" })).toBe(false);
    expect(isShownInDiff(item("loading"), new Set())).toBe(false);
  });
});

describe("groupIndexRows", () => {
  const credential = { ruleId: "code.credential-access", severity: "medium", reason: "reads env" };

  test("states one reason above every location of the same rule, severity, and reason", () => {
    const groups = groupIndexRows([
      item("a", { ...credential, file: "colors.js", line: 3 }),
      item("b", { ...credential, file: "colors.mjs", line: 3 }),
      item("c", { ...credential, file: "index.js", line: 5 }),
      item("d", { ...credential, severity: "high", file: "index.mjs", line: 5 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ severity: "medium", reason: "reads env", note: null });
    expect(groups[0].locations.map(({ item: x }) => x.finding.file)).toEqual([
      "colors.js",
      "colors.mjs",
      "index.js",
    ]);
    expect(groups[1].locations.map(({ item: x }) => x.finding.id)).toEqual(["d"]);
  });

  test("never merges findings without a rule or with different reasons", () => {
    const groups = groupIndexRows([
      item("a", { ruleId: null }),
      item("b", { ruleId: null }),
      item("c", { ...credential }),
      item("d", { ...credential, reason: "reads a token file" }),
    ]);
    expect(groups.map((group) => group.locations.length)).toEqual([1, 1, 1, 1]);
  });

  test("hoists a note every location shares and keeps mixed notes per location", () => {
    const [shared] = groupIndexRows([item("a", credential, false), item("b", credential, false)]);
    expect(shared.note).toBe("pre-existing");
    expect(shared.locations.map((location) => location.note)).toEqual([null, null]);

    const [mixed] = groupIndexRows([item("a", credential), item("b", credential, false)]);
    expect(mixed.note).toBeNull();
    expect(mixed.locations.map((location) => location.note)).toEqual([null, "pre-existing"]);
  });

  test("leaves the reason to a card in the section that states it word for word", () => {
    const card = item("card", { ...credential, severity: "low", file: "test/a.js" }, false);
    const [group] = groupIndexRows([item("row", credential, false)], [card]);
    expect(group.reason).toBeNull();

    const [unstated] = groupIndexRows([item("row", credential)], [item("other", { reason: "x" })]);
    expect(unstated.reason).toBe("reads env");
  });
});

describe("riskSignalCounts", () => {
  test("counts release relevance, not changed-file placement", () => {
    const directory = { ...item("dir", { file: "package/", line: null }), diffStatus: "unknown" };
    expect(riskSignalCounts([item("manifest"), directory as FindingWithDiffStatus])).toBe(
      "2 release signals",
    );
    expect(riskSignalCounts([item("one"), item("ctx", {}, false), item("ctx2", {}, false)])).toBe(
      "1 release signal · 2 package context",
    );
    expect(riskSignalCounts([])).toBe("");
  });
});
