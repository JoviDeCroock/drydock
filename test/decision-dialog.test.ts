import { describe, expect, test } from "vitest";
import {
  approvalSubmissionCompletesRelease,
  decisionSubmissionReachedVerdict,
} from "../src/pages/Dashboard/ScanDetail/DecisionDialog";
import {
  canRetryPendingGatePackageDecision,
  viewerHasRecordedGateVote,
} from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";
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

  test("does not promise quorum when the viewer is replacing their own approval", () => {
    const partial = result(null, 1).approvals!;
    expect(approvalSubmissionCompletesRelease(partial)).toBe(false);
    expect(approvalSubmissionCompletesRelease({ ...partial, viewerDecision: null })).toBe(true);
  });

  test("does not promise quorum while another review blocks the release", () => {
    const blocked = result("no_publish", 1).approvals!;
    expect(
      approvalSubmissionCompletesRelease({
        ...blocked,
        required: 2,
        approvedCount: 1,
        viewerDecision: null,
      }),
    ).toBe(false);
  });

  test("does not count a synthesized legacy decision toward the live quorum", () => {
    const partial = result("publish", 1).approvals!;
    expect(
      approvalSubmissionCompletesRelease({
        ...partial,
        legacyDecision: true,
        viewerDecision: null,
      }),
    ).toBe(false);
  });

  test("treats either durable gate verdict as an existing viewer vote", () => {
    const partial = result(null, 1).approvals!;
    expect(viewerHasRecordedGateVote({ ...partial, viewerDecision: "publish" })).toBe(true);
    expect(viewerHasRecordedGateVote({ ...partial, viewerDecision: "no_publish" })).toBe(true);
    expect(viewerHasRecordedGateVote({ ...partial, viewerDecision: null })).toBe(false);
  });

  test("allows a matching durable package verdict to finish a resolved pending gate", () => {
    expect(
      canRetryPendingGatePackageDecision({
        gatePending: true,
        aggregateDecision: "approved",
        packageDecision: "publish",
        viewerDecision: "publish",
        submission: "approved",
      }),
    ).toBe(true);
    expect(
      canRetryPendingGatePackageDecision({
        gatePending: true,
        aggregateDecision: "rejected",
        packageDecision: "no_publish",
        viewerDecision: "no_publish",
        submission: "rejected",
      }),
    ).toBe(true);
  });

  test("does not offer a recovery retry for unresolved, mismatched, or completed gate state", () => {
    const base = {
      gatePending: true,
      aggregateDecision: "approved" as const,
      packageDecision: "publish" as const,
      viewerDecision: "publish" as const,
      submission: "approved" as const,
    };
    expect(canRetryPendingGatePackageDecision({ ...base, aggregateDecision: null })).toBe(false);
    expect(canRetryPendingGatePackageDecision({ ...base, viewerDecision: null })).toBe(false);
    expect(canRetryPendingGatePackageDecision({ ...base, gatePending: false })).toBe(false);
  });
});
