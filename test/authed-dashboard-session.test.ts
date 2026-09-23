import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loginRedirectPath } from "../src/features/account/useAuthedDashboardSession";

const AUTHED_PAGES = [
  "Dashboard/index.tsx",
  "Dashboard/Settings/index.tsx",
  "Dashboard/Account/index.tsx",
  "Dashboard/PackageReleases/index.tsx",
  "Dashboard/ScanDetail/index.tsx",
];

function pageSource(page: string): string {
  return readFileSync(new URL(`../src/pages/${page}`, import.meta.url), "utf8");
}

describe("authenticated dashboard session guard", () => {
  test("sends a signed-out visitor to login with the page to come back to", () => {
    expect(loginRedirectPath("/dashboard/scans/abc?path=lib%2Findex.js")).toBe(
      "/login?returnTo=%2Fdashboard%2Fscans%2Fabc%3Fpath%3Dlib%252Findex.js",
    );
  });

  test.each(AUTHED_PAGES)("%s runs the shared guard and never redirects on its own", (page) => {
    const source = pageSource(page);
    expect(source).toContain("useAuthedDashboardSession(");
    // The five pages used to disagree on whether `/login` kept the return
    // destination; the shared hook is now the only place that redirect lives.
    expect(source).not.toContain('route("/login');
    expect(source).not.toContain("route(`/login");
    expect(source).not.toContain("sessionModel.load()");
  });

  test("a review page does not overwrite the list surface it was opened from", () => {
    expect(pageSource("Dashboard/ScanDetail/index.tsx")).toContain("rememberReturnUrl: false");
  });
});
