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
    expect(getReleaseRecommendation("high", "low", 0)).toMatchObject({
      label: "package context only",
      tone: "neutral",
      copy: "The changed files have no deterministic risk signals. Package context is summarized below.",
    });
  });

  test("names the missing baseline instead of blocking or clearing the release", () => {
    // Nothing was compared, so the verdict must not read as "no risk signals in
    // the changed files" (there are no known changed files) nor as a block.
    const gate = getReleaseRecommendation("high", "low", 0, "gate", "baseline-too-large");
    expect(gate).toMatchObject({ label: "no baseline to compare", tone: "medium" });
    expect(gate.copy).toContain("too large to download");
    expect(getReleaseRecommendation("high", "high", 3, "npm", "baseline-too-large")).toMatchObject({
      label: "no baseline to compare",
      tone: "medium",
    });
  });

  test("distinguishes an unavailable baseline from an oversized one", () => {
    const result = getReleaseRecommendation("high", "low", 0, "gate", "baseline-unavailable");
    expect(result).toMatchObject({ label: "no baseline to compare", tone: "medium" });
    expect(result.copy).toContain("No trustworthy published baseline was available");
    expect(result.copy).not.toContain("too large");
  });
});
