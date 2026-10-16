import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PackageJsonDiff, PackageJsonDiffEntry } from "../server/lib/review/serialize";

const FEED_URL = "https://malware-list.aikido.dev/malware_predictions.json";
const NOW = Date.parse("2026-10-11T09:00:00.000Z");

function diff(
  rows: PackageJsonDiffEntry[] = [{ key: "example", status: "added", staged: "1.2.3" }],
): PackageJsonDiff {
  return {
    name: "reviewed-package",
    hasPreviousManifest: true,
    previousVersion: "1.0.0",
    stagedVersion: "1.0.1",
    scripts: [],
    dependencies: rows,
    bin: [],
    entrypointsChanged: false,
  };
}

function prediction(packageName: string, version: string, reason = "MALWARE") {
  return { package_name: packageName, version, reason };
}

function feed(entries: unknown[] = []): Response {
  return Response.json(entries);
}

let enrich: typeof import("../server/lib/ecosystems/npm/dependency-intel").enrichNpmDependencyIntel;
let cacheResponse: Response | undefined;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let cacheMatch: ReturnType<typeof vi.fn>;
let cachePut: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  cacheResponse = undefined;
  fetchMock = vi.fn<typeof fetch>(async () => feed());
  cacheMatch = vi.fn(async () => cacheResponse?.clone());
  cachePut = vi.fn(async (_key: Request, response: Response) => {
    cacheResponse = response;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ enrichNpmDependencyIntel: enrich } =
    await import("../server/lib/ecosystems/npm/dependency-intel"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("npm dependency Intel matching", () => {
  test("fetches the complete public feed without disclosing reviewed dependency identities", async () => {
    const result = await enrich(
      diff([{ key: "@private/dependency", status: "added", staged: "^3.0.0" }]),
      null,
    );
    expect(result.dependencies[0].intel?.status).toBe("no_known_malware");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(FEED_URL, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("@private");
    expect(JSON.stringify(cacheMatch.mock.calls)).not.toContain("@private");
  });

  test("only recognizes MALWARE reasons and keeps npm names case sensitive", async () => {
    fetchMock.mockResolvedValueOnce(
      feed([
        prediction("example", "1.2.3", "malware"),
        prediction("other", "*", "PROTESTWARE"),
        prediction("other", "*", "TELEMETRY"),
        prediction("Example", "*"),
      ]),
    );
    const result = await enrich(
      diff([
        { key: "example", status: "added", staged: "1.2.3" },
        { key: "other", status: "added", staged: "1.2.3" },
        { key: "EXAMPLE", status: "added", staged: "1.2.3" },
      ]),
      null,
    );
    expect(result.dependencies.map((row) => row.intel?.status)).toEqual([
      "known_malware",
      "no_known_malware",
      "no_known_malware",
    ]);
    expect(result.dependencies[0].intel).toMatchObject({
      checkedAt: new Date(NOW).toISOString(),
      matchKind: "exact",
      matchedVersions: ["1.2.3"],
      matchedVersionCount: 1,
    });
  });

  test("preserves exact build identifiers while normalizing exact v and equals syntax", async () => {
    fetchMock.mockResolvedValueOnce(feed([prediction("example", "1.2.3+reviewed")]));
    const result = await enrich(
      diff([
        { key: "example", status: "added", staged: "= v1.2.3+reviewed" },
        { key: "example", status: "modified", staged: "1.2.3+other" },
        { key: "example", status: "modified", staged: "1.2.3" },
      ]),
      null,
    );
    expect(result.dependencies.map((row) => row.intel?.status)).toEqual([
      "known_malware",
      "no_known_malware",
      "no_known_malware",
    ]);
  });

  test("matches admitted range versions without turning the range floor into a resolved version", async () => {
    fetchMock.mockResolvedValueOnce(
      feed([
        prediction("example", "1.2.4"),
        prediction("example", "1.3.0-beta.1"),
        prediction("example", "2.0.0"),
      ]),
    );
    const result = await enrich(
      diff([
        { key: "example", status: "added", staged: "^1.2.3" },
        { key: "example", status: "modified", staged: "^1.3.0-beta.1" },
        { key: "example", status: "modified", staged: "~1.2.3 || >=2.0.0 <3" },
      ]),
      null,
    );
    expect(result.dependencies.map((row) => row.intel?.matchedVersions)).toEqual([
      ["1.2.4"],
      ["1.3.0-beta.1"],
      ["1.2.4", "2.0.0"],
    ]);
    expect(result.dependencies.every((row) => row.intel?.matchKind === "range")).toBe(true);
  });

  test("treats feed wildcard versions as matching every valid declaration including prereleases", async () => {
    fetchMock.mockResolvedValueOnce(feed([prediction("example", "*")]));
    const result = await enrich(
      diff([
        { key: "example", status: "added", staged: "1.0.0-beta.1+build" },
        { key: "example", status: "modified", staged: "^99.0.0" },
        { key: "example", status: "modified", staged: "*" },
      ]),
      null,
    );
    expect(result.dependencies.every((row) => row.intel?.status === "known_malware")).toBe(true);
    expect(result.dependencies.every((row) => row.intel?.matchedVersions?.[0] === "*")).toBe(true);
  });

  test("checks the actual package behind unscoped and scoped npm aliases", async () => {
    fetchMock.mockResolvedValueOnce(
      feed([
        prediction("actual", "2.0.0"),
        prediction("@scope/actual", "*"),
        prediction("alias-only", "*"),
      ]),
    );
    const result = await enrich(
      diff([
        { key: "friendly", status: "added", staged: "npm:actual@^2.0.0" },
        { key: "friendly-scoped", status: "modified", staged: "npm:@scope/actual@1.0.0" },
        { key: "alias-only", status: "added", staged: "npm:unlisted@1.0.0" },
      ]),
      null,
    );
    expect(result.dependencies.map((row) => row.intel?.packageName)).toEqual([
      "actual",
      "@scope/actual",
      "unlisted",
    ]);
    expect(result.dependencies.map((row) => row.intel?.status)).toEqual([
      "known_malware",
      "known_malware",
      "no_known_malware",
    ]);
  });

  test("skips removed rows, invalid names, tags, remote/local specs, and malformed aliases without fetching", async () => {
    const rows: PackageJsonDiffEntry[] = [
      {
        key: "removed",
        status: "removed",
        previous: "1.0.0",
        intel: { provider: "aikido", status: "known_malware", packageName: "removed" },
      },
      { key: "invalid/name", status: "added", staged: "1.0.0" },
      ...[
        "latest",
        "git+https://example.org/code",
        "https://example.org/a.tgz",
        "file:../local",
        "workspace:*",
        "npm:missing-version",
        "npm:@bad@1.0.0",
        "1".repeat(501),
      ].map((staged) => ({ key: "example", status: "added" as const, staged })),
    ];
    const result = await enrich(diff(rows), null);
    expect(result.dependencies[0].intel).toBeUndefined();
    expect(result.dependencies.slice(1).every((row) => row.intel?.status === "not_checked")).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(rows[0].intel?.status).toBe("known_malware");
    expect(result.dependencies.every((row, index) => row !== rows[index])).toBe(true);
  });

  test("counts distinct matches while limiting displayed versions to five", async () => {
    fetchMock.mockResolvedValueOnce(
      feed([
        ...Array.from({ length: 8 }, (_, index) => prediction("example", `1.0.${index}`)),
        prediction("example", "1.0.0"),
      ]),
    );
    const result = await enrich(diff([{ key: "example", status: "added", staged: "^1" }]), null);
    expect(result.dependencies[0].intel).toMatchObject({ matchedVersionCount: 8 });
    expect(result.dependencies[0].intel?.matchedVersions).toEqual([
      "1.0.0",
      "1.0.1",
      "1.0.2",
      "1.0.3",
      "1.0.4",
    ]);
  });
});

describe("npm dependency Intel availability and cache", () => {
  test.each([
    null,
    {},
    [prediction("example", "1.2.3"), { package_name: "unrelated", version: "1.0.0" }],
    [prediction("example", "not-a-version")],
    [prediction("example", "1.2.3", "")],
    [prediction("example", "1.2.3", "NEW_CLASSIFIER")],
  ])("makes malformed feed %j unavailable rather than clearing a dependency", async (value) => {
    fetchMock.mockResolvedValueOnce(Response.json(value));
    const result = await enrich(diff(), null);
    expect(result.dependencies[0].intel).toEqual({
      provider: "aikido",
      status: "unavailable",
      packageName: "example",
    });
  });

  test("bounds response size before parsing and rejects HTTP failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("[]", {
        headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      }),
    );
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("unavailable");
    vi.setSystemTime(NOW + 30_000);
    fetchMock.mockResolvedValueOnce(new Response("untrusted error", { status: 502 }));
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("bounds the full body read when headers arrive but the body stalls", async () => {
    const cancelled = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("["));
          },
          cancel: cancelled,
        }),
      ),
    );
    const pending = enrich(diff(), null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).dependencies[0].intel?.status).toBe("unavailable");
    expect(cancelled).toHaveBeenCalled();
  });

  test("aborts a stalled fetch and logs no reviewed identity or raw vendor error", async () => {
    fetchMock.mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("raw-private-example")));
        }),
    );
    const pending = enrich(diff(), null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).dependencies[0].intel?.status).toBe("unavailable");
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logs).toContain("dependency.intel.unavailable");
    expect(logs).not.toContain("example");
    expect(logs).not.toContain("raw-private");
  });

  test("deduplicates concurrent feed loads and keeps repeated rows independent", async () => {
    fetchMock.mockResolvedValueOnce(feed([prediction("example", "1.2.3")]));
    const rows: PackageJsonDiffEntry[] = [
      { key: "example", status: "added", staged: "1.2.3", section: "dependencies" },
      { key: "example", status: "added", staged: "1.2.3", section: "peerDependencies" },
    ];
    const results = await Promise.all([enrich(diff(rows), null), enrich(diff(), null)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    results[0].dependencies[0].intel?.matchedVersions?.push("mutated");
    expect(results[0].dependencies[1].intel?.matchedVersions).toEqual(["1.2.3"]);
    expect(results[1].dependencies[0].intel?.matchedVersions).toEqual(["1.2.3"]);
  });

  test("preserves the source timestamp through the colo cache and refreshes at absolute expiry", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as ExecutionContext;
    const first = await enrich(diff(), ctx);
    await Promise.all(waits);
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(cacheResponse?.headers.get("cache-control")).toBe("public, max-age=900");
    vi.resetModules();
    ({ enrichNpmDependencyIntel: enrich } =
      await import("../server/lib/ecosystems/npm/dependency-intel"));
    vi.setSystemTime(NOW + 14 * 60_000);
    const cached = await enrich(diff(), null);
    expect(cached.dependencies[0].intel?.checkedAt).toBe(first.dependencies[0].intel?.checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 15 * 60_000);
    fetchMock.mockRejectedValueOnce(new Error("outage"));
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries unavailable snapshots after thirty seconds without reviving stale negative data", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as ExecutionContext;
    fetchMock.mockRejectedValueOnce(new Error("outage"));
    await enrich(diff(), ctx);
    await Promise.all(waits);
    expect(cacheResponse?.headers.get("cache-control")).toBe("public, max-age=30");
    vi.resetModules();
    ({ enrichNpmDependencyIntel: enrich } =
      await import("../server/lib/ecosystems/npm/dependency-intel"));
    vi.setSystemTime(NOW + 29_999);
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 30_000);
    fetchMock.mockResolvedValueOnce(feed([prediction("example", "*")]));
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("known_malware");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    { status: "complete", checkedAt: new Date(NOW + 1).toISOString(), packages: [] },
    { status: "complete", checkedAt: "invalid", packages: [] },
    {
      status: "complete",
      checkedAt: new Date(NOW).toISOString(),
      packages: [["example", ["bad"]]],
    },
  ])("refreshes malformed or future cache snapshots", async (snapshot) => {
    cacheResponse = Response.json(snapshot);
    fetchMock.mockResolvedValueOnce(feed([prediction("example", "*")]));
    expect((await enrich(diff(), null)).dependencies[0].intel?.status).toBe("known_malware");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cache read or write failure does not discard a validated feed", async () => {
    cacheMatch.mockRejectedValueOnce(new Error("cache read failed"));
    cachePut.mockRejectedValueOnce(new Error("cache write failed"));
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as ExecutionContext;
    const result = await enrich(diff(), ctx);
    await Promise.all(waits);
    expect(result.dependencies[0].intel?.status).toBe("no_known_malware");
  });
});
