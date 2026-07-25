import { describe, expect, test } from "vitest";
import { releaseConsistencyVariant } from "../src/pages/Dashboard/ScanDetail/ReleaseConsistencyNotice";
import type { ReleaseConsistency } from "../server/lib/scan/release-memory";

function consistency(overrides: Partial<ReleaseConsistency>): ReleaseConsistency {
  return {
    status: "match",
    priorScanId: "prior-scan",
    priorVersion: "10.29.6",
    decidedAt: "2026-07-15T15:44:43.168Z",
    currentFindingCount: 2,
    priorFindingCount: 2,
    newFindingCount: 0,
    newFindings: [],
    ...overrides,
  };
}

describe("releaseConsistencyVariant", () => {
  test("none renders nothing", () => {
    expect(releaseConsistencyVariant(consistency({ status: "none" }))).toBeNull();
  });

  test("diverged stays diverged even with zero current findings", () => {
    expect(releaseConsistencyVariant(consistency({ status: "diverged" }))).toBe("diverged");
  });

  test("match with findings keeps the profile-match wording", () => {
    expect(releaseConsistencyVariant(consistency({ status: "match" }))).toBe("match");
  });

  test("subset with findings keeps the no-new-findings wording", () => {
    expect(
      releaseConsistencyVariant(
        consistency({ status: "subset", currentFindingCount: 1, priorFindingCount: 2 }),
      ),
    ).toBe("subset");
  });

  test("vacuous match (zero findings on both sides) gets the empty wording", () => {
    expect(
      releaseConsistencyVariant(
        consistency({ status: "match", currentFindingCount: 0, priorFindingCount: 0 }),
      ),
    ).toBe("empty");
  });

  test("subset that emptied out gets the empty wording", () => {
    expect(
      releaseConsistencyVariant(
        consistency({ status: "subset", currentFindingCount: 0, priorFindingCount: 3 }),
      ),
    ).toBe("empty");
  });
});
