import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryArtifactBucket } from "./helpers/artifact-bucket.mjs";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const dbMock = vi.hoisted(() => ({
  backfillScanRegistryReleaseIdentity: vi.fn(async () => undefined),
  persistScan: vi.fn(async () => ({ persisted: true })),
  recordScanEvent: vi.fn(async () => undefined),
  getNpmConnection: vi.fn(),
  createDb: vi.fn(() => ({})),
}));
const registryMock = vi.hoisted(() => ({
  fetchPackageMetadata: vi.fn(),
}));
const sandboxMock = vi.hoisted(() => ({
  downloadInSandbox: vi.fn(),
}));
const publishedTarballMock = vi.hoisted(() => ({
  downloadPublishedTarball: vi.fn(),
}));
const stagedMock = vi.hoisted(() => ({
  fetchStagedPublishDetails: vi.fn(),
}));
const npmConnectionMock = vi.hoisted(() => ({
  decryptNpmToken: vi.fn(),
}));
const aiReviewMock = vi.hoisted(() => ({
  runSelectiveAiReview: vi.fn(),
}));

vi.mock("../server/db/client.ts", () => dbMock);
vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/npm-connections.ts", () => dbMock);
vi.mock("../server/db/scans.ts", () => dbMock);
vi.mock("../server/lib/ecosystems/npm/registry.ts", async () => ({
  ...(await vi.importActual("../server/lib/ecosystems/npm/registry.ts")),
  fetchPackageMetadata: registryMock.fetchPackageMetadata,
}));
vi.mock("../server/lib/sandbox.ts", async () => ({
  ...(await vi.importActual("../server/lib/sandbox.ts")),
  downloadInSandbox: sandboxMock.downloadInSandbox,
}));
vi.mock("../server/lib/ecosystems/npm/published-tarball.ts", () => publishedTarballMock);
vi.mock("../server/lib/ecosystems/npm/staged-publishes.ts", async () => ({
  ...(await vi.importActual("../server/lib/ecosystems/npm/staged-publishes.ts")),
  fetchStagedPublishDetails: stagedMock.fetchStagedPublishDetails,
}));
vi.mock("../server/lib/ecosystems/npm/connection.ts", async () => ({
  ...(await vi.importActual("../server/lib/ecosystems/npm/connection.ts")),
  decryptNpmToken: npmConnectionMock.decryptNpmToken,
}));
vi.mock("../server/lib/ai-review/index.ts", async () => ({
  ...(await vi.importActual("../server/lib/ai-review/index.ts")),
  runSelectiveAiReview: aiReviewMock.runSelectiveAiReview,
}));

const { runScanPipeline } = await import("../server/lib/scan/pipeline");
const { npmAdapter } = await import("../server/lib/ecosystems/npm");
const { BASELINE_TEXT_SAMPLE_LIMIT } = await import("../server/lib/sample-retention");

