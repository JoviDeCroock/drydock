import { describe, expect, test } from "vitest";
import { groupFindingsByRule } from "../src/lib/findings";

describe("groupFindingsByRule", () => {
  test("groups findings that share rule, severity, and wording", () => {
    const groups = groupFindingsByRule([
      {
        ruleId: "code.process-execution",
        severity: "low",
        evidence: "e",
        reason: "r",
        file: "test/a.js",
      },
      {
        ruleId: "code.process-execution",
        severity: "low",
        evidence: "e",
        reason: "r",
        file: "test/b.js",
      },
      {
        ruleId: "code.process-execution",
        severity: "low",
        evidence: "e",
        reason: "r",
        file: "test/c.js",
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((item) => item.file)).toEqual([
      "test/a.js",
      "test/b.js",
      "test/c.js",
    ]);
  });

  test("keeps findings apart when severity or wording differs", () => {
    const groups = groupFindingsByRule([
      { ruleId: "code.process-execution", severity: "high", evidence: "e", reason: "r" },
      { ruleId: "code.process-execution", severity: "low", evidence: "e", reason: "r" },
      { ruleId: "code.process-execution", severity: "low", evidence: "other", reason: "r" },
    ]);
    expect(groups).toHaveLength(3);
  });

  test("never groups findings without a rule id", () => {
    const groups = groupFindingsByRule([
      { ruleId: null, severity: "low", evidence: "e", reason: "r" },
      { ruleId: null, severity: "low", evidence: "e", reason: "r" },
    ]);
    expect(groups).toHaveLength(2);
  });

  test("preserves first-seen order of groups", () => {
    const groups = groupFindingsByRule([
      { ruleId: "b.rule", severity: "low", evidence: "e", reason: "r" },
      { ruleId: "a.rule", severity: "low", evidence: "e", reason: "r" },
      { ruleId: "b.rule", severity: "low", evidence: "e", reason: "r" },
    ]);
    expect(groups.map((group) => group.items[0].ruleId)).toEqual(["b.rule", "a.rule"]);
  });
});
