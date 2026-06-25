import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ScanListModel,
  scanMatchesDecisionFilter,
  type PersistedScanDetail,
} from "../src/models/scan";

type ScanListModelInstance = InstanceType<typeof ScanListModel>;

let model: ScanListModelInstance | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scanDetail(decision: "publish" | "no_publish" | null): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "left-pad",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "none",
      status: "complete",
      decision,
      decisionReason: "reviewed",
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
    },
    riskSummary: {
      artifactRisk: "none",
      releaseRisk: "none",
      contextRisk: "none",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    },
    files: [],
    findings: [],
    events: [],
  };
}

describe("ScanListModel decisions", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("filters a decided scan out of the default undecided list", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(scanDetail("publish"))));
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanListModel();
    model.scans.value = [scanDetail(null).scan];
    model.filter.value = "undecided";

    await model.setDecision("scan-1", "publish", "reviewed");

    expect(model.decisionStatus.value).toBe("idle");
    expect(model.scans.value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/scans/scan-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "publish", reason: "reviewed" }),
      }),
    );
  });

  test("keeps an updated decided scan in the all list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(scanDetail("no_publish")))),
    );

    model = new ScanListModel();
    model.scans.value = [scanDetail(null).scan];
    model.filter.value = "all";

    await model.setDecision("scan-1", "no_publish", "reviewed");

    expect(model.scans.value).toHaveLength(1);
    expect(model.scans.value[0]?.decision).toBe("no_publish");
    expect(model.scans.value[0]?.riskSummary?.releaseRisk).toBe("none");
  });
});

describe("scanMatchesDecisionFilter", () => {
  test("matches dashboard decision filter semantics", () => {
    expect(scanMatchesDecisionFilter({ decision: null }, "undecided")).toBe(true);
    expect(scanMatchesDecisionFilter({ decision: "publish" }, "undecided")).toBe(false);
    expect(scanMatchesDecisionFilter({ decision: "publish" }, "publish")).toBe(true);
    expect(scanMatchesDecisionFilter({ decision: "no_publish" }, "publish")).toBe(false);
    expect(scanMatchesDecisionFilter({ decision: "no_publish" }, "all")).toBe(true);
  });
});
