import { describe, expect, test } from "vitest";
import type { SharedScanRow } from "../server/db/scan-share";
import { buildBadgePayload, buildThreatFeedEntry } from "../server/lib/public-feed";

function row(overrides: Partial<SharedScanRow> = {}): SharedScanRow {
  return {
    scanId: "scan_1",
    organizationId: "org_1",
    registryVersion: "3.0.0",
    source: "auto_discovery",
    packageName: "docula",
    stagedVersion: "3.0.0",
    previousVersion: "2.2.0",
    risk: "low",
    decision: "publish",
    findingCount: 0,
    riskSummaryJson: { releaseRisk: "low" },
    summaryJson: { stagedPublish: { tag: "latest" } },
    publicShareToken: "token",
    publicFeedListedAt: new Date(0),
    completedAt: new Date(0),
    ...overrides,
  };
}

describe("badge payload", () => {
  test("a superseded review answers about the release a consumer would install", () => {
    expect(buildBadgePayload(row(), "latest", "3.0.1")).toMatchObject({
      label: "drydock",
      message: "3.0.1 not reviewed",
      color: "lightgrey",
    });
  });

  // The pick is no longer what the badge reports, so its identity qualifier
  // would describe a review this payload does not speak for.
  test("a superseded badge carries no identity qualifier", () => {
    expect(buildBadgePayload(row({ source: "workflow_gate" }), "latest", "3.0.1").label).toBe(
      "drydock",
    );
    expect(buildBadgePayload(row({ source: "workflow_gate" }), "beta", "3.0.1").label).toBe(
      "drydock (beta)",
    );
  });

  test("the superseding version is clamped and sanitized like any other", () => {
    expect(buildBadgePayload(row(), "latest", `3.0.1‮gnp`).message).toBe("3.0.1gnp not reviewed");
    expect(buildBadgePayload(row(), "latest", "9".repeat(80)).message).toBe(
      `${"9".repeat(64)}… not reviewed`,
    );
  });

  test("no supersession leaves the quoted review untouched", () => {
    expect(buildBadgePayload(row(), "latest", null).message).toBe("3.0.0 approved");
  });

  // `SharedScanRow` carries the owning organization so the badge's staleness
  // probe can scope itself; neither anonymous surface may ever serialize it.
  test("public surfaces never serialize the organization", () => {
    expect(Object.keys(buildBadgePayload(row(), "latest", "3.0.1"))).not.toContain(
      "organizationId",
    );
    const entry = buildThreatFeedEntry(row(), "https://drydock.org");
    expect(Object.keys(entry)).not.toContain("organizationId");
    expect(JSON.stringify(entry)).not.toContain("org_1");
  });
});
