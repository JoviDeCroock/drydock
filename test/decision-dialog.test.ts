import { describe, expect, test } from "vitest";
import { decisionSubmissionReachedVerdict } from "../src/pages/Dashboard/ScanDetail/DecisionDialog";
import type { PersistedScanDetail, ScanDecision } from "../src/models/scan";

function result(verdict: ScanDecision | null, approvedCount: number): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "pkg",
      stagedVersion: "1.0.0",
      previousVersion: "0.9.0",
      risk: "low",
      status: "complete",
      decision: verdict,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    approvals: {
      required: 2,
      approvedCount,
      blockedCount: verdict === "no_publish" ? 1 : 0,
      verdict,
      approvals: [],
      viewerDecision: verdict ?? "publish",
      eligibleApproverCount: 2,
    },
    files: [],
    findings: [],
    events: [],
  };
}

describe("staged decision follow-up", () => {
  test("does not continue to npm while an approval is still short of quorum", () => {
    expect(decisionSubmissionReachedVerdict(result(null, 1), "publish")).toBe(false);
  });

  test("continues only once the submitted verdict is the release decision", () => {
    expect(decisionSubmissionReachedVerdict(result("publish", 2), "publish")).toBe(true);
    expect(decisionSubmissionReachedVerdict(result("no_publish", 1), "no_publish")).toBe(true);
  });
});
