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
const { loadPublicPackageDiff, payloadCacheTtlSeconds } = await import("../server/lib/public-diff");

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

function metadata(fromProvenance: boolean | undefined, toProvenance: boolean | undefined) {
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

async function acquireFindings(registryUrl = PUBLIC, fromVersion = "1.0.0", toVersion = "1.0.1") {
  const sources = await npmPublicDiff.acquire({} as Cloudflare.Env, {} as ExecutionContext, {
    ecosystem: "npm",
    packageName: "example-widget",
    fromVersion,
    toVersion,
    registryUrl,
  });
  const fileDiff = createPackageDiff(sources.from.files, sources.to.files);
  const manifestDiff = summarizePackageJsonDiff(sources.from.packageJson, sources.to.packageJson);
  return sources.buildFindings(fileDiff, manifestDiff).map((f) => f.ruleId);
}

async function acquireSeverities(fromVersion: string, toVersion: string) {
  const sources = await npmPublicDiff.acquire({} as Cloudflare.Env, {} as ExecutionContext, {
    ecosystem: "npm",
    packageName: "example-widget",
    fromVersion,
    toVersion,
    registryUrl: PUBLIC,
  });
  return sources
    .buildFindings([], summarizePackageJsonDiff(null, null))
    .filter((f) => f.ruleId?.startsWith("release.provenance"))
    .map((f) => `${f.ruleId}:${f.severity}`);
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

  test("a reversed pair is not evaluated", async () => {
    // 1.0.1 is attested and 1.0.0 is not; diffing newer -> older must not read
    // as the older release dropping provenance.
    mocks.fetchPublicPackageMetadata.mockResolvedValue(metadata(false, true));
    mocks.downloadPublishedTarball.mockImplementation(async (_env, _ctx, url: string) =>
      archive(url.includes("1.0.1") ? "1.0.1" : "1.0.0"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await acquireFindings(PUBLIC, "1.0.1", "1.0.0")).not.toContain(
      "release.provenance-dropped",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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

  test("a hand-published stable after a CI-built prerelease is low, not medium", async () => {
    const tarball = (version: string) => `${PUBLIC}/example-widget/-/example-widget-${version}.tgz`;
    mocks.fetchPublicPackageMetadata.mockResolvedValue({
      versions: {
        "1.0.0": { dist: { tarball: tarball("1.0.0") }, hasProvenance: false },
        "2.0.0-rc.1": { dist: { tarball: tarball("2.0.0-rc.1") }, hasProvenance: true },
        "2.0.0": { dist: { tarball: tarball("2.0.0") }, hasProvenance: false },
      },
    });
    mocks.downloadPublishedTarball.mockImplementation(async (_env, _ctx, url: string) =>
      archive(url.includes("2.0.0.tgz") ? "2.0.0" : "2.0.0-rc.1"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    expect(await acquireSeverities("2.0.0-rc.1", "2.0.0")).toEqual([
      "release.provenance-dropped:low",
    ]);
  });

  test("an undetermined provenance read keeps the cached diff short-lived", async () => {
    mocks.downloadPublishedTarball.mockImplementation(async (_env, _ctx, url: string) =>
      archive(url.includes("1.0.1") ? "1.0.1" : "1.0.0"),
    );
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("caches", {
      default: { match: async () => undefined, put: async () => undefined },
    });
    const ttlFor = async (from: boolean | undefined, to: boolean | undefined) => {
      mocks.fetchPublicPackageMetadata.mockResolvedValue(metadata(from, to));
      const puts: Array<{ expirationTtl?: number }> = [];
      const env = {
        COMPARE_CACHE: {
          get: async () => null,
          put: async (_key: string, _value: string, options: { expirationTtl?: number }) => {
            puts.push(options);
          },
        },
      } as unknown as Cloudflare.Env;
      const payload = await loadPublicPackageDiff(env, {} as ExecutionContext, {
        ecosystem: "npm",
        packageName: "example-widget",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        registryUrl: PUBLIC,
      });
      return { payload, kvTtl: puts[0]?.expirationTtl };
    };

    const settled = await ttlFor(false, false);
    expect(settled.payload.cacheExpiresAt).toBeUndefined();
    expect(settled.kvTtl).toBe(60 * 60 * 24 * 30);

    // A packument cached before the provenance marker was projected.
    const unsettled = await ttlFor(undefined, false);
    expect(unsettled.kvTtl).toBeGreaterThan(60 * 14);
    expect(unsettled.kvTtl).toBeLessThanOrEqual(60 * 15);
    // Rewarms read the remaining lifetime, never a fresh 30 days.
    const later = Date.parse(unsettled.payload.cacheExpiresAt!) - 60_000;
    expect(payloadCacheTtlSeconds(unsettled.payload, later)).toBe(60);
    expect(payloadCacheTtlSeconds(unsettled.payload, later + 120_000)).toBe(0);
  });
});
