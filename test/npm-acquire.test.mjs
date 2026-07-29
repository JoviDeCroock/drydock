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

describe("acquireStagedNpm tarball verification", () => {
  const DECLARED = "cf6abd23c6a49417b8e8cd8635a1bba94a6fe5d2";
  const OTHER = "48283451416861c231a367b872a700c1ef002013";

  function brokerFor({ shasum, archiveSha1 }) {
    return {
      dispose() {},
      fetchPackageMetadata: vi.fn(async () => metadata()),
      fetchStagedDetails: vi.fn(async () => ({
        id: "stage-1",
        packageName: "pkg",
        version: "2.0.0",
        tag: "latest",
        shasum,
        packageJson: null,
      })),
      downloadStaged: vi.fn(async () => ({
        files: [{ path: "package.json", size: 10, sha256: "a", flags: [] }],
        packageJson: { name: "pkg", version: "2.0.0" },
        ...(archiveSha1 === undefined ? {} : { archiveSha1 }),
      })),
      downloadPublished: vi.fn(async () => {
        throw new Error("unused");
      }),
    };
  }

  test.each([
    ["verified", DECLARED, DECLARED, { status: "verified" }],
    ["mismatch", DECLARED, OTHER, { status: "mismatch", declared: DECLARED, computed: OTHER }],
    [
      "unverified when the sandbox reports no digest",
      DECLARED,
      null,
      { status: "unverified", reason: "computed-digest-unavailable" },
    ],
    [
      "unverified when the registry reports no shasum",
      null,
      DECLARED,
      { status: "unverified", reason: "declared-digest-missing" },
    ],
  ])(
    "records the staged tarball digest verdict: %s",
    async (_name, shasum, archiveSha1, expected) => {
      const result = await acquireStagedNpm(
        {},
        { stageId: "stage-1" },
        brokerFor({ shasum, archiveSha1 }),
      );

      expect(result.details.artifactIntegrity).toMatchObject(expected);
    },
  );

  test("confirms a mismatch against a fresh read of the stage record before accusing", async () => {
    // The bytes and the digest they are checked against come from two
    // independent requests. A stage rewritten between them (or a replica
    // serving an older record) would otherwise raise a critical finding about
    // two artifacts that were each internally consistent.
    const broker = brokerFor({ shasum: OTHER, archiveSha1: DECLARED });
    let call = 0;
    broker.fetchStagedDetails = vi.fn(async () => ({
      id: "stage-1",
      packageName: "pkg",
      version: "2.0.0",
      tag: "latest",
      shasum: call++ === 0 ? OTHER : DECLARED,
      packageJson: null,
    }));

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(broker.fetchStagedDetails).toHaveBeenCalledTimes(2);
    expect(result.details.artifactIntegrity).toMatchObject({ status: "verified" });
  });

  test("keeps the mismatch when the stage record still disagrees on re-read", async () => {
    const broker = brokerFor({ shasum: OTHER, archiveSha1: DECLARED });

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(broker.fetchStagedDetails).toHaveBeenCalledTimes(2);
    expect(result.details.artifactIntegrity).toMatchObject({
      status: "mismatch",
      declared: OTHER,
      computed: DECLARED,
    });
  });

  test("keeps the mismatch when the confirming read fails", async () => {
    // Two well-formed digests that disagree are still evidence; a registry
    // that cannot be re-read is not a reason to drop the finding.
    const broker = brokerFor({ shasum: OTHER, archiveSha1: DECLARED });
    let call = 0;
    const first = broker.fetchStagedDetails;
    broker.fetchStagedDetails = vi.fn(async () => (call++ === 0 ? first() : null));

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(result.details.artifactIntegrity).toMatchObject({ status: "mismatch" });
  });

  test("does not re-read the stage record when the digests agree", async () => {
    const broker = brokerFor({ shasum: DECLARED, archiveSha1: DECLARED });

    await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(broker.fetchStagedDetails).toHaveBeenCalledTimes(1);
  });

  test("keeps details null when the registry has no stage metadata to attach a verdict to", async () => {
    const broker = brokerFor({ shasum: DECLARED, archiveSha1: DECLARED });
    broker.fetchStagedDetails = vi.fn(async () => null);

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(result.details).toBeNull();
    expect(result.artifact.files).toHaveLength(1);
  });
});
