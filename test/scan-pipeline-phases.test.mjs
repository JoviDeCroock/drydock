import { afterEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  persistScan: vi.fn(async () => ({ persisted: true })),
  recordScanEvent: vi.fn(async () => undefined),
}));

vi.mock("../server/db/index.ts", () => dbMock);

const {
  resolveBaseline,
  computeDiff,
  runDeterministicFindings,
  scoreRisk,
  persistResults,
  recordCompletion,
} = await import("../server/lib/scan-pipeline-phases.ts");

const NPM_TOKEN = "npm_abcdefghijklmnopqrstuvwxyz0123";

const baselineArtifact = {
  files: [
    {
      path: "package.json",
      size: 50,
      sha256: "prev-pkg",
      flags: [],
      textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
    },
    {
      path: "index.js",
      size: 20,
      sha256: "prev-index",
      flags: [],
      textSample: "export const value = 1;\n",
    },
  ],
  manifest: { name: "pkg", version: "1.0.0" },
};

const stagedArtifact = {
  files: [
    {
      path: "package.json",
      size: 60,
      sha256: "staged-pkg",
      flags: [],
      textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
    },
    {
      path: "index.js",
      size: 40,
      sha256: "staged-index",
      flags: [],
      textSample: `export const value = 2;\nconst t = '${NPM_TOKEN}';\n`,
    },
    {
      path: "added.js",
      size: 10,
      sha256: "added",
      flags: [],
      textSample: "console.log('new');\n",
    },
  ],
  manifest: { name: "pkg", version: "1.0.1" },
};

const baselineInfo = {
  version: "1.0.0",
  tag: "latest",
  source: "dist-tag",
  distTagVersion: "1.0.0",
  reason: "test baseline",
};

const resolved = {
  staged: { artifact: stagedArtifact, details: { stageId: "stage-1" } },
  baseline: { artifact: baselineArtifact, baseline: baselineInfo },
};

const disabledAi = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

function makeAdapter(overrides = {}) {
  return {
    id: "fake",
    codePatternSet: "javascript",
    parseInput: (raw) => raw,
    createBroker: () => ({ dispose() {} }),
    acquireStaged: vi.fn(async () => resolved.staged),
    acquireBaseline: vi.fn(async () => resolved.baseline),
    runFindings: vi.fn(() => [
      {
        severity: "high",
        file: "index.js",
        evidence: `token ${NPM_TOKEN}`,
        reason: "credential-like content on a changed line",
        line: 2,
        ruleId: "code.credential-access",
        ruleVersion: "1.6.3",
      },
    ]),
    describe: vi.fn(() => ({
      name: "pkg",
      stagedVersion: "1.0.1",
      stagedTag: "latest",
      previousVersion: "1.0.0",
    })),
    summarizeDetails: vi.fn(() => ({ stageId: "stage-1" })),
    ...overrides,
  };
}

afterEach(() => {
  dbMock.persistScan.mockClear();
  dbMock.recordScanEvent.mockClear();
});

describe("resolveBaseline", () => {
  test("acquires the staged artifact, then the baseline it is threaded into", async () => {
    const adapter = makeAdapter();
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };
    const broker = { dispose() {} };
    const input = { stageId: "stage-1" };

    const out = await resolveBaseline(adapter, ctx, input, broker);

    expect(adapter.acquireStaged).toHaveBeenCalledWith(ctx, input, broker);
    expect(adapter.acquireBaseline).toHaveBeenCalledWith(ctx, input, broker, resolved.staged);
    expect(out).toEqual({ staged: resolved.staged, baseline: resolved.baseline });
  });
});

describe("computeDiff", () => {
  test("diffs files + manifest and extracts the staged package.json text", () => {
    const diff = computeDiff(resolved);

    const statusByPath = Object.fromEntries(diff.fileDiff.map((e) => [e.path, e.status]));
    expect(statusByPath["package.json"]).toBe("modified");
    expect(statusByPath["index.js"]).toBe("modified");
    expect(statusByPath["added.js"]).toBe("added");

    expect(diff.manifestDiff.previousVersion).toBe("1.0.0");
    expect(diff.manifestDiff.stagedVersion).toBe("1.0.1");
    expect(diff.stagedManifestText).toBe(JSON.stringify({ name: "pkg", version: "1.0.1" }));
  });
});

