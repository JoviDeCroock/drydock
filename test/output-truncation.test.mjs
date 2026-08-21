import { describe, expect, it } from "vitest";
import { condenseFailureOutput } from "../scripts/lib/output-truncation.mjs";

function passingLines(count) {
  return Array.from({ length: count }, (_, i) => `✓ test/pass-${i}.test.ts (3 tests) 12ms`);
}

const failureSection = [
  "❯ test/broken.test.ts (4 tests | 1 failed)",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
  "FAIL test/broken.test.ts > computes the risk",
  "AssertionError: expected 'low' to be 'high'",
  "  at test/broken.test.ts:42:5",
  "Test Files  1 failed | 120 passed (121)",
  "Tests  1 failed | 900 passed (901)",
  "Duration  30.12s",
];

describe("condenseFailureOutput", () => {
  it("returns small output unchanged", () => {
    const output = [...passingLines(20), ...failureSection].join("\n");
    expect(condenseFailureOutput(output)).toBe(output);
  });

  it("elides the passing region of a large output but keeps head, failures, and summary", () => {
    const head = passingLines(1000);
    const output = [...head, ...failureSection].join("\n");
    const condensed = condenseFailureOutput(output);

    expect(condensed).not.toBe(output);
    // Head context survives.
    expect(condensed).toContain("✓ test/pass-0.test.ts");
    // Every failure-section line survives verbatim.
    for (const line of failureSection) expect(condensed).toContain(line);
    // The marker names the elided line count and the scoped rerun hint.
    expect(condensed).toMatch(
      /\[\.\.\. \d+ lines elided \(passing tests \/ noise\) — rerun scoped/,
    );
    // The cut keeps at least the last 250 lines (guaranteed tail), so the
    // elided region is total - tail floor - head.
    const totalLines = 1000 + failureSection.length;
    const elided = Number(/\[\.\.\. (\d+) lines elided/.exec(condensed)[1]);
    expect(elided).toBe(totalLines - 250 - 40);
    // Nothing after the first failure marker was dropped.
    const lines = condensed.split("\n");
    expect(lines.slice(-failureSection.length)).toEqual(failureSection);
  });

  it("keeps everything from the first failure-looking line even when scattered", () => {
    const early = passingLines(500);
    const noiseError = "Error: expected transient network failure (logged by a passing test)";
    const late = [...passingLines(400), ...failureSection];
    const output = [...early, noiseError, ...late].join("\n");
    const condensed = condenseFailureOutput(output);

    // The noise "Error:" line opens the kept region, so it and everything
    // after it — including all 400 later passing lines — survive.
    expect(condensed).toContain(noiseError);
    for (const line of failureSection) expect(condensed).toContain(line);
    expect(condensed.split("\n").length).toBeGreaterThan(400 + failureSection.length);
  });

  it("keeps a guaranteed tail when no failure marker matches", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `line ${i}`);
    const condensed = condenseFailureOutput(lines.join("\n"));
    expect(condensed).toContain("line 799");
    expect(condensed).toContain("line 0");
    // Last 250 lines are always preserved.
    for (let i = 800 - 250; i < 800; i += 1) {
      expect(condensed).toContain(`line ${i}`);
    }
    expect(condensed).toMatch(/lines elided/);
  });

  it("returns output unchanged when failures start too early to elide anything", () => {
    const output = ["FAIL immediately", ...passingLines(600)].join("\n");
    expect(condenseFailureOutput(output)).toBe(output);
  });

  it("threads a custom rerun hint into the marker", () => {
    const output = [...passingLines(1000), ...failureSection].join("\n");
    const condensed = condenseFailureOutput(output, {
      rerunHint: "rerun the failing check directly for full output: pnpm run lint",
    });
    expect(condensed).toContain("pnpm run lint");
  });

  it("is idempotent: a second pass over condensed output is a no-op", () => {
    const output = [...passingLines(1000), ...failureSection].join("\n");
    const once = condenseFailureOutput(output);
    expect(condenseFailureOutput(once)).toBe(once);
  });
});
