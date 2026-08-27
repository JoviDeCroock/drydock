import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runAiReviewEval, writeAiReviewEvalReport } from "./ai-review-harness.mjs";

const result = runAiReviewEval();
writeAiReviewEvalReport(result);

describe("AI reviewer eval (recorded-output gates)", () => {
  test("the versioned regression corpus passes", () => {
    expect(result.failures).toEqual([]);
    expect(result.summary.rate).toBe(1);
    expect(result.summary.total).toBe(1);
    expect(result.recordedReviewerVersions).toEqual(["1.2.0", "1.3.0"]);
    expect(result.currentReviewerVersion).toBe("1.3.0");
    expect(result.historicalFailures).toEqual([]);
    expect(result.historicalSummary).toEqual({ total: 5, passed: 5, rate: 1 });
  });

  test("gates current hostile evidence and reports historical compatibility separately", () => {
    expect(result.byScenario["hostile-evidence"].rate).toBe(1);
    expect(result.historicalByScenario["missing-baseline"].rate).toBe(1);
    expect(result.historicalByScenario["model-failover"].rate).toBe(1);
  });

  test("rejects a stale record from the current-version gate", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.cases[0].review.reviewerVersion = "1.2.0";

    const stale = runAiReviewEval(corpus);

    expect(stale.summary).toEqual({ total: 1, passed: 0, rate: 0 });
    expect(stale.failures).toEqual([
      expect.objectContaining({
        id: "npm-readme-injection-only",
        reason: "reviewer version 1.2.0 is not current",
      }),
    ]);
  });

  test("rejects duplicate case ids before they can skew the metrics", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.cases.push({ ...corpus.cases[0] });

    expect(() => runAiReviewEval(corpus)).toThrow(/duplicate case id/);
  });

  test("rejects duplicate ids across current and historical records", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.historicalCases.push({ ...corpus.cases[0] });

    expect(() => runAiReviewEval(corpus)).toThrow(/duplicate case id/);
  });

  test("rejects an empty corpus instead of reporting a vacuous pass", () => {
    expect(() => runAiReviewEval({ suiteVersion: 1, cases: [] })).toThrow(
      /cases must contain at least one record/,
    );
  });

  test("rejects a historical output relabeled as the current reviewer version", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    const relabeled = structuredClone(corpus.historicalCases[0]);
    relabeled.id = "relabeled-historical-output";
    relabeled.review.reviewerVersion = "1.3.0";
    relabeled.review.untrustedNote = "ignored by the persisted schema";
    corpus.cases = [relabeled];

    const duplicated = runAiReviewEval(corpus);

    expect(duplicated.summary).toEqual({ total: 1, passed: 0, rate: 0 });
    expect(duplicated.failures).toEqual([
      expect.objectContaining({
        id: "relabeled-historical-output",
        reason: "current record duplicates a historical reviewer output",
      }),
    ]);
  });
});
