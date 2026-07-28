import { describe, expect, test } from "vitest";
import { reviewerSummaryVisible } from "../src/pages/Dashboard/ScanDetail/ReviewerSummary.tsx";
import type { DisplayedAiResult } from "../server/lib/ai-review/types";

// The AI narrative moved from the bottom-of-page "Reviewer notes" section to
// `ReviewerSummary`, directly under the Recommendation. These assert the move
// preserved the old section's visibility rule exactly — including the case that
// matters most, where the reviewer was attempted and did not complete.
describe("reviewerSummaryVisible", () => {
  const complete: DisplayedAiResult = {
    kind: "complete",
    model: "@cf/moonshotai/kimi-k2.7-code",
    summary: "Routine patch release.",
    risk: "low",
    releaseAssessment: "nothing_unusual",
    findings: [],
    requiresManualReview: false,
  };

  test("renders a completed review", () => {
    expect(reviewerSummaryVisible(complete)).toBe(true);
  });

  test("renders an attempted-but-failed review", () => {
    // Load-bearing: computeScanRisk floors this scan at medium, so the page must
    // show that the reviewer was unavailable rather than silently omitting it.
    expect(
      reviewerSummaryVisible({
        kind: "unavailable",
        model: "@cf/moonshotai/kimi-k2.7-code",
        summary: "AI review failed; deterministic findings remain available.",
        status: "unavailable",
      }),
    ).toBe(true);
  });

  test("renders nothing when the reviewer is switched off (null model)", () => {
    expect(
      reviewerSummaryVisible({
        kind: "unavailable",
        model: null,
        summary: "AI review is disabled.",
        status: "unavailable",
      }),
    ).toBe(false);
  });

  test("renders nothing when there is no review at all", () => {
    expect(reviewerSummaryVisible(null)).toBe(false);
  });
});
