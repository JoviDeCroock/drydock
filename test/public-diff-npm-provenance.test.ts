import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPublicPackageMetadata: vi.fn(),
  downloadPublishedTarball: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../server/lib/ecosystems/npm/public-metadata", () => ({
  fetchPublicPackageMetadata: mocks.fetchPublicPackageMetadata,
}));
vi.mock("../server/lib/ecosystems/npm/published-tarball", async () => ({
  ...(await vi.importActual("../server/lib/ecosystems/npm/published-tarball")),
  downloadPublishedTarball: mocks.downloadPublishedTarball,
}));

const { npmPublicDiff } = await import("../server/lib/ecosystems/npm/public-diff");
const { createPackageDiff, summarizePackageJsonDiff } = await import("../server/lib/review");

const PUBLIC = "https://registry.npmjs.org";

function archive(version: string) {
  const packageJson = { name: "example-widget", version };
  return {
    files: [
      {
        path: "package.json",
        size: 40,
        sha256: `sha-${version}`,
        flags: [],
        textSample: JSON.stringify(packageJson),
      },
    ],
    packageJson,
    suspiciousEntries: [],
  };
}

function metadata(fromProvenance: boolean, toProvenance: boolean) {
  return {
    versions: {
      "1.0.0": {
        dist: { tarball: `${PUBLIC}/example-widget/-/example-widget-1.0.0.tgz` },
        hasProvenance: fromProvenance,
      },
      "1.0.1": {
        dist: { tarball: `${PUBLIC}/example-widget/-/example-widget-1.0.1.tgz` },
        hasProvenance: toProvenance,
      },
    },
  };
}

async function acquireFindings(registryUrl = PUBLIC) {
  const sources = await npmPublicDiff.acquire({} as Cloudflare.Env, {} as ExecutionContext, {
    ecosystem: "npm",
    packageName: "example-widget",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    registryUrl,
  });
  const fileDiff = createPackageDiff(sources.from.files, sources.to.files);
  const manifestDiff = summarizePackageJsonDiff(sources.from.packageJson, sources.to.packageJson);
  return sources.buildFindings(fileDiff, manifestDiff).map((f) => f.ruleId);
}

describe("npm public diff provenance continuity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("a published pair that drops provenance carries the release finding", async () => {
    mocks.fetchPublicPackageMetadata.mockResolvedValue(metadata(true, false));
    mocks.downloadPublishedTarball.mockImplementation(async (_env, _ctx, url: string) =>
      archive(url.includes("1.0.1") ? "1.0.1" : "1.0.0"),
    );
    // The baseline's attestations document is unreadable: presence alone still
    // carries the drop.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    expect(await acquireFindings()).toContain("release.provenance-dropped");
  });

  test("a custom registry never evaluates provenance", async () => {
    const registry = "https://npm.example.invalid";
    mocks.fetchPublicPackageMetadata.mockResolvedValue({
      versions: {
        "1.0.0": { dist: { tarball: `${registry}/a/-/a-1.0.0.tgz` }, hasProvenance: true },
        "1.0.1": { dist: { tarball: `${registry}/a/-/a-1.0.1.tgz` }, hasProvenance: false },
      },
    });
    mocks.downloadPublishedTarball.mockImplementation(async (_env, _ctx, url: string) =>
      archive(url.includes("1.0.1") ? "1.0.1" : "1.0.0"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await acquireFindings(registry)).not.toContain("release.provenance-dropped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
