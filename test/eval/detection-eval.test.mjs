import { describe, expect, test } from "vitest";
import { runEval, writeReport } from "./harness.mjs";

// Frontier recall and evasion robustness are deliberately *reported* (written to
// the report), not asserted here — they start red and ratchet as detection
// improves. The benign hard-negative FP rate was promoted to a gated threshold
// once weighted multi-signal scoring (issue #193) brought it under the ratchet
// target. See docs/detection-eval.md for the threshold ladder.
const result = runEval();
writeReport(result);

describe("detection eval (gated thresholds)", () => {
  test("the gated corpus cannot silently shrink below its ecosystem coverage floor", () => {
    const regressionFloor = {
      npm: 30,
      pypi: 15,
      atpm: 6,
      vscode: 3,
    };
    for (const [ecosystem, minimum] of Object.entries(regressionFloor)) {
      expect(result.coverage.regressionByEcosystem[ecosystem]).toBeGreaterThanOrEqual(minimum);
    }
    expect(result.coverage.frontierByEcosystem.npm).toBeGreaterThanOrEqual(12);
    expect(result.coverage.benignByEcosystem.npm).toBeGreaterThanOrEqual(12);
    for (const samples of Object.values(result.coverage.evasionSamples)) {
      expect(samples).toBeGreaterThan(0);
    }
  });

  test("malicious recall on the regression corpus does not regress", () => {
    expect(result.regression.malicious.recall).toBeGreaterThanOrEqual(0.9);
  });

  test("every critical-labeled regression case is caught", () => {
    expect(result.regression.critical.recall).toBe(1);
  });

  test("keeps benign regression positives pinned to acknowledged cases", () => {
    expect(result.regression.benign.positives).toEqual([
      {
        id: "pypi-benign-docs-metadata-and-test-fixtures",
        threatClass: "control",
      },
    ]);
  });

  // Ratchet from docs/detection-eval.md: weighted multi-signal scoring de-escalates
  // lone capabilities (a benign build script's child_process), so the benign
  // hard-negative roll-up FP rate now stays under 10%.
  test("a payload spliced into an existing module still raises release risk", () => {
    // `npm-assembled-require-exfil` reads the environment through a computed
    // member of `process` (`globalThis['proc' + 'ess'][e]`), which the
    // credential rule now counts as a runtime-chosen key.
    expect(result.releaseInjection.lines.misses).toEqual([]);
    expect(result.releaseInjection.minified.misses).toEqual([]);
    expect(result.releaseInjection.lines.samples).toBeGreaterThanOrEqual(20);
    expect(result.releaseInjection.minified.samples).toBeGreaterThanOrEqual(20);
  });

  test("a payload spliced into a renamed bundler chunk still raises release risk", () => {
    // A renamed chunk is attributed against its predecessor like a modified
    // file, so it may miss only what a modified file misses: the same pinned
    // gap. The minified shape shares it because its padded carrier is a line
    // long enough for changed-span narrowing, unlike the short minified carrier.
    for (const shape of ["renamed", "renamed-minified"]) {
      const stats = result.releaseInjection[shape];
      expect(stats.samples).toBeGreaterThanOrEqual(20);
      expect(stats.paired).toBe(stats.samples);
      expect(stats.misses.map((miss) => miss.id)).toEqual(["npm-assembled-require-exfil"]);
    }
  });

  test("benign hard-negative false-positive rate stays under the ratchet target", () => {
    expect(result.benignHardNegatives.fpRate).toBeLessThan(0.1);
  });
});
