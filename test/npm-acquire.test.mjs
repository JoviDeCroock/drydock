import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { acquireBaselineNpm, acquireStagedNpm } =
  await import("../server/lib/ecosystems/npm/acquire");
const { SandboxError } = await import("../server/lib/sandbox");

function stagedArtifact() {
  return {
    artifact: {
      files: [],
      manifest: { name: "pkg", version: "2.0.0" },
    },
    details: { tag: "latest" },
  };
}

function metadata() {
  return {
    versions: {
      "1.0.0": { dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" } },
    },
    "dist-tags": { latest: "1.0.0" },
  };
}

describe("acquireBaselineNpm", () => {
  test.each([
    [
      "local SandboxError",
      () => new SandboxError(JSON.stringify({ error: "tarball too large", status: 413 })),
    ],
    [
      "RPC-safe SandboxError",
      () => {
        const err = new Error(JSON.stringify({ error: "tarball too large", status: 413 }));
        err.name = "SandboxError";
        return err;
      },
    ],
  ])("degrades oversized baseline downloads for %s", async (_name, makeError) => {
    const broker = {
      dispose() {},
      fetchPackageMetadata: vi.fn(async () => metadata()),
      fetchStagedDetails: vi.fn(async () => null),
      downloadStaged: vi.fn(async () => {
        throw new Error("unused");
      }),
      downloadPublished: vi.fn(async () => {
        throw makeError();
      }),
    };

    const result = await acquireBaselineNpm({}, {}, broker, stagedArtifact());

    expect(result.artifact).toBeNull();
    expect(result.baseline).toMatchObject({
      version: "1.0.0",
      reason: "dist-tag:latest:baseline-too-large",
    });
    expect(broker.downloadPublished).toHaveBeenCalledWith(
      "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
      { maxFiles: undefined },
    );
  });

  test.each([
    ["too large", "tarball too large", "dist-tag:latest:baseline-too-large"],
    ["expansion bomb", "archive expands beyond safety limit", "dist-tag:latest:baseline-too-large"],
    [
      "too many files",
      "archive contains too many files",
      "dist-tag:latest:baseline-too-many-files",
    ],
  ])("labels a 413 %s baseline with its actual cause", async (_name, error, expectedReason) => {
    const broker = {
      dispose() {},
      fetchPackageMetadata: vi.fn(async () => metadata()),
      fetchStagedDetails: vi.fn(async () => null),
      downloadStaged: vi.fn(async () => {
        throw new Error("unused");
      }),
      downloadPublished: vi.fn(async () => {
        throw new SandboxError(JSON.stringify({ error, status: 413 }));
      }),
    };

    const result = await acquireBaselineNpm({}, {}, broker, stagedArtifact());

    expect(result.artifact).toBeNull();
    expect(result.baseline).toMatchObject({ version: "1.0.0", reason: expectedReason });
  });

  test("rethrows a non-safety-limit sandbox error instead of degrading", async () => {
    const broker = {
      dispose() {},
      fetchPackageMetadata: vi.fn(async () => metadata()),
      fetchStagedDetails: vi.fn(async () => null),
      downloadStaged: vi.fn(async () => {
        throw new Error("unused");
      }),
      downloadPublished: vi.fn(async () => {
        throw new SandboxError(JSON.stringify({ error: "download failed", status: 502 }));
      }),
    };

    await expect(acquireBaselineNpm({}, {}, broker, stagedArtifact())).rejects.toThrow();
  });
});

describe("acquireStagedNpm", () => {
  test("preserves the browser entrypoint when staged metadata is merged", async () => {
    const browser = "dist/browser.js";
    const broker = {
      dispose() {},
      downloadStaged: vi.fn(async () => ({
        files: [],
        packageJson: { name: "pkg", version: "2.0.0", browser },
      })),
      fetchStagedDetails: vi.fn(async () => ({
        packageName: "pkg",
        version: "2.0.0",
        packageJson: { name: "pkg", version: "2.0.0" },
      })),
    };

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(result.artifact.manifest).toMatchObject({ browser });
  });
});
