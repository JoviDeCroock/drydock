import { describe, expect, test } from "vitest";
import {
  assistantFlagsRelease,
  reviewerSummaryVisible,
} from "../src/pages/Dashboard/ScanDetail/ReviewerSummary.tsx";
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

describe("assistantFlagsRelease", () => {
  const clean: DisplayedAiResult = {
    kind: "complete",
    model: "@cf/moonshotai/kimi-k2.7-code",
    summary: "Routine patch release.",
    risk: "low",
    releaseAssessment: "nothing_unusual",
    findings: [],
    requiresManualReview: false,
  };

  test("a clean reading does not hold the review notes open", () => {
    // The assistant runs by default, so its presence alone would open the
    // notes on every clean release.
    expect(assistantFlagsRelease(clean)).toBe(false);
  });

  test("a reading that flags the release opens them", () => {
    expect(assistantFlagsRelease({ ...clean, requiresManualReview: true })).toBe(true);
    expect(assistantFlagsRelease({ ...clean, releaseAssessment: "suspicious" })).toBe(true);
    expect(assistantFlagsRelease({ ...clean, releaseAssessment: "review_recommended" })).toBe(true);
  });

  test("an attempted review that could not complete opens them; a disabled one does not", () => {
    const unavailable: DisplayedAiResult = {
      kind: "unavailable",
      model: "@cf/moonshotai/kimi-k2.7-code",
      summary: "AI review failed; deterministic findings remain available.",
      status: "unavailable",
    };
    expect(assistantFlagsRelease(unavailable)).toBe(true);
    expect(assistantFlagsRelease({ ...unavailable, model: null })).toBe(false);
    expect(assistantFlagsRelease(null)).toBe(false);
  });
});
