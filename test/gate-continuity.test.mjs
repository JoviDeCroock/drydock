import { describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  loadGateReviewHistory: vi.fn(),
  hasLiveReleaseTarget: vi.fn(async () => false),
}));
vi.mock("../server/db/scans.ts", () => dbMock);

const {
  evaluateGateContinuity,
  exportGateContinuity,
  normalizeGateContinuity,
  unknownGateContinuity,
} = await import("../server/lib/scan/gate-continuity-record");
const { resolveGateContinuity } = await import("../server/lib/scan/gate-continuity");

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

/**
 * A history literal with the honest defaults: nothing truncated, no incomplete
 * gate scan. Tests that care about either say so explicitly.
 */
function history(forVersion, packageHasLiveGate, extra = {}) {
  return {
    ecosystem: "npm",
    forVersion,
    packageHasLiveGate,
    truncated: false,
    versionHasIncompleteGateScan: false,
    ...extra,
  };
}

describe("evaluateGateContinuity", () => {
  test("is silent for a package the organization does not gate", () => {
    expect(evaluateGateContinuity(history([], false), GATED, true)).toBeNull();
  });

  test("names a stage of a gated package that never passed the gate", () => {
    expect(evaluateGateContinuity(history([], true), GATED, true)).toEqual({
      status: "ungated",
      reason: null,
      algorithm: "sha256",
      stagedDigest: GATED,
      review: null,
    });
  });

  test("never binds an npm stage to another ecosystem's gate review of the same name", () => {
    // A PyPI project and an npm package can share a name and a version, and
    // even (in principle) a digest. Only an npm tarball provenance is a match
    // candidate for an npm stage.
    const pypi = gateRow(GATED);
    pypi.summaryJson.stagedPublish.provenance.ecosystem = "pypi";
    const continuity = evaluateGateContinuity(history([pypi], true), GATED, true);
    expect(continuity).toMatchObject({ status: "unverified", reason: "gate-digest-unavailable" });
    expect(continuity?.review?.sha256).toBeNull();
  });

  test("does not claim npm holds the gated bytes when the stage digest is unbound", () => {
    // The digests agree, but nothing confirmed the downloaded bytes against
    // npm's own record for the stage — which is exactly the case the critical
    // stage-digest finding is raised for. `matched` speaks about what npm
    // holds, so it is not available here.
    const continuity = evaluateGateContinuity(history([gateRow(GATED)], true), GATED, false);
    expect(continuity).toMatchObject({
      status: "unverified",
      reason: "stage-not-bound-to-registry",
      stagedDigest: GATED,
    });
    expect(continuity?.review?.scanId).toBe("scan_gate");
  });

  test("does not call a version ungated while its gate review is still incomplete", () => {
    // A gate scan that failed is still a review a maintainer can decide, so the
    // stage did not go around the gate — the verdict is just not in yet. That
    // holds whether or not the target it ran through is still configured.
    for (const live of [true, false]) {
      const continuity = evaluateGateContinuity(
        history([], live, { versionHasIncompleteGateScan: true }),
        GATED,
        true,
      );
      expect(continuity).toEqual({
        status: "unverified",
        reason: "gate-review-incomplete",
        algorithm: "sha256",
        stagedDigest: GATED,
        review: null,
      });
    }
  });

  test("does not accuse the stage when the review window was truncated", () => {
    // The approved review may be the one that fell outside the window. Absence
    // of evidence must not render as "bytes the gate never saw".
    const continuity = evaluateGateContinuity(
      history([gateRow(GATED)], true, { truncated: true }),
      OTHER,
      true,
    );
    expect(continuity).toMatchObject({ status: "unverified", reason: "review-window-truncated" });

    const complete = evaluateGateContinuity(history([gateRow(GATED)], true), OTHER, true);
    expect(complete?.status).toBe("digest-mismatch");
  });

  test("matches the stage to the gate review of the same bytes, case-insensitively", () => {
    const continuity = evaluateGateContinuity(
      history([gateRow(GATED)], true),
      GATED.toUpperCase(),
      true,
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

  test("prefers a same-bytes review over a newer re-run of different bytes", () => {
    const rerun = gateRow(OTHER, { scanId: "scan_rerun" });
    const continuity = evaluateGateContinuity(history([rerun, gateRow(GATED)], true), GATED, true);
    expect(continuity?.status).toBe("matched");
    expect(continuity?.review?.scanId).toBe("scan_gate");
  });

  test("reports a mismatch when the gate reviewed this version but different bytes were staged", () => {
    const continuity = evaluateGateContinuity(history([gateRow(GATED)], true), OTHER, true);
    expect(continuity).toMatchObject({
      status: "digest-mismatch",
      stagedDigest: OTHER,
      review: { scanId: "scan_gate", sha256: GATED },
    });
  });

  test("is unverified rather than a mismatch when the staged digest is unavailable", () => {
    const continuity = evaluateGateContinuity(history([gateRow(GATED)], true), null, true);
    expect(continuity).toMatchObject({
      status: "unverified",
      reason: "staged-digest-unavailable",
      stagedDigest: null,
    });
  });

  test("reports the gate seeing exactly these bytes and not approving them", () => {
    const rejected = gateRow(GATED, {
      scanId: "scan_rejected",
      gate: { ...gateRow(GATED).gate, status: "rejected", decision: "rejected" },
    });
    const pending = gateRow(GATED, {
      scanId: "scan_pending",
      gate: { ...gateRow(GATED).gate, status: "pending", decision: null, decidedAt: null },
    });
    for (const row of [rejected, pending]) {
      const continuity = evaluateGateContinuity(history([row], true), GATED, true);
      expect(continuity).toMatchObject({
        status: "gate-not-approved",
        review: { scanId: row.scanId, sha256: GATED },
      });
    }
    // Reviews are newest first and the latest decision on these bytes wins:
    // an approved re-run outranks an earlier rejection, and a later rejection
    // outranks an earlier approval.
    const approvedLater = evaluateGateContinuity(
      history([gateRow(GATED), rejected], true),
      GATED,
      true,
    );
    expect(approvedLater?.status).toBe("matched");
    expect(approvedLater?.review?.scanId).toBe("scan_gate");
    const rejectedLater = evaluateGateContinuity(
      history([rejected, gateRow(GATED)], true),
      GATED,
      true,
    );
    expect(rejectedLater?.status).toBe("gate-not-approved");
    expect(rejectedLater?.review?.scanId).toBe("scan_rejected");
  });

  test("never matches against a multi-artifact or malformed gate provenance", () => {
    const multi = gateRow(GATED);
    multi.summaryJson.stagedPublish.provenance.artifacts.push({
      path: "other.tgz",
      kind: "tarball",
      sha256: GATED,
    });
    const malformed = gateRow(GATED, { summaryJson: { stagedPublish: { provenance: "nope" } } });
    // With no comparable gate digest there is nothing to accuse the stage
    // with: one digest is not a mismatch.
    for (const row of [multi, malformed]) {
      const continuity = evaluateGateContinuity(history([row], true), GATED, true);
      expect(continuity).toMatchObject({ status: "unverified", reason: "gate-digest-unavailable" });
      expect(continuity?.review?.sha256).toBeNull();
    }
  });

  test("reads a deleted gate row as an unknown decision, not a negative one", () => {
    const continuity = evaluateGateContinuity(
      history([gateRow(GATED, { gate: null })], true),
      GATED,
      true,
    );
    expect(continuity).toMatchObject({
      status: "unverified",
      reason: "gate-decision-unavailable",
      review: { scanId: "scan_gate", gateId: null, repository: null, decision: null },
    });
  });
});

describe("resolveGateContinuity", () => {
  const identity = { scanId: "scan_1", stageId: "stage_1", organizationId: "org_1" };

  test.each(["workflow_gate", "published"])("does not run for %s scans", async (source) => {
    dbMock.loadGateReviewHistory.mockClear();
    dbMock.hasLiveReleaseTarget.mockClear();
    const continuity = await resolveGateContinuity({
      db: {},
      identity,
      source,
      ecosystem: "npm",
      registryIdentity: { packageName: "pkg", version: "2.0.0" },
      stagedDigest: GATED,
      stagedDigestBoundToRegistry: true,
    });
    expect(continuity).toBeNull();
    expect(dbMock.loadGateReviewHistory).not.toHaveBeenCalled();
    expect(dbMock.hasLiveReleaseTarget).not.toHaveBeenCalled();
  });

  test("does not run for an adapter that does not hash its staged artifact", async () => {
    dbMock.loadGateReviewHistory.mockClear();
    dbMock.hasLiveReleaseTarget.mockClear();
    for (const registryIdentity of [{ packageName: "pkg", version: "2.0.0" }, null]) {
      const continuity = await resolveGateContinuity({
        db: {},
        identity,
        source: "manual",
        ecosystem: null,
        registryIdentity,
        stagedDigest: null,
        stagedDigestBoundToRegistry: false,
      });
      expect(continuity).toBeNull();
    }
    expect(dbMock.loadGateReviewHistory).not.toHaveBeenCalled();
    expect(dbMock.hasLiveReleaseTarget).not.toHaveBeenCalled();
  });

  test("never keys a lookup on anything but the registry's own stage coordinates", async () => {
    dbMock.loadGateReviewHistory.mockClear();
    dbMock.hasLiveReleaseTarget.mockResolvedValueOnce(false);
    const args = {
      db: {},
      identity,
      source: "manual",
      ecosystem: "npm",
      registryIdentity: null,
      stagedDigest: GATED,
      stagedDigestBoundToRegistry: false,
    };
    // An organization with no live npm-capable release target gates nothing,
    // so without a package name "not applicable" is still true.
    await expect(resolveGateContinuity(args)).resolves.toBeNull();
    // One that does gate npm releases cannot tell whether this stage skipped
    // its gate, and must not read as "not applicable".
    dbMock.hasLiveReleaseTarget.mockResolvedValueOnce(true);
    await expect(resolveGateContinuity(args)).resolves.toEqual({
      status: "unknown",
      reason: "registry-record-unavailable",
      algorithm: "sha256",
      stagedDigest: GATED,
      review: null,
    });
    expect(dbMock.hasLiveReleaseTarget).toHaveBeenCalledWith({}, "org_1", "npm");
    expect(dbMock.loadGateReviewHistory).not.toHaveBeenCalled();
  });

  test("scopes the lookup to the organization and package version", async () => {
    dbMock.loadGateReviewHistory.mockResolvedValueOnce(history([gateRow(GATED)], true));
    const continuity = await resolveGateContinuity({
      db: {},
      identity,
      source: "auto_discovery",
      ecosystem: "npm",
      registryIdentity: { packageName: "pkg", version: "2.0.0" },
      stagedDigest: GATED,
      stagedDigestBoundToRegistry: true,
    });
    expect(dbMock.loadGateReviewHistory).toHaveBeenCalledWith(
      {},
      { organizationId: "org_1", ecosystem: "npm", packageName: "pkg", version: "2.0.0" },
    );
    expect(continuity?.status).toBe("matched");
  });

  test("records a failed lookup as unknown, not as a package that is not gated", async () => {
    // A transient D1 failure must not let the receipt read `not_applicable`:
    // nothing established that the organization does not gate this package.
    dbMock.loadGateReviewHistory.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      resolveGateContinuity({
        db: {},
        identity,
        source: "manual",
        ecosystem: "npm",
        registryIdentity: { packageName: "pkg", version: "2.0.0" },
        stagedDigest: GATED,
        stagedDigestBoundToRegistry: true,
      }),
    ).resolves.toEqual({
      status: "unknown",
      reason: "history-unavailable",
      algorithm: "sha256",
      stagedDigest: GATED,
      review: null,
    });
    dbMock.hasLiveReleaseTarget.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      resolveGateContinuity({
        db: {},
        identity,
        source: "manual",
        ecosystem: "npm",
        registryIdentity: null,
        stagedDigest: null,
        stagedDigestBoundToRegistry: false,
      }),
    ).resolves.toMatchObject({ status: "unknown", reason: "history-unavailable" });
  });
});

describe("normalizeGateContinuity", () => {
  const rejected = gateRow(GATED, {
    gate: { ...gateRow(GATED).gate, status: "rejected", decision: "rejected" },
  });
  // Every record the evaluator or resolver can produce, keyed by what it is.
  // Each must survive persistence unchanged: a status the normalizer drops
  // renders nothing, exports null, and reads `not_applicable` on the receipt.
  const produced = [
    ["matched", evaluateGateContinuity(history([gateRow(GATED)], true), GATED, true)],
    ["gate-not-approved", evaluateGateContinuity(history([rejected], true), GATED, true)],
    ["digest-mismatch", evaluateGateContinuity(history([gateRow(GATED)], true), OTHER, true)],
    ["ungated", evaluateGateContinuity(history([], true), GATED, true)],
    [
      "unverified: gate-review-incomplete (no review)",
      evaluateGateContinuity(history([], true, { versionHasIncompleteGateScan: true }), GATED),
    ],
    [
      "unverified: staged-digest-unavailable",
      evaluateGateContinuity(history([gateRow(GATED)], true), null, true),
    ],
    [
      "unverified: gate-digest-unavailable",
      evaluateGateContinuity(history([gateRow(null)], true), GATED, true),
    ],
    [
      "unverified: gate-decision-unavailable",
      evaluateGateContinuity(history([gateRow(GATED, { gate: null })], true), GATED, true),
    ],
    [
      "unverified: stage-not-bound-to-registry",
      evaluateGateContinuity(history([gateRow(GATED)], true), GATED, false),
    ],
    [
      "unverified: review-window-truncated",
      evaluateGateContinuity(history([gateRow(GATED)], true, { truncated: true }), OTHER, true),
    ],
    ["unknown: history-unavailable", unknownGateContinuity("history-unavailable", GATED)],
    [
      "unknown: registry-record-unavailable",
      unknownGateContinuity("registry-record-unavailable", null),
    ],
  ];

  test("covers every status the record can take", () => {
    expect(new Set(produced.map(([, record]) => record?.status))).toEqual(
      new Set([
        "matched",
        "gate-not-approved",
        "digest-mismatch",
        "unverified",
        "ungated",
        "unknown",
      ]),
    );
  });

  test.each(produced)("round-trips %s through persistence", (label, record) => {
    expect(record).not.toBeNull();
    expect(label.startsWith(record.status)).toBe(true);
    expect(normalizeGateContinuity(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test.each([
    ["not an object", "matched"],
    ["unknown status", { status: "approved", review: { scanId: "x" } }],
    ["a claimed match with no review", { status: "matched", review: null }],
    ["a review without a scan id", { status: "matched", review: { repository: "octo/pkg" } }],
    ["an accusation with no review", { status: "digest-mismatch", stagedDigest: OTHER }],
  ])("rejects %s", (_name, value) => {
    expect(normalizeGateContinuity(value)).toBeNull();
  });

  test("keeps an unverified record that has no review", () => {
    // Dropping it would render nothing for a gated package whose gate scan of
    // this version is in flight or failed — quieter than `ungated`.
    expect(normalizeGateContinuity({ status: "unverified", stagedDigest: GATED })).toEqual({
      status: "unverified",
      reason: null,
      algorithm: "sha256",
      stagedDigest: GATED,
      review: null,
    });
  });

  test("drops a review from an ungated record and bounds hostile fields", () => {
    const normalized = normalizeGateContinuity({
      status: "ungated",
      reason: "history-unavailable",
      stagedDigest: "not-a-digest",
      review: { scanId: "sneaky" },
    });
    expect(normalized).toEqual({
      status: "ungated",
      reason: null,
      algorithm: "sha256",
      stagedDigest: null,
      review: null,
    });
    // `unverified` asserts no equality, so it is the status that exercises the
    // field bounds without also having to satisfy the digest invariant below.
    const long = normalizeGateContinuity({
      status: "unverified",
      reason: "not-a-reason",
      review: { scanId: "s", repository: "r".repeat(2000), runId: Number.NaN },
    });
    expect(long?.reason).toBeNull();
    expect(long?.review?.repository).toHaveLength(512);
    expect(long?.review?.runId).toBeNull();
    // A reason belongs to its status: an `unknown` cause on `unverified` is not one.
    expect(
      normalizeGateContinuity({ status: "unverified", reason: "history-unavailable" })?.reason,
    ).toBeNull();
  });

  test("re-derives the match rather than trusting a persisted claim", () => {
    const review = { scanId: "s", sha256: GATED };
    // A blob that says `matched` but carries digests that do not agree — or
    // none at all — would otherwise render the green badge with blank rows.
    expect(normalizeGateContinuity({ status: "matched", review })).toBeNull();
    expect(normalizeGateContinuity({ status: "matched", stagedDigest: OTHER, review })).toBeNull();
    expect(
      normalizeGateContinuity({ status: "matched", stagedDigest: GATED, review: { scanId: "s" } }),
    ).toBeNull();
    expect(
      normalizeGateContinuity({ status: "matched", stagedDigest: GATED, review })?.status,
    ).toBe("matched");
  });
});

describe("exportGateContinuity", () => {
  test("keeps the verdict and both digests, and none of the gate's identity", () => {
    // report.json is also what a public share token serves; the gate's
    // repository, environment, run, and internal ids stay authenticated.
    const record = evaluateGateContinuity(history([gateRow(GATED)], true), GATED, true);
    expect(exportGateContinuity(record)).toEqual({
      status: "matched",
      reason: null,
      algorithm: "sha256",
      stagedDigest: GATED,
      gateDigest: GATED,
    });
    expect(
      exportGateContinuity(evaluateGateContinuity(history([], true), GATED, true)),
    ).toMatchObject({ status: "ungated", gateDigest: null });
    expect(exportGateContinuity(null)).toBeNull();
  });
});
