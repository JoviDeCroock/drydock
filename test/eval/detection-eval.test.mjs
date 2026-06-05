import { describe, expect, test } from "vitest";
import { runEval, writeReport } from "./harness.mjs";

// Gated metrics only. Frontier recall and evasion robustness are deliberately
// *reported* (written to the report), not asserted here — they start red and
// ratchet as detection improves. The benign hard-negative FP rate is the first
// ratchet step and is now gated (< 10%) since install-reachability weighting
// drove it to zero. See docs/detection-eval.md for the threshold ladder.
const result = runEval();
writeReport(result);

describe("detection eval (gated thresholds)", () => {
  test("malicious recall on the regression corpus does not regress", () => {
    expect(result.regression.malicious.recall).toBeGreaterThanOrEqual(0.9);
  });

  test("every critical-labeled regression case is caught", () => {
    expect(result.regression.critical.recall).toBe(1);
  });

  test("no false positives on benign regression controls", () => {
    expect(result.regression.benign.falsePositives).toBe(0);
  });

  test("benign hard-negative false-positive rate stays under 10%", () => {
    expect(result.benignHardNegatives.fpRate).toBeLessThan(0.1);
  });
});
