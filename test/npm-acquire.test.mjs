import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { acquireBaselineNpm, acquireStagedNpm } =
  await import("../server/lib/ecosystems/npm/acquire");
const { SandboxError } = await import("../server/lib/sandbox");
const { BASELINE_TEXT_SAMPLE_LIMIT } = await import("../server/lib/sample-retention");

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
      fetchTrustConfigs: vi.fn(async () => ({ state: "unavailable", httpStatus: null })),
      fetchBuildIdentity: vi.fn(async () => null),
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
    // The baseline is parsed with the sandbox-side text-sample cap; the staged
    // side never is (issue #191).
    expect(broker.downloadPublished).toHaveBeenCalledWith(
      "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
      { maxFiles: undefined, maxTextSampleChars: BASELINE_TEXT_SAMPLE_LIMIT },
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
      fetchTrustConfigs: vi.fn(async () => ({ state: "unavailable", httpStatus: null })),
      fetchBuildIdentity: vi.fn(async () => null),
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
      fetchTrustConfigs: vi.fn(async () => ({ state: "unavailable", httpStatus: null })),
      fetchBuildIdentity: vi.fn(async () => null),
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
      fetchTrustConfigs: vi.fn(async () => ({ state: "unavailable", httpStatus: null })),
      fetchBuildIdentity: vi.fn(async () => null),
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
      fetchTrustConfigs: vi.fn(async () => ({ state: "unavailable", httpStatus: null })),
      fetchBuildIdentity: vi.fn(async () => null),
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
    broker.fetchStagedDetails = vi.fn(async () => {
      const current = call++;
      return {
        id: "stage-1",
        packageName: "pkg",
        version: "2.0.0",
        tag: current === 0 ? "stale-tag" : "fresh-tag",
        shasum: current === 0 ? OTHER : DECLARED,
        packageJson: {
          dependencies: current === 0 ? { stale: "1.0.0" } : { fresh: "2.0.0" },
        },
      };
    });

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(broker.fetchStagedDetails).toHaveBeenCalledTimes(2);
    expect(result.details.artifactIntegrity).toMatchObject({ status: "verified" });
    expect(result.details).toMatchObject({ tag: "fresh-tag", shasum: DECLARED });
    expect(result.artifact.manifest.dependencies).toEqual({ fresh: "2.0.0" });
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

  test("leaves the review unverified when the confirming read fails", async () => {
    // The initial pair may describe two generations of a mutable stage. A
    // failed fresh read cannot turn that race into a critical accusation.
    const broker = brokerFor({ shasum: OTHER, archiveSha1: DECLARED });
    let call = 0;
    const first = broker.fetchStagedDetails;
    broker.fetchStagedDetails = vi.fn(async () => (call++ === 0 ? first() : null));

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(result.details.artifactIntegrity).toEqual({
      algorithm: "sha1",
      status: "unverified",
      declared: OTHER,
      computed: DECLARED,
      reason: "stage-record-confirmation-unavailable",
    });
  });

  test("does not re-read the stage record when the digests agree", async () => {
    const broker = brokerFor({ shasum: DECLARED, archiveSha1: DECLARED });

    await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(broker.fetchStagedDetails).toHaveBeenCalledTimes(1);
  });

  test("persists an unverified verdict when the registry has no stage metadata", async () => {
    const broker = brokerFor({ shasum: DECLARED, archiveSha1: DECLARED });
    broker.fetchStagedDetails = vi.fn(async () => null);

    const result = await acquireStagedNpm({}, { stageId: "stage-1" }, broker);

    expect(result.details).toEqual({
      id: "stage-1",
      packageName: null,
      version: null,
      tag: null,
      access: null,
      actor: null,
      actorType: null,
      createdAt: null,
      shasum: null,
      packageJson: null,
      artifactIntegrity: {
        algorithm: "sha1",
        status: "unverified",
        declared: null,
        computed: DECLARED,
        reason: "declared-digest-missing",
      },
      publisher: {
        actor: null,
        actorType: null,
        trustConfigs: null,
        trustConfigsState: "unavailable",
        previousBuild: null,
        stagedBuild: null,
      },
    });
    expect(result.artifact.files).toHaveLength(1);
  });
});
