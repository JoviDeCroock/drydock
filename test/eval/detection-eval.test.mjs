import { describe, expect, test } from "vitest";
import { runEval, writeReport } from "./harness.mjs";

// Gated metrics only. Frontier recall and benign hard-negative FP rate are
// deliberately *reported* (written to the report), not asserted here — they
// start red and ratchet as detection improves. pushPastWindow survival is now
// gated (full-bytes scanning landed); the other evasion transforms stay
// reported. See docs/detection-eval.md for the threshold ladder.
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

  // Acceptance for the "scan full bytes, persist a bounded sample" refactor
  // (docs/detection-eval.md, issue #191). Detection scans the full pre-truncation
  // bytes, so prepending filler past the persisted sample window no longer slips
  // the payload past the regex scanners.
  test("pushPastWindow no longer slips payloads past the sample window", () => {
    const pushPastWindow = result.evasion.pushPastWindow;
    expect(pushPastWindow.samples).toBeGreaterThan(0);
    // block-slip -> 0%: every padded variant is still treated as risky.
    expect(pushPastWindow.blockedRate).toBe(1);
    // code-rule retention fully recovers: every original code.* rule re-fires.
    expect(pushPastWindow.codeRetention).toBe(1);
  });
});
