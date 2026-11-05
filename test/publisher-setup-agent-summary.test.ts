import { describe, expect, test } from "vitest";
import type { PublisherSetupStatus } from "../server/lib/github-app/setup-types";
import { setupStatusAgentSummary } from "../src/features/publisher-setup/agent-summary";

function status(checks: PublisherSetupStatus["checks"]): PublisherSetupStatus {
  return {
    repositoryFullName: "example/package",
    environment: "production",
    targetMapped: true,
    environmentExists: true,
    protectionEnabled: true,
    administratorsCanBypass: null,
    firstReview: {
      gateId: "gate-secret-id",
      scanId: "scan-secret-id",
      status: "pending",
      scanStatus: "pending",
      requestedAt: "2026-11-05T00:00:00.000Z",
      completedAt: null,
    },
    checks,
  };
}

describe("setup status agent summary", () => {
  test("lists every check and keeps an unfinished setup pending", () => {
    const summary = setupStatusAgentSummary(
      status([
        { label: "Release target", status: "passed", detail: "Mapped." },
        { label: "Administrator bypass", status: "unknown", detail: "Not reported." },
        { label: "First release review", status: "pending", detail: "Run a real release." },
      ]),
    );

    expect(summary).toBe(
      [
        "Drydock setup checks for example/package, environment production",
        "1 of 3 passed.",
        "",
        "- Release target: passed. Mapped.",
        "- Administrator bypass: unknown. Not reported.",
        "- First release review: pending. Run a real release.",
        "",
        "Setup is not complete. Report it as ready, pending first release, until every check passes.",
      ].join("\n"),
    );
  });

  test("reports completion only when every check passed and omits internal ids", () => {
    const summary = setupStatusAgentSummary(
      status([
        { label: "Release target", status: "passed", detail: "Mapped." },
        { label: "First release review", status: "passed", detail: "Reviewed." },
      ]),
    );

    expect(summary).toContain("2 of 2 passed.");
    expect(summary).toContain("Setup is complete");
    expect(summary).not.toContain("secret-id");
  });
});
