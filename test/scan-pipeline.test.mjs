import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  persistScan: vi.fn(async () => ({ persisted: true })),
  recordScanEvent: vi.fn(async () => undefined),
}));
const registryMock = vi.hoisted(() => ({
  fetchPackageMetadata: vi.fn(),
}));
const sandboxMock = vi.hoisted(() => ({
  downloadInSandbox: vi.fn(),
}));
const stagedMock = vi.hoisted(() => ({
  fetchStagedPublishDetails: vi.fn(),
}));

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/registry.ts", async () => ({
  ...(await vi.importActual("../server/lib/registry.ts")),
  fetchPackageMetadata: registryMock.fetchPackageMetadata,
}));
vi.mock("../server/lib/sandbox.ts", () => sandboxMock);
vi.mock("../server/lib/staged-publishes.ts", async () => ({
  ...(await vi.importActual("../server/lib/staged-publishes.ts")),
  fetchStagedPublishDetails: stagedMock.fetchStagedPublishDetails,
}));

const { runScanPipeline } = await import("../server/lib/scan-pipeline.ts");

describe("scan pipeline baseline selection", () => {
  beforeEach(() => {
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
    sandboxMock.downloadInSandbox.mockImplementation(async (_env, _ctx, options) => {
      if (options.stageId) {
        return {
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
        };
      }
      return {
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
      };
    });
  });

  afterEach(() => {
    dbMock.persistScan.mockClear();
    dbMock.recordScanEvent.mockClear();
    registryMock.fetchPackageMetadata.mockReset();
    sandboxMock.downloadInSandbox.mockReset();
    stagedMock.fetchStagedPublishDetails.mockReset();
  });

  test("diffs a staged beta release against the current beta dist-tag target", async () => {
    const result = await runScanPipeline(
      {
        env: { NPM_REGISTRY: "https://registry.npmjs.org" },
        executionCtx: {},
        db: {},
        session: { userId: "user_1" },
      },
      {
        scanId: "scan_1",
        stageId: "stage-beta-123",
        organizationId: "org_1",
        npmToken: "npm_secret_token",
      },
    );

    expect(stagedMock.fetchStagedPublishDetails).toHaveBeenCalledWith(
      "https://registry.npmjs.org",
      "npm_secret_token",
      "stage-beta-123",
    );
    expect(sandboxMock.downloadInSandbox.mock.calls[1]?.[2]).toMatchObject({
      tarballUrl: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.2.tgz",
    });
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

    const result = await runScanPipeline(
      {
        env: { NPM_REGISTRY: "https://registry.npmjs.org" },
        executionCtx: {},
        db: {},
        session: { userId: "user_1" },
      },
      {
        scanId: "scan_1",
        stageId: "stage-beta-123",
        organizationId: "org_1",
        npmToken: "npm_secret_token",
      },
    );

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

    const result = await runScanPipeline(
      {
        env: { NPM_REGISTRY: "https://registry.npmjs.org" },
        executionCtx: {},
        db: {},
        session: { userId: "user_1" },
      },
      {
        stageId: "stage-gyp123",
        organizationId: "org_1",
        npmToken: "npm_token_0123456789",
        npmRegistry: "https://registry.npmjs.org",
      },
    );

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

    const result = await runScanPipeline(
      {
        env: { NPM_REGISTRY: "https://registry.npmjs.org" },
        executionCtx: {},
        db: {},
        session: { userId: "user_1" },
      },
      {
        stageId: "stage-abc123",
        organizationId: "org_1",
        npmToken: "npm_token_0123456789",
        npmRegistry: "https://registry.npmjs.org",
      },
    );

    expect(stagedMock.fetchStagedPublishDetails).toHaveBeenCalledWith(
      "https://registry.npmjs.org",
      "npm_token_0123456789",
      "stage-abc123",
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
      sandboxMock.downloadInSandbox.mockImplementation(async (_env, _ctx, options) => {
        if (options.stageId) {
          return {
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
          };
        }
        return {
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
        };
      });

      await runScanPipeline(
        {
          env: { NPM_REGISTRY: "https://registry.npmjs.org" },
          executionCtx: {},
          db: {},
          session: { userId: "user_1" },
        },
        {
          scanId: `scan_${crypto.randomUUID()}`,
          stageId: "stage-digest123",
          organizationId: "org_1",
          npmToken: "npm_token_0123456789",
          npmRegistry: "https://registry.npmjs.org",
        },
      );
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
});
