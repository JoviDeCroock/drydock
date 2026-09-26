import { describe, expect, test } from "vitest";
import {
  evaluateGateContinuity,
  unknownGateContinuity,
  type GateContinuity,
} from "../server/lib/scan/gate-continuity-record";
import type { GateReviewHistory } from "../server/db/scan-gate-continuity";
import { gateContinuityPresentation } from "../src/pages/Dashboard/ScanDetail/ReportSections";

const GATED = "a".repeat(64);
const OTHER = "b".repeat(64);

function history(
  forVersion: GateReviewHistory["forVersion"],
  extra: Partial<GateReviewHistory> = {},
): GateReviewHistory {
  return {
    ecosystem: "npm",
    forVersion,
    packageHasLiveGate: true,
    truncated: false,
    versionHasIncompleteGateScan: false,
    ...extra,
  };
}

const approvedReview: GateReviewHistory["forVersion"][number] = {
  scanId: "scan_gate",
  stagedVersion: "2.0.0",
  completedAt: new Date("2026-09-01T00:00:00.000Z"),
  summaryJson: {
    stagedPublish: {
      provenance: {
        ecosystem: "npm",
        mode: "workflow_gate",
        artifacts: [{ path: "pkg.tgz", kind: "tarball", sha256: GATED }],
      },
    },
  },
  gate: {
    id: "gate_1",
    repositoryFullName: "octo/pkg",
    environment: "production",
    runId: 42,
    status: "approved",
    decision: "approved",
    decidedAt: new Date("2026-09-01T01:00:00.000Z"),
  },
};

function evaluated(...args: Parameters<typeof evaluateGateContinuity>): GateContinuity {
  const record = evaluateGateContinuity(...args);
  if (!record) throw new Error("expected a record");
  return record;
}

describe("gateContinuityPresentation", () => {
  test("never reads a stage with no completed gate review quieter than an ungated one", () => {
    const ungated = gateContinuityPresentation(evaluated(history([]), GATED, true), true);
    const incomplete = gateContinuityPresentation(
      evaluated(history([], { versionHasIncompleteGateScan: true }), GATED, true),
      true,
    );
    expect(ungated.tone).toBe("high");
    expect(incomplete.tone).toBe("high");
    expect(incomplete.description).toContain("has approved no bytes for this version");
  });

  test("claims npm holds the bytes only when the download is bound to npm's record", () => {
    // Equal digests next to "gate approved": the unbound case must not label
    // the staged digest as what npm holds.
    const unbound = evaluated(history([approvedReview]), GATED, false);
    expect(unbound).toMatchObject({ status: "unverified", reason: "stage-not-bound-to-registry" });
    const presented = gateContinuityPresentation(unbound, false);
    expect(presented.stagedLabel).toBe("staged download");
    expect(presented.tone).toBe("medium");
    expect(presented.description).toContain("not confirmed against npm's own record");

    const matched = gateContinuityPresentation(
      evaluated(history([approvedReview]), GATED, true),
      true,
    );
    expect(matched).toMatchObject({ tone: "ok", stagedLabel: "npm holds" });

    const mismatch = gateContinuityPresentation(
      evaluated(history([approvedReview]), OTHER, false),
      false,
    );
    expect(mismatch.tone).toBe("critical");
    expect(mismatch.stagedLabel).toBe("staged download");
    expect(mismatch.description).toContain("tarball Drydock downloaded for this stage");
  });

  test("names the cause of every record that binds nothing", () => {
    const records: GateContinuity[] = [
      evaluated(history([], { versionHasIncompleteGateScan: true }), GATED, true),
      evaluated(history([approvedReview]), null, true),
      evaluated(history([{ ...approvedReview, summaryJson: null }]), GATED, true),
      evaluated(history([{ ...approvedReview, gate: null }]), GATED, true),
      evaluated(history([approvedReview]), GATED, false),
      evaluated(history([approvedReview], { truncated: true }), OTHER, true),
      unknownGateContinuity("history-unavailable", GATED),
      unknownGateContinuity("registry-record-unavailable", GATED),
    ];
    const descriptions = records.map((record) => {
      expect(record.reason).not.toBeNull();
      return gateContinuityPresentation(record, true).description;
    });
    // One distinct explanation per cause, none of them the old catch-all.
    expect(new Set(descriptions).size).toBe(records.length);
    for (const description of descriptions) {
      expect(description).not.toContain("one of the two digests is unavailable");
    }
  });
});
