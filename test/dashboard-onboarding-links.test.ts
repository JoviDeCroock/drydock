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
      "await Promise.all([scans.refresh(), npm.load(), overview.refresh()]);",
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

  test("does not treat every created scan as a completed review", () => {
    expect(gettingStartedSource).not.toContain("has been reviewed for this organization");
    expect(gettingStartedSource).toContain("has reached Drydock for review");
  });

  test("leads with the step that needs no token and no staged release", () => {
    const firstStep = gettingStartedSource.indexOf("Review one of your published packages");
    const tokenStep = gettingStartedSource.indexOf("Connect npm to watch staged releases");
    expect(firstStep).toBeGreaterThan(-1);
    expect(tokenStep).toBeGreaterThan(firstStep);
    // The token step is an option, not a gate on reaching a first review.
    expect(gettingStartedSource).toContain("Optional, and only for reviewing a release");
  });

  test("starts a persisted review rather than an anonymous diff", () => {
    expect(gettingStartedSource).toContain("PublishedReviewModel");
    expect(gettingStartedSource).toContain("/dashboard/scans/");
    expect(gettingStartedSource).not.toContain("resolveSuggestedDiffPath");
  });

  test("says what is missing instead of only disabling Check npm", () => {
    expect(dashboardSource).toContain(
      "Checking npm for staged releases needs a validated npm token.",
    );
    expect(dashboardSource).not.toContain(
      "Connect a validated npm token in Settings → Integrations first",
    );
  });

  test("offers the signed-in save action on /diff without touching the anonymous view", () => {
    expect(diffSource).toContain("<SaveReviewAction spec={spec} />");
    expect(diffSource).toContain("<Show when={authed}>");
  });

  test("does not personalize onboarding around an npm public diff", () => {
    expect(gettingStartedSource).not.toContain("onboarding-intent");
    expect(gettingStartedSource).not.toContain("You were reading the diff for");
    expect(diffSource).not.toContain("rememberOnboardingIntent");
  });
});
