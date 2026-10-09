import { describe, expect, test } from "vitest";
import {
  normalizeAuthReturnTo,
  passwordResetPagePath,
  passwordResetPageReturnTo,
} from "../src/lib/auth-return";

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

describe("password reset page returnTo", () => {
  test("leaves the default destination off the reset page", () => {
    expect(passwordResetPagePath(undefined, ORIGIN)).toBe("/reset-password");
    expect(passwordResetPagePath("/dashboard", ORIGIN)).toBe("/reset-password");
    expect(passwordResetPagePath("https://evil.example/dashboard", ORIGIN)).toBe("/reset-password");
  });

  test("keeps the view parameters a page reads from its address", () => {
    expect(
      passwordResetPagePath("/dashboard/scans/s1?org=o1&file=a.js&changedOnly=1&version=2", ORIGIN),
    ).toBe(
      "/reset-password?returnTo=%2Fdashboard%2Fscans%2Fs1%3Forg%3Do1%26file%3Da.js%26changedOnly%3D1%26version%3D2",
    );
  });

  test("mails only plain navigation, never a destination that acts on arrival", () => {
    for (const target of [
      "/dashboard/invite?token=invite-secret",
      "/dashboard/invite?%74oken=invite-secret",
      "/dashboard/invite?TOKEN=invite-secret",
      "/dashboard/settings/github-app/callback?state=s&code=c&installation_id=1",
      "/dashboard?code=c",
      "/dashboard/settings?tab=integrations&slack=error&slackError=Your%20account%20is%20locked",
      "/dashboard?org=o1&unknown=1",
      "/diff/react#token=t",
      "/diff/react#/x?token=t",
      "/reports/share-token",
    ]) {
      expect(passwordResetPagePath(target, ORIGIN), target).toBe("/reset-password");
    }
  });

  test("drops a destination too long for one mail line", () => {
    expect(passwordResetPagePath(`/diff/${"a".repeat(700)}`, ORIGIN)).toMatch(
      /^\/reset-password\?/,
    );
    expect(passwordResetPagePath(`/diff/${"a".repeat(760)}`, ORIGIN)).toBe("/reset-password");
  });

  test("encodes the query to the characters Better Auth accepts in a relative redirectTo", () => {
    const path = passwordResetPagePath("/diff/(legacy)/1.0.0~1/2.0.0!?path=*", ORIGIN);
    expect(path).toMatch(/^\/reset-password\?returnTo=[\w\-.+/=&%@]*$/);
  });

  test("reads back exactly the destination it carried, once decoded", () => {
    for (const target of [
      "/dashboard/scans/s1?org=o1&path=src%2Findex.ts",
      "/diff/react/19.0.0/https%3A%2F%2Fpkg.pr.new%2Freact%40abc",
      "/diff/(legacy)/1.0.0~1/2.0.0!",
      "/dashboard/settings?tab=integrations#github-app",
    ]) {
      expect(passwordResetPageReturnTo(passwordResetPagePath(target, ORIGIN), ORIGIN), target).toBe(
        target,
      );
    }
  });

  test("ignores a returnTo that rides on anything but this origin's reset page", () => {
    for (const page of [
      "/login?returnTo=%2Fdiff%2Freact",
      "/reset-password/../login?returnTo=%2Fdiff%2Freact",
      "https://evil.example/reset-password?returnTo=%2Fdiff%2Freact",
      "//evil.example/reset-password?returnTo=%2Fdiff%2Freact",
      "/\\evil.example/reset-password?returnTo=%2Fdiff%2Freact",
      null,
    ]) {
      expect(passwordResetPageReturnTo(page, ORIGIN), String(page)).toBe("/dashboard");
    }
  });

  test("sanitizes the carried destination again instead of trusting the page", () => {
    for (const returnTo of [
      "https://evil.example/dashboard",
      "//evil.example",
      "/dashboard/invite?token=invite-secret",
      "/diff/%2e%2e/reports/share-token",
      "%2Fdiff%2Freact",
    ]) {
      const page = `/reset-password?returnTo=${encodeURIComponent(returnTo)}`;
      expect(passwordResetPageReturnTo(page, ORIGIN), returnTo).toBe("/dashboard");
    }
  });
});
