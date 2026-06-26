import { describe, expect, test } from "vitest";
import {
  normalizedVerificationCallbackURL,
  verificationCallbackRequest,
} from "../server/lib/auth-callback";
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

describe("normalizedVerificationCallbackURL", () => {
  const origin = "https://drydock.org";

  test("keeps the app-owned verification callback", () => {
    expect(normalizedVerificationCallbackURL("/verify-email", origin)).toBe("/verify-email");
    expect(
      normalizedVerificationCallbackURL(
        "/verify-email?returnTo=%2Fdashboard%2Finvite%3Ftoken%3Dabc123",
        origin,
      ),
    ).toBe("/verify-email?returnTo=%2Fdashboard%2Finvite%3Ftoken%3Dabc123");
  });

  test("clamps protocol-relative and malformed callbacks", () => {
    expect(normalizedVerificationCallbackURL("//verify-email", origin)).toBe("/verify-email");
    expect(normalizedVerificationCallbackURL("c", origin)).toBe("/verify-email");
    expect(normalizedVerificationCallbackURL("/\\c", origin)).toBe("/verify-email");
  });

  test("clamps other same-origin and external callbacks", () => {
    expect(normalizedVerificationCallbackURL("/", origin)).toBe("/verify-email");
    expect(normalizedVerificationCallbackURL("/dashboard", origin)).toBe("/verify-email");
    expect(normalizedVerificationCallbackURL("https://example.com/verify-email", origin)).toBe(
      "/verify-email",
    );
  });
});

describe("verificationCallbackRequest", () => {
  test("rewrites malformed verify-email callbackURL before Better Auth handles it", () => {
    const request = new Request(
      "https://drydock.org/api/auth/verify-email?token=abc&callbackURL=%2F%2Fverify-email",
    );

    expect(new URL(verificationCallbackRequest(request).url).searchParams.get("callbackURL")).toBe(
      "/verify-email",
    );
  });

  test("leaves non-verification auth requests untouched", () => {
    const request = new Request("https://drydock.org/api/auth/session?callbackURL=c");
    expect(verificationCallbackRequest(request)).toBe(request);
  });
});
