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
    expect(normalizeAuthReturnTo("/dashboardx", ORIGIN)).toBe("/dashboard");
  });

  test("returns a reader to the public diff they were reading", () => {
    expect(normalizeAuthReturnTo("/diff", ORIGIN)).toBe("/diff");
    expect(normalizeAuthReturnTo("/diff?ecosystem=pypi", ORIGIN)).toBe("/diff?ecosystem=pypi");
    expect(normalizeAuthReturnTo("/diff/@preact/signals/1.0.0/2.0.0", ORIGIN)).toBe(
      "/diff/@preact/signals/1.0.0/2.0.0",
    );
    expect(
      normalizeAuthReturnTo("/diff/react/19.0.0/https%3A%2F%2Fpkg.pr.new%2Freact%40abc", ORIGIN),
    ).toBe("/diff/react/19.0.0/https%3A%2F%2Fpkg.pr.new%2Freact%40abc");
    expect(normalizeAuthReturnTo(`${ORIGIN}/diff/pypi/requests`, ORIGIN)).toBe(
      "/diff/pypi/requests",
    );
  });

  test("refuses lookalike, off-origin, and smuggled diff targets", () => {
    for (const target of [
      "/diffx",
      "/diff-evil",
      "//evil.com",
      "//evil.com/diff",
      "/\\evil.com/diff",
      "\\evil.com",
      "/diff\\..\\..\\evil",
      "/diff//evil.com",
      "https://evil.com/diff",
      "javascript:alert(1)",
      "/reports/secret-token",
      "/diff/../reports/secret-token",
      "/diff/%2e%2e/reports/secret-token",
    ]) {
      expect(normalizeAuthReturnTo(target, ORIGIN), target).toBe("/dashboard");
    }
  });

  test("resolves dot segments before deciding", () => {
    expect(normalizeAuthReturnTo("/diff/../dashboard/settings", ORIGIN)).toBe(
      "/dashboard/settings",
    );
    expect(normalizeAuthReturnTo("/dashboard/../diff/react", ORIGIN)).toBe("/diff/react");
  });
});
