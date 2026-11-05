import { describe, expect, test } from "vitest";
import type { PublisherSetupStatus } from "../server/lib/github-app/setup-types";
import { setupStatusAgentSummary } from "../src/features/publisher-setup/agent-summary";

const checks: PublisherSetupStatus["checks"] = [
  { label: "Release target", status: "passed", detail: "Mapped." },
  { label: "Administrator bypass", status: "passed", detail: "Disabled." },
  { label: "First release review", status: "pending", detail: "Run a real release." },
];

function status(overrides: Partial<PublisherSetupStatus> = {}): PublisherSetupStatus {
  return {
    repositoryFullName: "example/package",
    environment: "production",
    targetMapped: true,
    environmentExists: true,
    protectionEnabled: true,
    administratorsCanBypass: false,
    firstReview: null,
    checks,
    ...overrides,
  };
}

const completedReview: PublisherSetupStatus["firstReview"] = {
  gateId: "gate-secret-id",
  scanId: "scan-secret-id",
  status: "rejected",
  scanStatus: "complete",
  requestedAt: "2026-11-05T00:00:00.000Z",
  completedAt: "2026-11-05T00:01:00.000Z",
};

describe("setup status agent summary", () => {
  test("lists every check and reports a configured setup as pending its first release", () => {
    expect(setupStatusAgentSummary(status())).toBe(
      [
        "Drydock setup checks for example/package, environment production",
        "2 of 3 passed.",
        "",
        "- Release target: passed. Mapped.",
        "- Administrator bypass: passed. Disabled.",
        "- First release review: pending. Run a real release.",
        "",
        "Configuration checks pass. Report setup as ready, pending first release, until a real release completes review.",
      ].join("\n"),
    );
  });

  test.each([
    ["no release target", { targetMapped: false }],
    ["no environment", { environmentExists: false }],
    ["no protection rule", { protectionEnabled: false }],
    ["administrators can bypass", { administratorsCanBypass: true }],
    ["bypass unknown", { administratorsCanBypass: null }],
  ] as const)("is not ready with %s, even after a completed review", (_name, overrides) => {
    const summary = setupStatusAgentSummary(status({ ...overrides, firstReview: completedReview }));

    expect(summary).toContain("Not ready");
    expect(summary).not.toContain("ready, pending first release");
  });

  test("a completed review asks for confirmation instead of declaring setup complete", () => {
    const summary = setupStatusAgentSummary(status({ firstReview: completedReview }));

    expect(summary).toContain("Confirm it was a real release, not a test run");
    expect(summary).not.toMatch(/setup is complete/i);
    expect(summary).not.toContain("secret-id");
  });
});
