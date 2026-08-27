import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const gettingStartedSource = readFileSync(
  new URL("../src/pages/Dashboard/GettingStarted.tsx", import.meta.url),
  "utf8",
);
const dashboardSource = readFileSync(
  new URL("../src/pages/Dashboard/index.tsx", import.meta.url),
  "utf8",
);
const diffSource = readFileSync(new URL("../src/pages/Diff/index.tsx", import.meta.url), "utf8");

describe("dashboard onboarding contracts", () => {
  test("resolves the active organization before organization-scoped startup requests", () => {
    const organizationLoad = dashboardSource.indexOf("await organizations.load();");
    const organizationScopedLoads = dashboardSource.indexOf(
      "await Promise.all([scans.refresh(), npm.load()]);",
    );

    expect(organizationLoad).toBeGreaterThan(-1);
    expect(organizationScopedLoads).toBeGreaterThan(organizationLoad);
  });

  test("opens the settings integrations tab for workflow-gate setup", () => {
    expect(gettingStartedSource).toContain('href="/dashboard/settings?tab=integrations"');
    expect(gettingStartedSource).not.toContain('href="/dashboard/settings#gate-setup"');
  });

  test("does not treat a recorded decision as proof that npm published the release", () => {
    expect(gettingStartedSource).not.toContain("published on your terms");
    expect(gettingStartedSource).toContain("with the decision still in your hands");
    expect(gettingStartedSource).toContain("An npm approval still needs your own");
  });

  test("does not personalize onboarding around an npm public diff", () => {
    expect(gettingStartedSource).not.toContain("onboarding-intent");
    expect(gettingStartedSource).not.toContain("You were reading the diff for");
    expect(diffSource).not.toContain("rememberOnboardingIntent");
  });
});
