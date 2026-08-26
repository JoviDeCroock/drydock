import { describe, expect, test } from "vitest";
import {
  evaluateVerdict,
  requiresListedReview,
  validatePolicy,
} from "../packages/verify/src/index.mjs";

const PAIR = { ecosystem: "npm", name: "@scope/tool", from: "1.0.0", to: "2.0.0" };
const VERDICT = {
  schema: "drydock.verdict.v1",
  grade: "notable",
  to: { version: "2.0.0", publishedAt: "2026-08-25T12:00:00.000Z" },
  capabilities: { escalations: ["network"], confident: true },
  diffUrl: "https://drydock.org/diff/@scope/tool/1.0.0/2.0.0",
};

describe("drydock verify policy", () => {
  test("rejects unknown policy keys so typos cannot weaken enforcement", () => {
    expect(() => validatePolicy({ maxGrades: "clear" })).toThrow(/unknown property/);
  });

  test("matches exact and wildcard listed-review requirements", () => {
    const policy = validatePolicy({ requireListedReview: ["left-pad", "@scope/*"] });
    expect(requiresListedReview(policy, "@scope/tool")).toBe(true);
    expect(requiresListedReview(policy, "@other/tool")).toBe(false);
  });

  test("evaluates grade, release age, capabilities, and listed review together", () => {
    const policy = validatePolicy({
      minReleaseAgeHours: 48,
      maxGrade: "clear",
      denyCapabilityEscalation: ["network"],
      requireListedReview: ["@scope/*"],
    });
    const result = evaluateVerdict(PAIR, VERDICT, policy, {
      now: Date.parse("2026-08-26T12:00:00.000Z"),
      listedReview: { schema: "drydock.review-lookup.v1", listed: false },
    });

    expect(result.violations).toEqual([
      "grade notable exceeds clear",
      "release age 24.0h is below 48h",
      "denied capability escalation: network",
      "a listed maintainer review is required",
    ]);
    expect(result.unavailable).toEqual([]);
  });

  test("does not call an incomplete capability delta proof of no escalation", () => {
    const policy = validatePolicy({ denyCapabilityEscalation: ["credentials"] });
    const result = evaluateVerdict(
      PAIR,
      { ...VERDICT, capabilities: { escalations: [], confident: false } },
      policy,
    );
    expect(result.unavailable).toEqual(["capability delta has incomplete coverage"]);
  });
});
