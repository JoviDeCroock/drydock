import { describe, expect, test } from "vitest";
import { canOfferNpmStageFollowUp } from "../src/lib/npm-stage-follow-up";

describe("npm stage follow-up eligibility", () => {
  test.each([undefined, null, "staged", "validating"])(
    "allows a follow-up while the registry status is %s",
    (registryVersionStatus) => {
      expect(canOfferNpmStageFollowUp({ registryVersionStatus })).toBe(true);
    },
  );

  test.each(["published", "blocked", "deleted"])(
    "refuses a follow-up after npm reports the stage as %s",
    (registryVersionStatus) => {
      expect(canOfferNpmStageFollowUp({ registryVersionStatus })).toBe(false);
    },
  );

  test("refuses workflow gates and superseded stages", () => {
    expect(canOfferNpmStageFollowUp({ source: "workflow_gate" })).toBe(false);
    expect(
      canOfferNpmStageFollowUp({
        registryStatusSupersededAt: "2026-08-20T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});
