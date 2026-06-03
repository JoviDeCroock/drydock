import { describe, expect, test } from "vitest";
import { verificationCallbackPath } from "../src/models/auth";

describe("verificationCallbackPath", () => {
  test("uses the plain verify page for the default dashboard return", () => {
    expect(verificationCallbackPath()).toBe("/verify-email");
    expect(verificationCallbackPath("/dashboard")).toBe("/verify-email");
  });

  test("preserves dashboard deep links as a verify return target", () => {
    expect(verificationCallbackPath("/dashboard/invite?token=abc123")).toBe(
      "/verify-email?returnTo=%2Fdashboard%2Finvite%3Ftoken%3Dabc123",
    );
  });
});