describe("scan pipeline baseline selection", () => {
  beforeEach(() => {
    dbMock.getNpmConnection.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      tokenCiphertext: "ct",
      tokenNonce: "nonce",
      validationStatus: "valid",
    });
    npmConnectionMock.decryptNpmToken.mockResolvedValue("npm_secret_token");
    stagedMock.fetchStagedPublishDetails.mockResolvedValue({
      id: "stage-beta-123",
      packageName: "@scope/pkg",
      version: "2.0.0-beta.3",
      tag: "beta",
      access: "public",
      actor: "octocat",
      actorType: "user",
      createdAt: "2026-03-16T09:00:00.000Z",
      shasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
      packageJson: null,
    });
    registryMock.fetchPackageMetadata.mockResolvedValue({
      versions: {
        "1.4.0": { dist: { tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-1.4.0.tgz" } },
        "2.0.0-beta.2": {
          dist: { tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.2.tgz" },
        },
      },
      "dist-tags": {
        latest: "1.4.0",
        beta: "2.0.0-beta.2",
      },
    });
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 64,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({
            name: "@scope/pkg",
            version: "2.0.0-beta.3",
          }),
        },
      ],
      packageJson: { name: "@scope/pkg", version: "2.0.0-beta.3" },
    });
    publishedTarballMock.downloadPublishedTarball.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 64,
          sha256: "previous-pkg",
          flags: [],
          textSample: JSON.stringify({
            name: "@scope/pkg",
            version: "2.0.0-beta.2",
          }),
        },
      ],
      packageJson: { name: "@scope/pkg", version: "2.0.0-beta.2" },
    });
  });

  afterEach(() => {
    dbMock.backfillScanRegistryReleaseIdentity.mockClear();
    dbMock.persistScan.mockClear();
    dbMock.recordScanEvent.mockClear();
    dbMock.getNpmConnection.mockReset();
    npmConnectionMock.decryptNpmToken.mockReset();
    registryMock.fetchPackageMetadata.mockReset();
    sandboxMock.downloadInSandbox.mockReset();
    publishedTarballMock.downloadPublishedTarball.mockReset();
    stagedMock.fetchStagedPublishDetails.mockReset();
    aiReviewMock.runSelectiveAiReview.mockReset();
  });

  const baseContext = {
    env: {
      NPM_REGISTRY: "https://registry.npmjs.org",
      DB: {},
      ARTIFACTS: createMemoryArtifactBucket(),
    },
    executionCtx: {},
    db: {},
    session: { userId: "user_1" },
  };

  test("refuses to decrypt a rotated unvalidated npm connection", async () => {
    dbMock.getNpmConnection.mockResolvedValue({
      registryUrl: "https://registry.npmjs.org",
      tokenCiphertext: "ct",
      tokenNonce: "nonce",
      validationStatus: "unvalidated",
    });

    await expect(
      runScanPipeline(baseContext, npmAdapter, {
        scanId: "scan_unvalidated",
        stageId: "stage-beta-123",
        organizationId: "org_1",
      }),
    ).rejects.toThrow("Validate the organization npm token");

    expect(npmConnectionMock.decryptNpmToken).not.toHaveBeenCalled();
    expect(sandboxMock.downloadInSandbox).not.toHaveBeenCalled();
    expect(stagedMock.fetchStagedPublishDetails).not.toHaveBeenCalled();
  });

  test("refuses to retarget a captured staged scan to another registry", async () => {
    await expect(
      runScanPipeline(baseContext, npmAdapter, {
        scanId: "scan_registry_changed",
        stageId: "stage-beta-123",
        organizationId: "org_1",
        registryUrl: "https://registry.example.test",
      }),
    ).rejects.toThrow("npm registry changed after this scan was queued");

    expect(npmConnectionMock.decryptNpmToken).not.toHaveBeenCalled();
    expect(sandboxMock.downloadInSandbox).not.toHaveBeenCalled();
    expect(stagedMock.fetchStagedPublishDetails).not.toHaveBeenCalled();
  });

  test("recovers missing registry coordinates from the staged control plane", async () => {
    await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_registry_identity",
      stageId: "stage-beta-123",
      organizationId: "org_1",
      registryUrl: "https://registry.npmjs.org",
    });

    expect(dbMock.backfillScanRegistryReleaseIdentity).toHaveBeenCalledWith(
      {},
      {
        scanId: "scan_registry_identity",
        organizationId: "org_1",
        registryUrl: "https://registry.npmjs.org",
        packageName: "@scope/pkg",
        version: "2.0.0-beta.3",
      },
    );
  });

  test("fails when staged details disagree with the queued registry identity", async () => {
    dbMock.backfillScanRegistryReleaseIdentity.mockResolvedValueOnce("mismatch");

    await expect(
      runScanPipeline(baseContext, npmAdapter, {
        scanId: "scan_registry_identity_mismatch",
        stageId: "stage-beta-123",
        organizationId: "org_1",
        registryUrl: "https://registry.npmjs.org",
      }),
    ).rejects.toThrow("staged release identity changed after this scan was queued");

    expect(dbMock.persistScan).not.toHaveBeenCalled();
  });

  test("propagates credential failures during baseline metadata lookup", async () => {
    dbMock.getNpmConnection
      .mockResolvedValueOnce({
        registryUrl: "https://registry.npmjs.org",
        tokenCiphertext: "ct",
        tokenNonce: "nonce",
        validationStatus: "valid",
      })
      .mockResolvedValueOnce({
        registryUrl: "https://registry.npmjs.org",
        tokenCiphertext: "ct",
        tokenNonce: "nonce",
        validationStatus: "valid",
      })
      .mockResolvedValueOnce({
        registryUrl: "https://registry.npmjs.org",
        tokenCiphertext: "ct",
        tokenNonce: "nonce",
        validationStatus: "unvalidated",
      });

    await expect(
      runScanPipeline(baseContext, npmAdapter, {
        scanId: "scan_baseline_unvalidated",
        stageId: "stage-beta-123",
        organizationId: "org_1",
      }),
    ).rejects.toThrow("Validate the organization npm token");

    expect(registryMock.fetchPackageMetadata).not.toHaveBeenCalled();
    expect(dbMock.persistScan).not.toHaveBeenCalled();
  });

  // Load-bearing asymmetry (issue #191): the reviewed side is scanned whole, so
  // its parse must never carry a text-sample cap. Only the baseline opts in.
  test("caps baseline text samples in the sandbox and never the staged parse", async () => {
    await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_retention",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    const stagedOptions = sandboxMock.downloadInSandbox.mock.calls[0][2];
    expect(stagedOptions.stageId).toBe("stage-beta-123");
    expect(stagedOptions).not.toHaveProperty("maxTextSampleChars");

    const baselineOptions = publishedTarballMock.downloadPublishedTarball.mock.calls[0][3];
    expect(baselineOptions.maxTextSampleChars).toBe(BASELINE_TEXT_SAMPLE_LIMIT);
  });

  test("propagates deleted credential failures during baseline metadata lookup", async () => {
    dbMock.getNpmConnection
      .mockResolvedValueOnce({
        registryUrl: "https://registry.npmjs.org",
        tokenCiphertext: "ct",
        tokenNonce: "nonce",
        validationStatus: "valid",
      })
      .mockResolvedValueOnce({
        registryUrl: "https://registry.npmjs.org",
        tokenCiphertext: "ct",
        tokenNonce: "nonce",
        validationStatus: "valid",
      })
      .mockResolvedValueOnce(null);

    await expect(
      runScanPipeline(baseContext, npmAdapter, {
        scanId: "scan_baseline_deleted_connection",
        stageId: "stage-beta-123",
        organizationId: "org_1",
      }),
    ).rejects.toThrow("Connect an organization npm token");

    expect(registryMock.fetchPackageMetadata).not.toHaveBeenCalled();
    expect(dbMock.persistScan).not.toHaveBeenCalled();
  });

  test("diffs a staged beta release against the current beta dist-tag target", async () => {
    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_1",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(stagedMock.fetchStagedPublishDetails).toHaveBeenCalledWith(
      "https://registry.npmjs.org",
      "npm_secret_token",
      "stage-beta-123",
      { allowInsecureLocalhost: false },
    );
    expect(publishedTarballMock.downloadPublishedTarball.mock.calls[0]?.[2]).toBe(
      "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.2.tgz",
    );
    expect(result.baseline).toMatchObject({
      version: "2.0.0-beta.2",
      tag: "beta",
      source: "dist-tag",
      distTagVersion: "2.0.0-beta.2",
    });
    expect(dbMock.persistScan.mock.calls[0]?.[1]).toMatchObject({
      previousPackageJson: { name: "@scope/pkg", version: "2.0.0-beta.2" },
      summary: {
        baseline: {
          version: "2.0.0-beta.2",
          tag: "beta",
          source: "dist-tag",
        },
      },
    });
  });

  test("persists a digest-free diff in the summary and the full diff for R2", async () => {
    await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_summary_diff",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });
    const persistedInput = dbMock.persistScan.mock.calls[0]?.[1];

    // The artifact input keeps full fidelity: R2 is where the report export
    // reads the digests from, and the exported bytes are an attestation subject.
    expect(persistedInput.diff.some((entry) => entry.stagedSha256)).toBe(true);
    // The D1 column stores identity + status + sizes only. Across production
    // that pair of 64-char hex strings was the single largest thing in the
    // database, and nothing read it there.
    expect(persistedInput.summary.diff).toEqual(
      persistedInput.diff.map(
        ({ previousSha256: _previous, stagedSha256: _staged, ...entry }) => entry,
      ),
    );
    for (const entry of persistedInput.summary.diff) {
      expect(entry).not.toHaveProperty("previousSha256");
      expect(entry).not.toHaveProperty("stagedSha256");
    }
  });

  test("computes a declared intent envelope from the staged manifest repository", async () => {
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 96,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({
            name: "@scope/pkg",
            version: "2.0.0-beta.3",
            repository: { type: "git", url: "git+https://github.com/scope/pkg.git" },
          }),
        },
      ],
      packageJson: { name: "@scope/pkg", version: "2.0.0-beta.3" },
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_envelope_declared",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(result.intentEnvelope).toEqual({
      tier: "declared",
      repository: "https://github.com/scope/pkg",
      signals: [
        {
          kind: "manifest-repository",
          detail:
            "manifest declares https://github.com/scope/pkg — claimed by the package, not verified",
        },
      ],
    });
    expect(dbMock.persistScan.mock.calls[0]?.[1].summary.intentEnvelope).toEqual(
      result.intentEnvelope,
    );
  });

  test("marks scans placed with a gate context as attested", async () => {
    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_envelope_attested",
      stageId: "stage-beta-123",
      organizationId: "org_1",
      gateContext: { repositoryFullName: "scope/pkg", runId: 4242, environment: "release" },
    });

    expect(result.intentEnvelope).toEqual({
      tier: "attested",
      repository: "https://github.com/scope/pkg",
      signals: [{ kind: "workflow-gate", detail: "repo scope/pkg, run 4242, environment release" }],
    });
    expect(dbMock.persistScan.mock.calls[0]?.[1].summary.intentEnvelope).toEqual(
      result.intentEnvelope,
    );
  });

  test("staged scans without a manifest repository read as absent", async () => {
    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_envelope_absent",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    // Staged registry metadata carries no provenance attestation today, so a
    // staged publish can never reach "attested" (see server/lib/intent-envelope.ts).
    expect(result.intentEnvelope).toEqual({ tier: "absent", repository: null, signals: [] });
  });

  test("persists deterministic results when enabled AI review fails", async () => {
    aiReviewMock.runSelectiveAiReview.mockRejectedValue(new Error("workers ai unavailable"));
    const context = {
      ...baseContext,
      env: {
        ...baseContext.env,
        FLAGS: {
          getBooleanValue: vi.fn(async () => true),
        },
      },
    };

    const result = await runScanPipeline(context, npmAdapter, {
      scanId: "scan_ai_failure",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(result.aiFindings).toMatchObject({
      status: "unavailable",
      summary: "AI review failed; deterministic findings remain available.",
      findings: [],
      model: "@cf/moonshotai/kimi-k2.7-code",
    });
    expect(aiReviewMock.runSelectiveAiReview.mock.calls[0]?.[1]).toMatchObject({
      scanId: "scan_ai_failure",
      stageId: "stage-beta-123",
      organizationId: "org_1",
      ecosystem: "npm",
    });
    expect(result.risk).toBe("medium");
    expect(dbMock.persistScan).toHaveBeenCalled();
  });

  test("runs AI review by default when the killswitch is not disabled", async () => {
    // Flagship with no explicit rule returns the default we pass. The `ai-review`
    // flag is a killswitch, so that default is `true` and the reviewer runs.
    const getBooleanValue = vi.fn(async (_flag, defaultValue) => defaultValue);
    aiReviewMock.runSelectiveAiReview.mockResolvedValue({
      review: {
        status: "complete",
        risk: "low",
        releaseAssessment: "nothing_unusual",
        summary: "Nothing unusual in the staged release.",
        findings: [],
        requiresManualReview: false,
        model: "@cf/moonshotai/kimi-k2.7-code",
      },
      usage: null,
    });
    const context = {
      ...baseContext,
      env: { ...baseContext.env, FLAGS: { getBooleanValue } },
    };

    const result = await runScanPipeline(context, npmAdapter, {
      scanId: "scan_ai_default_on",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(getBooleanValue).toHaveBeenCalledWith(
      "ai-review",
      true,
      expect.objectContaining({ organizationId: "org_1" }),
    );
    expect(aiReviewMock.runSelectiveAiReview).toHaveBeenCalled();
    expect(result.aiFindings).toMatchObject({
      status: "complete",
      summary: "Nothing unusual in the staged release.",
    });
  });

  test("skips AI review when the killswitch disables it", async () => {
    const getBooleanValue = vi.fn(async () => false);
    const context = {
      ...baseContext,
      env: { ...baseContext.env, FLAGS: { getBooleanValue } },
    };

    const result = await runScanPipeline(context, npmAdapter, {
      scanId: "scan_ai_killswitch_off",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(getBooleanValue).toHaveBeenCalledWith(
      "ai-review",
      true,
      expect.objectContaining({ organizationId: "org_1" }),
    );
    expect(aiReviewMock.runSelectiveAiReview).not.toHaveBeenCalled();
    expect(result.aiFindings).toMatchObject({
      status: "unavailable",
      summary: "AI review is disabled.",
    });
  });

  test("preserves diff-scoped deterministic findings from the npm adapter", async () => {
    stagedMock.fetchStagedPublishDetails.mockResolvedValue({
      id: "stage-diff123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      access: "public",
      actor: "octocat",
      actorType: "user",
      createdAt: "2026-03-16T09:00:00.000Z",
      shasum: null,
      packageJson: null,
    });
    registryMock.fetchPackageMetadata.mockResolvedValue({
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" } },
      },
      "dist-tags": { latest: "1.0.0" },
    });
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 40,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
        },
        {
          path: ".env",
          size: 31,
          sha256: "staged-env",
          flags: [],
          textSample: "NPM_TOKEN=npm_fakeTokenForTests123",
        },
      ],
      packageJson: { name: "pkg", version: "1.0.1" },
    });
    publishedTarballMock.downloadPublishedTarball.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 40,
          sha256: "previous-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
        },
      ],
      packageJson: { name: "pkg", version: "1.0.0" },
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_diff",
      stageId: "stage-diff123",
      organizationId: "org_1",
    });

    expect(result.risk).toBe("critical");
    expect(result.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          file: ".env",
          ruleId: "diff.credential-file-added",
        }),
      ]),
    );
  });

  test("fails the release closed when the staged tarball is not the tarball npm recorded", async () => {
    // Regression guard for the review-integrity gap behind scan
    // 163a1e40-c049-4587-8525-85b4393d2eed: without this check, a truncated or
    // substituted download reads as "the publisher removed these files".
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 64,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "@scope/pkg", version: "2.0.0-beta.3" }),
        },
      ],
      packageJson: { name: "@scope/pkg", version: "2.0.0-beta.3" },
      archiveSha1: "0000000000000000000000000000000000000000",
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_digest",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });
    const persistedInput = dbMock.persistScan.mock.calls[0]?.[1];

    expect(result.risk).toBe("critical");
    expect(result.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        file: "package.json",
        ruleId: "stage.tarball-digest-mismatch",
      }),
    );
    // The verdict rides along in the persisted report, so a reviewer reading
    // the report later can tell a proven artifact from an unverified one.
    expect(persistedInput.summary.stagedPublish.artifactIntegrity).toMatchObject({
      algorithm: "sha1",
      status: "mismatch",
      declared: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
      computed: "0000000000000000000000000000000000000000",
    });
  });

  test("records a verified staged tarball without raising a finding", async () => {
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 64,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "@scope/pkg", version: "2.0.0-beta.3" }),
        },
      ],
      packageJson: { name: "@scope/pkg", version: "2.0.0-beta.3" },
      archiveSha1: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_digest_ok",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });
    const persistedInput = dbMock.persistScan.mock.calls[0]?.[1];

    expect(
      result.ruleFindings.filter((finding) => finding.ruleId === "stage.tarball-digest-mismatch"),
    ).toEqual([]);
    expect(persistedInput.summary.stagedPublish.artifactIntegrity).toMatchObject({
      status: "verified",
    });
  });

  test("suppresses tag baseline selection when staged metadata disagrees with the tarball", async () => {
    stagedMock.fetchStagedPublishDetails.mockResolvedValue({
      id: "stage-beta-123",
      packageName: "@other/pkg",
      version: "2.0.0-beta.3",
      tag: "beta",
      access: "public",
      actor: "octocat",
      actorType: "user",
      createdAt: "2026-03-16T09:00:00.000Z",
      shasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
      packageJson: {
        name: "@other/pkg",
        version: "2.0.0-beta.3",
        scripts: { install: "node-gyp rebuild" },
        gypfile: true,
      },
    });
    registryMock.fetchPackageMetadata.mockResolvedValue({
      versions: {
        "2.0.0-beta.2": {
          dist: { tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.2.tgz" },
        },
        "9.0.0": { dist: { tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-9.0.0.tgz" } },
      },
      "dist-tags": {
        beta: "9.0.0",
      },
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_1",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(result.baseline).toMatchObject({
      version: "2.0.0-beta.2",
      tag: null,
      source: "semver-predecessor",
    });
    expect(result.package.name).toBe("@scope/pkg");
    expect(result.packageJson?.scripts?.install).toBeUndefined();
    expect(result.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          ruleId: "stage.metadata-mismatch",
          evidence: "packageName @other/pkg != package.json name @scope/pkg",
        }),
      ]),
    );
  });

  test("flags a staged release that dropped the entrypoint its manifest declares", async () => {
    // Scan 163a1e40-c049-4587-8525-85b4393d2eed: npm always packs
    // package.json and README, so a pack that ran without its build output
    // ships exactly this and the diff alone only says "files removed".
    const stagedManifest = {
      name: "@scope/pkg",
      version: "2.0.0-beta.3",
      main: "index.cjs",
      files: ["README.md", "index.cjs", "acorn.wasm"],
    };
    sandboxMock.downloadInSandbox.mockResolvedValueOnce({
      files: [
        {
          path: "package.json",
          size: 120,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify(stagedManifest, null, 2),
        },
        { path: "README.md", size: 40, sha256: "staged-readme", flags: [], textSample: "# pkg\n" },
      ],
      packageJson: stagedManifest,
    });
    publishedTarballMock.downloadPublishedTarball.mockResolvedValueOnce({
      files: [
        {
          path: "package.json",
          size: 120,
          sha256: "prev-pkg",
          flags: [],
          textSample: JSON.stringify({ ...stagedManifest, version: "2.0.0-beta.2" }, null, 2),
        },
        { path: "README.md", size: 38, sha256: "prev-readme", flags: [], textSample: "# pkg\n" },
        {
          path: "index.cjs",
          size: 90,
          sha256: "prev-index",
          flags: [],
          textSample: "module.exports={}",
        },
        {
          path: "acorn.wasm",
          size: 3350928,
          sha256: "prev-wasm",
          flags: ["native-wasm", "binary"],
        },
      ],
      packageJson: { ...stagedManifest, version: "2.0.0-beta.2" },
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_entrypoint",
      stageId: "stage-beta-123",
      organizationId: "org_1",
    });

    expect(result.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        ruleId: "package-json.entrypoint-missing",
      }),
    );
    // A release that cannot load as published is this release's defect, not
    // inherited package context.
    expect(result.riskSummary.releaseRisk).toBe("high");
  });

  test("surfaces npm's implicit node-gyp install when a staged tarball adds root binding.gyp", async () => {
    const stagedFiles = [
      {
        path: "package.json",
        size: 80,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({
          name: "pkg",
          version: "1.0.1",
          files: ["binding.gyp", "index.js"],
        }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ];
    sandboxMock.downloadInSandbox.mockResolvedValueOnce({
      files: stagedFiles,
      packageJson: {
        name: "pkg",
        version: "1.0.1",
        scripts: { install: "node-gyp rebuild" },
        implicitScripts: { install: "node-gyp rebuild" },
        gypfile: true,
      },
    });
    stagedMock.fetchStagedPublishDetails.mockResolvedValueOnce({
      id: "stage-gyp123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      access: null,
      actor: null,
      actorType: null,
      createdAt: null,
      shasum: null,
      packageJson: null,
    });
    registryMock.fetchPackageMetadata.mockResolvedValue(null);

    const result = await runScanPipeline(baseContext, npmAdapter, {
      stageId: "stage-gyp123",
      organizationId: "org_1",
    });

    expect(result.risk).toBe("high");
    expect(result.packageJsonDiff.scripts).toEqual([
      { key: "install", status: "added", staged: "node-gyp rebuild" },
    ]);
    expect(result.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        ruleId: "install-script.implicit-node-gyp",
        file: "binding.gyp",
      }),
    );
  });

  test("uses npm staged detail manifest to surface implicit node-gyp hooks missing from the tarball", async () => {
    const stagedFiles = [
      {
        path: "package.json",
        size: 40,
        sha256: "pkg",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
      },
    ];
    sandboxMock.downloadInSandbox.mockResolvedValueOnce({
      files: stagedFiles,
      packageJson: { name: "pkg", version: "1.0.1", scripts: {} },
    });
    stagedMock.fetchStagedPublishDetails.mockResolvedValueOnce({
      id: "stage-abc123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      access: null,
      actor: null,
      actorType: null,
      createdAt: null,
      shasum: null,
      packageJson: {
        name: "pkg",
        version: "1.0.1",
        scripts: { install: "node-gyp rebuild" },
        gypfile: true,
      },
    });
    registryMock.fetchPackageMetadata.mockResolvedValue(null);

    const result = await runScanPipeline(baseContext, npmAdapter, {
      stageId: "stage-abc123",
      organizationId: "org_1",
    });

    expect(stagedMock.fetchStagedPublishDetails).toHaveBeenCalledWith(
      "https://registry.npmjs.org",
      "npm_secret_token",
      "stage-abc123",
      { allowInsecureLocalhost: false },
    );
    expect(result.packageJson?.implicitScripts).toEqual({ install: "node-gyp rebuild" });
    expect(result.ruleFindings).toContainEqual(
      expect.objectContaining({
        ruleId: "install-script.implicit-node-gyp",
        file: "package.json",
      }),
    );
  });

  test("report digest includes release-context finding annotations", async () => {
    stagedMock.fetchStagedPublishDetails.mockResolvedValue({
      id: "stage-digest123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      access: null,
      actor: null,
      actorType: null,
      createdAt: null,
      shasum: null,
      packageJson: null,
    });
    registryMock.fetchPackageMetadata.mockResolvedValue({
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" } },
      },
      "dist-tags": { latest: "1.0.0" },
    });

    const runWithPreviousText = async (previousText) => {
      dbMock.persistScan.mockClear();
      sandboxMock.downloadInSandbox.mockResolvedValue({
        files: [
          {
            path: "package.json",
            size: 40,
            sha256: "staged-pkg",
            flags: [],
            textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
          },
          {
            path: "index.js",
            size: 80,
            sha256: "staged-index",
            flags: [],
            textSample: "fetch('/existing-risk');\nexport const value = 2;\n",
          },
        ],
        packageJson: { name: "pkg", version: "1.0.1" },
      });
      publishedTarballMock.downloadPublishedTarball.mockResolvedValue({
        files: [
          {
            path: "package.json",
            size: 40,
            sha256: "previous-pkg",
            flags: [],
            textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
          },
          {
            path: "index.js",
            size: 80,
            sha256: "previous-index",
            flags: [],
            textSample: previousText,
          },
        ],
        packageJson: { name: "pkg", version: "1.0.0" },
      });

      await runScanPipeline(baseContext, npmAdapter, {
        scanId: `scan_${crypto.randomUUID()}`,
        stageId: "stage-digest123",
        organizationId: "org_1",
      });
      return dbMock.persistScan.mock.calls[0]?.[1].summary.report.digest;
    };

    const contextDigest = await runWithPreviousText(
      "fetch('/existing-risk');\nexport const value = 1;\n",
    );
    const releaseDigest = await runWithPreviousText("export const value = 1;\n");

    expect(contextDigest).toBeDefined();
    expect(releaseDigest).toBeDefined();
    expect(contextDigest).not.toBe(releaseDigest);
  });

  test("persists artifact risk as the primary scan risk while keeping release context", async () => {
    stagedMock.fetchStagedPublishDetails.mockResolvedValue({
      id: "stage-context123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      access: null,
      actor: null,
      actorType: null,
      createdAt: null,
      shasum: null,
      packageJson: null,
    });
    registryMock.fetchPackageMetadata.mockResolvedValue({
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" } },
      },
      "dist-tags": { latest: "1.0.0" },
    });
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 40,
          sha256: "staged-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "pkg", version: "1.0.1" }),
        },
        {
          path: "index.js",
          size: 80,
          sha256: "same-risk",
          flags: [],
          // Two co-occurring capabilities (process execution + network) so the
          // pre-existing finding rolls up to high under weighted scoring; a lone
          // child_process would (correctly) de-escalate to low.
          textSample:
            "require('child_process').execSync('true');\nfetch('https://example.invalid/ping');\n",
        },
      ],
      packageJson: { name: "pkg", version: "1.0.1" },
    });
    publishedTarballMock.downloadPublishedTarball.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 40,
          sha256: "previous-pkg",
          flags: [],
          textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
        },
        {
          path: "index.js",
          size: 80,
          sha256: "same-risk",
          flags: [],
          // Two co-occurring capabilities (process execution + network) so the
          // pre-existing finding rolls up to high under weighted scoring; a lone
          // child_process would (correctly) de-escalate to low.
          textSample:
            "require('child_process').execSync('true');\nfetch('https://example.invalid/ping');\n",
        },
      ],
      packageJson: { name: "pkg", version: "1.0.0" },
    });

    const result = await runScanPipeline(baseContext, npmAdapter, {
      scanId: "scan_context",
      stageId: "stage-context123",
      organizationId: "org_1",
    });

    const persistedInput = dbMock.persistScan.mock.calls[0]?.[1];

    expect(result.risk).toBe("high");
    expect(result.riskSummary).toMatchObject({
      artifactRisk: "high",
      releaseRisk: "low",
      contextRisk: "high",
      releaseFindingCount: 0,
      contextFindingCount: 2,
    });
    expect(result.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "index.js",
        ruleId: "code.process-execution",
      }),
    );
    expect(persistedInput).toMatchObject({
      risk: "high",
      summary: {
        risk: {
          artifactRisk: "high",
          releaseRisk: "low",
          contextRisk: "high",
        },
      },
    });
  });
});
