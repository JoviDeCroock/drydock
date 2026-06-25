import { describe, expect, test } from "vitest";
import { normalizeAuthReturnTo } from "../src/lib/auth-return";

const ORIGIN = "https://drydock.example";

describe("normalizeAuthReturnTo", () => {
  test("preserves dashboard callback paths with query strings", () => {
    expect(
      normalizeAuthReturnTo(
        "/dashboard/settings/github-app/callback?state=abc&code=def&installation_id=123",
        ORIGIN,
      ),
    ).toBe("/dashboard/settings/github-app/callback?state=abc&code=def&installation_id=123");
  });

  test("allows same-origin absolute dashboard urls", () => {
    expect(normalizeAuthReturnTo(`${ORIGIN}/dashboard?filter=all`, ORIGIN)).toBe(
      "/dashboard?filter=all",
    );
  });

  test("preserves scan detail paths with query strings", () => {
    expect(normalizeAuthReturnTo("/dashboard/scans/scan_1?path=src%2Findex.ts", ORIGIN)).toBe(
      "/dashboard/scans/scan_1?path=src%2Findex.ts",
    );
  });

  test("falls back for non-dashboard, cross-origin, or malformed targets", () => {
    expect(normalizeAuthReturnTo("/login?returnTo=/dashboard", ORIGIN)).toBe("/dashboard");
    expect(normalizeAuthReturnTo("https://attacker.example/dashboard", ORIGIN)).toBe("/dashboard");
    expect(normalizeAuthReturnTo("http://[", ORIGIN)).toBe("/dashboard");
  });
});
