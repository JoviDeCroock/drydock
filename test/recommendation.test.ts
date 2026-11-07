import { describe, expect, test } from "vitest";
import { getReleaseRecommendation } from "../src/pages/Dashboard/recommendation";

describe("scan detail recommendation", () => {
  test("blocks when release risk is high even without deterministic release findings", () => {
    expect(getReleaseRecommendation("high", "high", 0)).toMatchObject({
      label: "block manual approval",
      tone: "high",
    });
  });

  test("shows context-only copy when artifact risk is not part of the release delta", () => {
    expect(getReleaseRecommendation("medium", "low", 0)).toMatchObject({
      label: "package context only",
      tone: "neutral",
      copy: "The changed files have no deterministic risk signals. Package context is summarized below.",
    });
  });

  test("scopes a low release delta when existing package findings still grade high", () => {
    for (const releaseFindingCount of [0, 1]) {
      const scoped = getReleaseRecommendation("high", "low", releaseFindingCount, {
        target: "gate",
        baselineVersion: "1.2.0-rc.1",
      });
      expect(scoped).toMatchObject({
        label: "low release-change risk against 1.2.0-rc.1",
        tone: "neutral",
        caveat: { text: "Existing high-risk package findings remain", tone: "high" },
      });
      expect(scoped.label).not.toMatch(/safe/);
    }
    expect(getReleaseRecommendation("critical", "info", 2).caveat?.text).toBe(
      "Existing critical-risk package findings remain",
    );
  });

  test("a decided gate reports the recorded result instead of asking for one", () => {
    const rejected = getReleaseRecommendation("high", "high", 1, {
      target: "gate",
      gateOutcome: "rejected",
    });
    expect(rejected.copy).not.toMatch(/Rejecting blocks|Do not approve/);
    expect(rejected.label).toBe("release blocked");
    expect(
      getReleaseRecommendation("high", "high", 1, {
        target: "gate",
        gateOutcome: "package-approved",
      }).label,
    ).toBe("high-risk package approved");
    expect(getReleaseRecommendation("high", "high", 1, { target: "gate" }).label).toBe(
      "block this release",
    );
    expect(rejected.copy).toContain(
      "Drydock told GitHub Actions not to run the configured protected publish job",
    );
    expect(
      getReleaseRecommendation("low", "low", 0, { target: "gate", gateOutcome: "approved" }).copy,
    ).not.toMatch(/Your decision releases or blocks/);
    // npm reviews have no gate to settle; the outcome never leaks into their copy.
    expect(
      getReleaseRecommendation("high", "high", 1, { gateOutcome: "rejected" }).copy,
    ).not.toMatch(/GitHub Actions/);
  });

  test("names the missing baseline instead of blocking or clearing the release", () => {
    // Nothing was compared, so the verdict must not read as "no risk signals in
    // the changed files" (there are no known changed files) nor as a block.
    const gate = getReleaseRecommendation("high", "low", 0, {
      target: "gate",
      baselineComparisonSkipped: true,
    });
    expect(gate).toMatchObject({ label: "no baseline to compare", tone: "medium" });
    expect(gate.copy).toContain("too large to download");
    expect(
      getReleaseRecommendation("high", "high", 3, { baselineComparisonSkipped: true }),
    ).toMatchObject({
      label: "no baseline to compare",
      tone: "medium",
    });
  });

  test("never sends the reader outside Drydock to resolve evidence", () => {
    expect(getReleaseRecommendation("high", "high", 1).copy).not.toMatch(/outside Drydock/);
  });

  test("a workflow gate speaks in job vocabulary, not npm's manual approval", () => {
    const gate = getReleaseRecommendation("critical", "critical", 2, { target: "gate" });
    expect(gate).toMatchObject({ label: "block this release", tone: "critical" });
    expect(gate.copy).toContain("blocks the configured protected publish job");
  });

  test("an already-published release is not told to hold back an approval", () => {
    const published = getReleaseRecommendation("high", "high", 1, { published: true });
    expect(published).toMatchObject({ label: "investigate published release", tone: "high" });
    expect(published.copy).not.toMatch(/staged publish|do not approve/i);
    expect(getReleaseRecommendation("low", "low", 0, { published: true }).copy).not.toMatch(
      /approves the publish in npm/,
    );
  });

  test("a first release with nothing to compare is neutral, never the green all-clear", () => {
    expect(getReleaseRecommendation("low", "low", 0, { firstRelease: true })).toMatchObject({
      label: "first release",
      tone: "neutral",
    });
    // Findings on a first release are still graded: a block stays a block.
    expect(getReleaseRecommendation("high", "high", 1, { firstRelease: true }).label).toBe(
      "block manual approval",
    );
  });
});