describe("runDeterministicFindings", () => {
  test("runs adapter rules, redacts evidence + file text, and annotates release delta", () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);

    const out = runDeterministicFindings(adapter, resolved, diff);

    expect(adapter.runFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        staged: stagedArtifact,
        baseline: baselineArtifact,
        fileDiff: diff.fileDiff,
        manifestDiff: diff.manifestDiff,
        stagedManifestText: diff.stagedManifestText,
      }),
    );

    expect(out.ruleFindings[0].evidence).toBe("token [REDACTED_NPM_TOKEN]");

    const stagedIndex = out.redactedStagedFiles.find((f) => f.path === "index.js");
    expect(stagedIndex.textSample).toContain("[REDACTED_NPM_TOKEN]");
    expect(stagedIndex.textSample).not.toContain(NPM_TOKEN);

    expect(out.annotatedFindings[0]).toMatchObject({ diffStatus: "modified", releaseDelta: true });

    expect(out.releaseRuleFindings[0]).toMatchObject({
      file: "index.js",
      ruleId: "code.credential-access",
    });
    expect(out.releaseRuleFindings[0]).not.toHaveProperty("diffStatus");
    expect(out.releaseRuleFindings[0]).not.toHaveProperty("releaseDelta");

    expect(out.findingAnnotations).toEqual([
      { findingIndex: 0, diffStatus: "modified", releaseDelta: true },
    ]);

    expect(adapter.summarizeDetails).toHaveBeenCalledWith(resolved.staged.details);
    expect(out.redactedDetails).toEqual({ stageId: "stage-1" });
  });

  test("returns empty redacted previous files when there is no baseline", () => {
    const adapter = makeAdapter();
    const noBaseline = {
      staged: resolved.staged,
      baseline: { artifact: null, baseline: baselineInfo },
    };
    const diff = computeDiff(noBaseline);

    const out = runDeterministicFindings(adapter, noBaseline, diff);

    expect(out.redactedPreviousFiles).toEqual([]);
    expect(out.redactedPreviousManifest).toBeNull();
  });
});

describe("scoreRisk", () => {
  test("splits release vs context findings into the risk breakdown", () => {
    const annotated = [
      {
        severity: "high",
        file: "a",
        evidence: "",
        reason: "",
        releaseDelta: true,
        diffStatus: "added",
      },
      {
        severity: "medium",
        file: "b",
        evidence: "",
        reason: "",
        releaseDelta: false,
        diffStatus: "unchanged",
      },
    ];

    const summary = scoreRisk(annotated, disabledAi);

    expect(summary.artifactRisk).toBe("high");
    expect(summary.releaseRisk).toBe("high");
    expect(summary.contextRisk).toBe("medium");
    expect(summary.releaseFindingCount).toBe(1);
    expect(summary.contextFindingCount).toBe(1);
  });
});

describe("persistResults", () => {
  test("assembles the scan result and persists a completed scan", async () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);
    const riskSummary = scoreRisk(findings.annotatedFindings, disabledAi);
    const identity = { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" };

    const { result, persisted } = await persistResults({
      db: {},
      session: { userId: "user-1" },
      adapter,
      adapterInput: { stageId: "stage-1" },
      identity,
      resolved,
      diff,
      findings,
      aiFindings: disabledAi,
      riskSummary,
    });

    expect(persisted).toBe(true);
    expect(result).toMatchObject({
      id: "scan-1",
      stageId: "stage-1",
      package: { name: "pkg", stagedVersion: "1.0.1", previousVersion: "1.0.0" },
      baseline: baselineInfo,
      fileCount: 3,
      previousFileCount: 2,
      risk: riskSummary.artifactRisk,
      ruleFindings: findings.ruleFindings,
    });
    expect(result.safety.tokenExposedToSandbox).toBe(false);
    expect(adapter.describe).toHaveBeenCalledTimes(1);

    const persistArg = dbMock.persistScan.mock.calls[0][1];
    expect(persistArg).toMatchObject({
      id: "scan-1",
      status: "complete",
      risk: riskSummary.artifactRisk,
      organizationId: "org-1",
      ownerUserId: "user-1",
      previousPackageJson: { name: "pkg", version: "1.0.0" },
    });
    expect(persistArg.summary.report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(persistArg.summary.report.rulesVersion).toBeDefined();
  });

  test("propagates a non-persisted outcome from persistScan", async () => {
    dbMock.persistScan.mockResolvedValueOnce({ persisted: false, reason: "already_terminal" });
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);
    const riskSummary = scoreRisk(findings.annotatedFindings, disabledAi);

    const { persisted } = await persistResults({
      db: {},
      session: { userId: "user-1" },
      adapter,
      adapterInput: { stageId: "stage-1" },
      identity: { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" },
      resolved,
      diff,
      findings,
      aiFindings: disabledAi,
      riskSummary,
    });

    expect(persisted).toBe(false);
  });
});

describe("recordCompletion", () => {
  const completedResult = {
    id: "scan-1",
    stageId: "stage-1",
    package: { name: "pkg", stagedVersion: "1.0.1", stagedTag: "latest" },
    fileCount: 3,
    previousFileCount: 2,
    ruleFindings: [],
    risk: "high",
    riskSummary: { releaseRisk: "low", contextRisk: "high", artifactRisk: "high" },
  };
  const identity = { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" };

  test("records the completion audit event when the scan was persisted", async () => {
    await recordCompletion({
      db: {},
      session: { userId: "user-1" },
      identity,
      adapterId: "fake",
      result: completedResult,
      baseline: baselineInfo,
      persisted: true,
      pipelineStartedAtMs: Date.now(),
    });

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(1);
    expect(dbMock.recordScanEvent.mock.calls[0][1]).toMatchObject({
      type: "scan.completed",
      scanId: "scan-1",
      organizationId: "org-1",
      metadata: { packageName: "pkg", artifactRisk: "high", contextRisk: "high" },
    });
  });

  test("skips the audit event when the scan was not persisted", async () => {
    await recordCompletion({
      db: {},
      session: { userId: "user-1" },
      identity,
      adapterId: "fake",
      result: completedResult,
      baseline: baselineInfo,
      persisted: false,
      pipelineStartedAtMs: Date.now(),
    });

    expect(dbMock.recordScanEvent).not.toHaveBeenCalled();
  });
});
