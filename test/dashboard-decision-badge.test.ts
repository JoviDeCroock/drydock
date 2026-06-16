import { describe, expect, test } from "vitest";
import { decisionBadgePresentation } from "../src/pages/Dashboard/decision-badge";

describe("decisionBadgePresentation", () => {
  test("prioritizes release mismatch over prior human decisions", () => {
    expect(
      decisionBadgePresentation({
        decision: "no_publish",
        releaseStatus: "released_mismatch",
      }),
    ).toEqual({ tone: "critical", label: "release mismatch" });

    expect(
      decisionBadgePresentation({
        decision: "publish",
        releaseStatus: "released_mismatch",
      }),
    ).toEqual({ tone: "critical", label: "release mismatch" });
  });
});
