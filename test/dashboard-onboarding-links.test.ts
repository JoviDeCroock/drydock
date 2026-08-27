import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("../src/pages/Dashboard/GettingStarted.tsx", import.meta.url),
  "utf8",
);

describe("dashboard onboarding links", () => {
  test("opens the settings integrations tab for workflow-gate setup", () => {
    expect(source).toContain('href="/dashboard/settings?tab=integrations"');
    expect(source).not.toContain('href="/dashboard/settings#gate-setup"');
  });
});
