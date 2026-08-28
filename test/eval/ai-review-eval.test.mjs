import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AI_REVIEWER_VERSION } from "../../server/lib/ai-review/contract.ts";
import { runAiReviewEval, writeAiReviewEvalReport } from "./ai-review-harness.mjs";

const result = runAiReviewEval();
writeAiReviewEvalReport(result);

describe("AI reviewer eval (historical recorded-output scoring)", () => {
  test("the versioned regression corpus passes", () => {
    expect(result.failures).toEqual([]);
    expect(result.summary.rate).toBe(1);
    expect(result.recordedReviewerVersion).toBe("1.2.0");
    expect(result.currentReviewerVersion).toBe(AI_REVIEWER_VERSION);
    expect(result.currentContractRecorded).toBe(false);
  });

  test("covers hostile evidence, missing evidence, and model failover", () => {
    expect(result.byVerdict.malicious.total).toBeGreaterThanOrEqual(3);
    expect(result.byVerdict.benign.total).toBeGreaterThanOrEqual(1);
    expect(result.byVerdict.uncertain.total).toBeGreaterThanOrEqual(1);
    expect(result.byScenario["hostile-evidence"].rate).toBe(1);
    expect(result.byScenario["missing-baseline"].rate).toBe(1);
    expect(result.byScenario["model-failover"].rate).toBe(1);
  });

  test("rejects duplicate case ids before they can skew the metrics", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.cases.push({ ...corpus.cases[0] });

    expect(() => runAiReviewEval(corpus)).toThrow(/duplicate case id/);
  });

  test("rejects an empty corpus instead of reporting a vacuous pass", () => {
    expect(() => runAiReviewEval({ suiteVersion: 1, cases: [] })).toThrow(
      /cases must contain at least one record/,
    );
  });
});
