import { describe, expect, test } from "vitest";
import {
  PUBLIC_REPORT_POLL_INTERVAL_MS,
  publicReportPollDelay,
} from "../src/pages/PublicReport/polling";

describe("public report polling", () => {
  test("polls while the assistant review is pending", () => {
    expect(publicReportPollDelay({ aiReview: { status: "pending" } })).toBe(
      PUBLIC_REPORT_POLL_INTERVAL_MS,
    );
  });

  test("stops polling once the assistant review reaches a terminal state", () => {
    expect(publicReportPollDelay({ aiReview: { status: "complete" } })).toBeNull();
    expect(publicReportPollDelay({ aiReview: { status: "unavailable" } })).toBeNull();
    expect(publicReportPollDelay({ aiReview: null })).toBeNull();
  });
});
