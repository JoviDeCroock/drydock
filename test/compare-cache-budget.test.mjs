import { describe, expect, test, vi } from "vitest";

const publishedTarballMock = vi.hoisted(() => ({
  downloadPublishedTarball: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));
vi.mock("../server/lib/ecosystems/npm/published-tarball", () => publishedTarballMock);

const { loadCompare, serializeCompareCachePayload, writeCompareCache } =
  await import("../server/lib/compare-cache");

function file(path, sampleBytes, flags = []) {
  return {
    path,
    size: sampleBytes,
    sha256: "a".repeat(64),
    textSample: "x".repeat(sampleBytes),
    flags,
  };
}

function payload(files) {
  return {
    version: "2.3.4",
    files,
    packageJson: { name: "pkg", version: "2.3.4" },
    cachedAt: "2026-07-20T00:00:00.000Z",
  };
}

function parse(serialized) {
  return JSON.parse(serialized);
}

function bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The metadata-only floor for a payload: what it costs with every sample dropped.
 * Measured rather than hardcoded so the budgets below stay meaningful if the
 * record shape changes.
 */
function sampleFloorBytes(input) {
  return bytes(serializeCompareCachePayload(input, 0).serialized);
}

describe("serializeCompareCachePayload", () => {
  test("leaves a payload inside the budget untouched", () => {
    const input = payload([file("index.js", 100)]);
    const { serialized, samplesOmitted, cached } = serializeCompareCachePayload(input, 1_000_000);
    expect(samplesOmitted).toBe(false);
    expect(cached).toBe(input);
    expect(parse(serialized)).toEqual(input);
  });

  test("sheds the most expensive samples first and flags the records that lost one", () => {
    // Budget fits the metadata floor plus the two cheap samples, not the big one.
    const input = payload([file("small.js", 40), file("medium.js", 60), file("huge.js", 4000)]);
    const { serialized, samplesOmitted, cached } = serializeCompareCachePayload(
      input,
      sampleFloorBytes(input) + 200,
    );
    expect(samplesOmitted).toBe(true);

    const reduced = parse(serialized);
    expect(cached).toEqual(reduced);
    expect(cached).not.toBe(input);
    expect(reduced.textSamplesOmitted).toBe(true);
    const byPath = new Map(reduced.files.map((item) => [item.path, item]));
    expect(byPath.get("small.js").textSample).toBe("x".repeat(40));
    expect(byPath.get("medium.js").textSample).toBe("x".repeat(60));
    expect(byPath.get("huge.js")).not.toHaveProperty("textSample");
    // The workbench needs to be able to say WHY the body is missing rather than
    // implying the parser never captured one.
    expect(byPath.get("huge.js").flags).toContain("sample-omitted");
    expect(byPath.get("small.js").flags).not.toContain("sample-omitted");
  });

  test("still caches metadata when not one sample fits", () => {
    const input = payload([file("a.js", 5000), file("b.js", 5000)]);
    const { serialized, samplesOmitted } = serializeCompareCachePayload(
      input,
      sampleFloorBytes(input) + 10,
    );
    expect(samplesOmitted).toBe(true);
    const reduced = parse(serialized);
    expect(reduced.files.every((item) => !("textSample" in item))).toBe(true);
    expect(reduced.files.every((item) => item.flags.includes("sample-omitted"))).toBe(true);
    // File metadata is what the tree renders; a blanked payload still beats no
    // cache entry at all, which is a fresh tarball download per file view.
    expect(reduced.files.map((item) => item.path)).toEqual(["a.js", "b.js"]);
  });

  test("the reduced payload actually fits the budget", () => {
    const input = payload(
      Array.from({ length: 40 }, (_unused, index) => file(`src/file-${index}.js`, 500)),
    );
    const budget = sampleFloorBytes(input) + 3000;
    const { serialized } = serializeCompareCachePayload(input, budget);
    // Retention works from per-path cost arithmetic, not a trial serialization, so
    // the real bytes have to be confirmed against the budget.
    expect(bytes(serialized)).toBeLessThanOrEqual(budget);
    const reduced = parse(serialized);
    expect(reduced.files.some((item) => item.textSample)).toBe(true);
    expect(reduced.files.some((item) => !item.textSample)).toBe(true);
  });

  test("returns the over-budget floor when even metadata cannot fit", () => {
    // Nothing can be shed to make this fit; the caller is responsible for not
    // writing it (asserted in the writeCompareCache block below).
    const input = payload(
      Array.from({ length: 40 }, (_unused, index) => file(`src/file-${index}.js`, 500)),
    );
    const { serialized, samplesOmitted } = serializeCompareCachePayload(input, 100);
    expect(samplesOmitted).toBe(true);
    expect(bytes(serialized)).toBeGreaterThan(100);
    expect(parse(serialized).files.every((item) => !("textSample" in item))).toBe(true);
  });

  test("does not add the flag twice on a record that already carries it", () => {
    const input = payload([file("a.js", 5000, ["sample-omitted"])]);
    const { serialized } = serializeCompareCachePayload(input, 300);
    expect(parse(serialized).files[0].flags).toEqual(["sample-omitted"]);
  });
});

describe("writeCompareCache", () => {
  function stubEnv() {
    const puts = [];
    return {
      puts,
      env: {
        COMPARE_CACHE: {
          async put(key, value, options) {
            puts.push({ key, value, options });
          },
        },
      },
    };
  }

  function stubCtx() {
    const pending = [];
    return { pending, ctx: { waitUntil: (promise) => pending.push(promise) } };
  }

  test("writes the payload and keeps the TTL", async () => {
    const { env, puts } = stubEnv();
    const { ctx, pending } = stubCtx();
    await writeCompareCache(env, ctx, "compare:v3:key", payload([file("index.js", 10)]));
    await Promise.all(pending);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("compare:v3:key");
    expect(puts[0].options.expirationTtl).toBeGreaterThan(0);
    expect(JSON.parse(puts[0].value).files[0].textSample).toBe("x".repeat(10));
  });

  test("a KV write rejection stays fail-soft", async () => {
    const { ctx, pending } = stubCtx();
    const env = {
      COMPARE_CACHE: {
        async put() {
          throw new Error("KV PUT failed: 413 Value length limit exceeded");
        },
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeCompareCache(env, ctx, "compare:v3:key", payload([file("index.js", 10)]));
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  test("sheds samples so an oversized payload still lands in KV", async () => {
    const { env, puts } = stubEnv();
    const { ctx, pending } = stubCtx();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 24 MiB of samples across two files: over KV's value cap, so the old
    // unguarded put was rejected inside a swallowed catch and the entry silently
    // never existed — every /compare and /compare/file re-downloaded the tarball.
    const big = payload([file("a.js", 12 * 1024 * 1024), file("b.js", 12 * 1024 * 1024)]);
    const parseSpy = vi.spyOn(JSON, "parse");
    const returned = await writeCompareCache(env, ctx, "compare:v3:big", big);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    await Promise.all(pending);

    expect(puts).toHaveLength(1);
    expect(bytes(puts[0].value)).toBeLessThanOrEqual(20 * 1024 * 1024);
    const cached = JSON.parse(puts[0].value);
    expect(returned).toEqual(cached);
    expect(cached.textSamplesOmitted).toBe(true);
    expect(cached.files.map((item) => item.path)).toEqual(["a.js", "b.js"]);
  });

  test("skips the put when even the metadata floor is over the cap", async () => {
    const { env, puts } = stubEnv();
    const { ctx, pending } = stubCtx();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Enough per-record metadata to exceed the cap on its own, so there is
    // nothing left to shed and the write cannot land. Not reachable for a real
    // package (the archive parser caps files far below this) — the guard exists so
    // the branch cannot silently spend a request on a put KV will reject.
    const enormous = payload(
      Array.from({ length: 200_000 }, (_unused, index) => file(`src/file-${index}.js`, 8)),
    );
    await writeCompareCache(env, ctx, "compare:v3:enormous", enormous);
    await Promise.all(pending);
    expect(puts).toHaveLength(0);
  });

  test("no COMPARE_CACHE binding is a no-op", async () => {
    const { ctx, pending } = stubCtx();
    await writeCompareCache({}, ctx, "compare:v3:key", payload([file("index.js", 10)]));
    expect(pending).toHaveLength(0);
  });
});

describe("loadCompare", () => {
  test("bypasses a shed cache entry only when semantic comparison needs complete files", async () => {
    publishedTarballMock.downloadPublishedTarball.mockReset();
    const shed = {
      ...payload([file("index.js", 0, ["sample-omitted"])]),
      files: [
        {
          path: "index.js",
          size: 24,
          sha256: "a".repeat(64),
          flags: ["sample-omitted"],
        },
      ],
      textSamplesOmitted: true,
    };
    const complete = file("index.js", 24);
    publishedTarballMock.downloadPublishedTarball.mockResolvedValue({
      files: [complete],
      packageJson: { name: "pkg", version: "2.3.4" },
    });
    const puts = [];
    const env = {
      COMPARE_CACHE: {
        async get() {
          return shed;
        },
        async put(key, value, options) {
          puts.push({ key, value, options });
        },
      },
    };
    const { ctx, pending } = (() => {
      const pending = [];
      return { pending, ctx: { waitUntil: (promise) => pending.push(promise) } };
    })();
    const options = {
      tarballUrl: "https://registry.example/pkg/-/pkg-2.3.4.tgz",
      registryUrl: "https://registry.example",
      cacheScope: "org:test",
    };

    const fileView = await loadCompare(env, ctx, "2.3.4", options);
    expect(fileView.cached).toBe(shed);
    expect(publishedTarballMock.downloadPublishedTarball).not.toHaveBeenCalled();

    const semanticView = await loadCompare(env, ctx, "2.3.4", {
      ...options,
      requireCompleteFiles: true,
    });
    await Promise.all(pending);
    expect(publishedTarballMock.downloadPublishedTarball).toHaveBeenCalledTimes(1);
    expect(semanticView.comparisonFiles[0].textSample).toBe("x".repeat(24));
    expect(puts).toHaveLength(1);
  });
});
