import { describe, expect, test } from "vitest";
import {
  dependencyReviewPath,
  pullRequestUrl,
  reviewState,
} from "../src/features/dependency-review/wording";
import { parseBotLoginsInput } from "../src/models/dependency-review";

describe("dependency review addresses", () => {
  test("a review link names its organization like the check run's details link", () => {
    expect(dependencyReviewPath("dr_1", "org 1")).toBe(
      "/dashboard/dependency-reviews/dr_1?org=org%201",
    );
    expect(dependencyReviewPath("a/b")).toBe("/dashboard/dependency-reviews/a%2Fb");
  });

  test("a pull request link stays on github.com", () => {
    expect(pullRequestUrl("acme/web", 12)).toBe("https://github.com/acme/web/pull/12");
    expect(pullRequestUrl("acme/../evil", 1)).toBeNull();
    expect(pullRequestUrl("javascript:alert(1)", 1)).toBeNull();
    expect(pullRequestUrl("acme/we b?x", 1)).toBe("https://github.com/acme/we%20b%3Fx/pull/1");
  });
});

describe("dependency review state", () => {
  test("reads in-flight, failed, and settled reviews", () => {
    expect(reviewState({ status: "queued", conclusion: null })).toBe("reviewing");
    expect(reviewState({ status: "running", conclusion: null })).toBe("reviewing");
    expect(reviewState({ status: "failed", conclusion: null })).toBe("failed");
    expect(reviewState({ status: "completed", conclusion: "held" })).toBe("held");
    expect(reviewState({ status: "completed", conclusion: "approved" })).toBe("approved");
  });

  test("splits typed bot logins on commas and whitespace", () => {
    expect(parseBotLoginsInput(" my-renovate[bot], other-bot\nthird ")).toEqual([
      "my-renovate[bot]",
      "other-bot",
      "third",
    ]);
    expect(parseBotLoginsInput("")).toEqual([]);
  });
});
