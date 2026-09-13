import { describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  loadGateReviewHistory: vi.fn(),
}));
vi.mock("../server/db/scans.ts", () => dbMock);

const { evaluateGateContinuity, normalizeGateContinuity, resolveGateContinuity } =
  await import("../server/lib/scan/gate-continuity");

const GATED = "a".repeat(64);
const OTHER = "b".repeat(64);

function gateRow(sha256, overrides = {}) {
  return {
    scanId: "scan_gate",
    stagedVersion: "2.0.0",
    completedAt: new Date("2026-09-01T00:00:00.000Z"),
    summaryJson: {
      stagedPublish: {
        provenance: {
          ecosystem: "npm",
          mode: "workflow_gate",
          artifacts: [{ path: "pkg-2.0.0.tgz", kind: "tarball", sha256 }],
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
    ...overrides,
  };
}

describe("evaluateGateContinuity", () => {
  test("is silent for a package the organization never gated", () => {
    expect(
      evaluateGateContinuity({ forVersion: [], packageHasGateHistory: false }, GATED),
    ).toBeNull();
  });

  test("names a stage of a gated package that never passed the gate", () => {
    expect(evaluateGateContinuity({ forVersion: [], packageHasGateHistory: true }, GATED)).toEqual({
      status: "ungated",
      algorithm: "sha256",
      stagedDigest: GATED,
      review: null,
    });
  });

  test("matches the stage to the gate review of the same bytes, case-insensitively", () => {
    const continuity = evaluateGateContinuity(
      { forVersion: [gateRow(GATED)], packageHasGateHistory: true },
      GATED.toUpperCase(),
    );
    expect(continuity).toMatchObject({
      status: "matched",
      stagedDigest: GATED,
      review: {
        scanId: "scan_gate",
        gateId: "gate_1",
        repository: "octo/pkg",
        environment: "production",
        runId: 42,
        decision: "approved",
        decidedAt: "2026-09-01T01:00:00.000Z",
        sha256: GATED,
      },
    });
  });

  test("prefers a matching review over a newer non-matching re-run", () => {
    const rerun = gateRow(OTHER, { scanId: "scan_rerun" });
    const continuity = evaluateGateContinuity(
      { forVersion: [rerun, gateRow(GATED)], packageHasGateHistory: true },
      GATED,
    );
    expect(continuity?.status).toBe("matched");
    expect(continuity?.review?.scanId).toBe("scan_gate");
  });

  test("reports a mismatch when the gate reviewed this version but different bytes were staged", () => {
    const continuity = evaluateGateContinuity(
      { forVersion: [gateRow(GATED)], packageHasGateHistory: true },
      OTHER,
    );
    expect(continuity).toMatchObject({
      status: "digest-mismatch",
      stagedDigest: OTHER,
      review: { scanId: "scan_gate", sha256: GATED },
    });
  });

  test("is unverified rather than a mismatch when the staged digest is unavailable", () => {
    const continuity = evaluateGateContinuity(
      { forVersion: [gateRow(GATED)], packageHasGateHistory: true },
      null,
    );
    expect(continuity).toMatchObject({ status: "unverified", stagedDigest: null });
  });

  test("never matches against a multi-artifact or malformed gate provenance", () => {
    const multi = gateRow(GATED);
    multi.summaryJson.stagedPublish.provenance.artifacts.push({
      path: "other.tgz",
      kind: "tarball",
      sha256: GATED,
    });
    const malformed = gateRow(GATED, { summaryJson: { stagedPublish: { provenance: "nope" } } });
    for (const row of [multi, malformed]) {
      const continuity = evaluateGateContinuity(
        { forVersion: [row], packageHasGateHistory: true },
        GATED,
      );
      expect(continuity?.status).toBe("digest-mismatch");
      expect(continuity?.review?.sha256).toBeNull();
    }
  });

  test("survives a gate row that was deleted out from under the scan", () => {
    const continuity = evaluateGateContinuity(
      { forVersion: [gateRow(GATED, { gate: null })], packageHasGateHistory: true },
      GATED,
    );
    expect(continuity).toMatchObject({
      status: "matched",
      review: { scanId: "scan_gate", gateId: null, repository: null, decision: null },
    });
  });
});

describe("resolveGateContinuity", () => {
  const identity = { scanId: "scan_1", stageId: "stage_1", organizationId: "org_1" };

  test.each(["workflow_gate", "published"])("does not run for %s scans", async (source) => {
    dbMock.loadGateReviewHistory.mockClear();
    const continuity = await resolveGateContinuity({
      db: {},
      identity,
      source,
      packageName: "pkg",
      version: "2.0.0",
      stagedDigest: GATED,
    });
    expect(continuity).toBeNull();
    expect(dbMock.loadGateReviewHistory).not.toHaveBeenCalled();
  });

  test("scopes the lookup to the organization and package version", async () => {
    dbMock.loadGateReviewHistory.mockResolvedValueOnce({
      forVersion: [gateRow(GATED)],
      packageHasGateHistory: true,
    });
    const continuity = await resolveGateContinuity({
      db: {},
      identity,
      source: "auto_discovery",
      packageName: "pkg",
      version: "2.0.0",
      stagedDigest: GATED,
    });
    expect(dbMock.loadGateReviewHistory).toHaveBeenCalledWith(
      {},
      { organizationId: "org_1", packageName: "pkg", version: "2.0.0" },
    );
    expect(continuity?.status).toBe("matched");
  });

  test("degrades a lookup failure to no record instead of failing the scan", async () => {
    dbMock.loadGateReviewHistory.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      resolveGateContinuity({
        db: {},
        identity,
        source: "manual",
        packageName: "pkg",
        version: "2.0.0",
        stagedDigest: GATED,
      }),
    ).resolves.toBeNull();
  });
});

describe("normalizeGateContinuity", () => {
  test("round-trips a persisted record", () => {
    const record = evaluateGateContinuity(
      { forVersion: [gateRow(GATED)], packageHasGateHistory: true },
      GATED,
    );
    expect(normalizeGateContinuity(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test.each([
    ["not an object", "matched"],
    ["unknown status", { status: "approved", review: { scanId: "x" } }],
    ["a claimed match with no review", { status: "matched", review: null }],
    ["a review without a scan id", { status: "matched", review: { repository: "octo/pkg" } }],
  ])("rejects %s", (_name, value) => {
    expect(normalizeGateContinuity(value)).toBeNull();
  });

  test("drops a review from an ungated record and bounds hostile fields", () => {
    const normalized = normalizeGateContinuity({
      status: "ungated",
      stagedDigest: "not-a-digest",
      review: { scanId: "sneaky" },
    });
    expect(normalized).toEqual({
      status: "ungated",
      algorithm: "sha256",
      stagedDigest: null,
      review: null,
    });
    const long = normalizeGateContinuity({
      status: "matched",
      review: { scanId: "s", repository: "r".repeat(2000), runId: Number.NaN },
    });
    expect(long?.review?.repository).toHaveLength(512);
    expect(long?.review?.runId).toBeNull();
  });
});
