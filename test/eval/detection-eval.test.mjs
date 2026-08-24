import { describe, expect, test } from "vitest";
import { loadCorpus, runEval, writeReport } from "./harness.mjs";

// Frontier recall and evasion robustness are deliberately *reported* (written to
// the report), not asserted here — they start red and ratchet as detection
// improves. The benign hard-negative FP rate was promoted to a gated threshold
// once weighted multi-signal scoring (issue #193) brought it under the ratchet
// target. See docs/detection-eval.md for the threshold ladder.
const result = runEval();
writeReport(result);

describe("detection eval (gated thresholds)", () => {
  test("includes browser-extension golden cases", () => {
    const browserCases = loadCorpus().regression.filter((record) => record.ecosystem === "browser");
    expect(browserCases.length).toBeGreaterThan(0);
    expect(browserCases.some((record) => record.verdict === "benign")).toBe(true);
    expect(browserCases.some((record) => record.verdict === "malicious")).toBe(true);
  });

  test("malicious recall on the regression corpus does not regress", () => {
    expect(result.regression.malicious.recall).toBeGreaterThanOrEqual(0.9);
  });

  test("every critical-labeled regression case is caught", () => {
    expect(result.regression.critical.recall).toBe(1);
  });

  test("no false positives on benign regression controls", () => {
    expect(result.regression.benign.falsePositives).toBe(0);
  });

  // Ratchet from docs/detection-eval.md: weighted multi-signal scoring de-escalates
  // lone capabilities (a benign build script's child_process), so the benign
  // hard-negative roll-up FP rate now stays under 10%.
  test("benign hard-negative false-positive rate stays under the ratchet target", () => {
    expect(result.benignHardNegatives.fpRate).toBeLessThan(0.1);
  });
});
