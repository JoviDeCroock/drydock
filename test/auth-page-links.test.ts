import { describe, expect, test } from "vitest";
import { authPageHref } from "../src/pages/Auth/auth-links";

describe("authPageHref", () => {
  test("keeps the default destination implicit", () => {
    expect(authPageHref("/login", undefined)).toBe("/login");
    expect(authPageHref("/login", "/dashboard")).toBe("/login");
  });

  test("carries a sanitized destination to the next auth page", () => {
    expect(authPageHref("/login", "/dashboard/settings?tab=integrations")).toBe(
      "/login?returnTo=%2Fdashboard%2Fsettings%3Ftab%3Dintegrations",
    );
    expect(authPageHref("/forgot-password", "/dashboard/scans/s1?org=o1")).toBe(
      "/forgot-password?returnTo=%2Fdashboard%2Fscans%2Fs1%3Forg%3Do1",
    );
  });

  test("drops destinations sign-in may not return to", () => {
    expect(authPageHref("/register", "https://attacker.example/dashboard")).toBe("/register");
    expect(authPageHref("/login", "/docs")).toBe("/login");
  });
});
