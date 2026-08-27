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
    expect(result.byScenario["hostile-evidence"].rate).toBe(1);
    expect(result.byScenario["missing-baseline"].rate).toBe(1);
    expect(result.byScenario["model-failover"].rate).toBe(1);
  });
});
