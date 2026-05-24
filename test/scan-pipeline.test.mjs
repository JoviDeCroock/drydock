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
});
