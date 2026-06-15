import { describe, expect, test } from "vitest";
import {
  currentAnalyticsHost,
  normalizeAnalyticsPath,
  POSTHOG_EU_HOST,
} from "../src/lib/analytics";

describe("product analytics", () => {
  test("uses the PostHog EU ingestion host", () => {
    expect(currentAnalyticsHost()).toBe(POSTHOG_EU_HOST);
    expect(POSTHOG_EU_HOST).toBe("https://eu.i.posthog.com");
  });

  test("normalizes pageview paths without leaking origins", () => {
    expect(normalizeAnalyticsPath("https://drydock.org/dashboard?filter=all")).toBe(
      "/dashboard?filter=all",
    );
  });
});
