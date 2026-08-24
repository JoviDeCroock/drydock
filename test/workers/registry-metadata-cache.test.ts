import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchPackageMetadataCached } from "../../server/lib/ecosystems/npm/registry-cache";
import { projectRegistryMetadata } from "../../server/lib/ecosystems/npm/registry";

// In-memory stand-in for the COMPARE_CACHE KV namespace (unbound in tests). The
// point of these tests is the cache *key*: a packument fetched with one
// organization's npm token must never satisfy another organization's read.
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      async get(key: string, options?: { type?: string }) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return options?.type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

const PRIVATE_PACKUMENT = {
  _id: "@acme/private",
  readme: "x".repeat(5_000),
  "dist-tags": { latest: "1.1.0" },
  time: { "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": "2026-02-01T00:00:00.000Z" },
  versions: {
    "1.0.0": {
      name: "@acme/private",
      readme: "x".repeat(5_000),
      dist: { tarball: "https://registry.npmjs.org/@acme/private/-/private-1.0.0.tgz" },
    },
    "1.1.0": {
      name: "@acme/private",
      dist: { tarball: "https://registry.npmjs.org/@acme/private/-/private-1.1.0.tgz" },
    },
  },
};

interface FetchCall {
  url: string;
  accept: string | null;
  authorization: string | null;
}

function stubRegistry(calls: FetchCall[], body: unknown = PRIVATE_PACKUMENT) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    calls.push({
      url: request.url,
      accept: request.headers.get("accept"),
      authorization: request.headers.get("authorization"),
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function cachedFetch(
  cache: KVNamespace,
  input: { cacheScope: string; npmToken?: string; abbreviated?: boolean },
) {
  const ctx = createExecutionContext();
  const result = await fetchPackageMetadataCached(
    { ...env, COMPARE_CACHE: cache } as Cloudflare.Env,
    ctx,
    {
      packageName: "@acme/private",
      registryUrl: "https://registry.npmjs.org",
      ...input,
    },
  );
  await waitOnExecutionContext(ctx);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cached npm packument reads", () => {
  test("serves a second read of the same package + organization from cache", async () => {
    const calls: FetchCall[] = [];
    stubRegistry(calls);
    const kv = fakeKv();

    const first = await cachedFetch(kv.binding, {
      cacheScope: "org:org-a",
      npmToken: "npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      abbreviated: true,
    });
    const second = await cachedFetch(kv.binding, {
      cacheScope: "org:org-a",
      npmToken: "npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      abbreviated: true,
    });

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.versions?.["1.1.0"]?.dist?.tarball).toContain("private-1.1.0.tgz");
  });

  test("never serves one organization's credentialed packument to another", async () => {
    const calls: FetchCall[] = [];
    stubRegistry(calls);
    const kv = fakeKv();

    await cachedFetch(kv.binding, {
      cacheScope: "org:org-a",
      npmToken: "npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      abbreviated: true,
    });
    await cachedFetch(kv.binding, {
      cacheScope: "org:org-b",
      npmToken: "npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      abbreviated: true,
    });

    // Second organization re-fetches with its own token instead of reading the
    // first organization's entry.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.authorization).toBe("Bearer npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(kv.store.size).toBe(2);
  });

  test("keys the abbreviated flavor separately so publish times are not lost", async () => {
    const calls: FetchCall[] = [];
    stubRegistry(calls);
    const kv = fakeKv();

    const abbreviated = await cachedFetch(kv.binding, {
      cacheScope: "org:org-a",
      abbreviated: true,
    });
    const full = await cachedFetch(kv.binding, { cacheScope: "org:org-a" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(calls[0]?.accept).toContain("application/json");
    expect(calls[1]?.accept).toBe("application/json");
    expect(abbreviated).toEqual(full);
    expect(kv.store.size).toBe(2);
  });

  test("caches only the projected document, not the whole packument", async () => {
    const calls: FetchCall[] = [];
    stubRegistry(calls);
    const kv = fakeKv();

    const metadata = await cachedFetch(kv.binding, { cacheScope: "org:org-a", abbreviated: true });

    const cachedRaw = [...kv.store.values()][0] ?? "";
    expect(cachedRaw).not.toContain("readme");
    expect(cachedRaw.length).toBeLessThan(JSON.stringify(PRIVATE_PACKUMENT).length / 4);
    // Every published version survives as a truthy entry: baseline selection
    // walks the key set.
    expect(Object.keys(metadata.versions ?? {})).toEqual(["1.0.0", "1.1.0"]);
    expect(metadata.time?.["1.1.0"]).toBe("2026-02-01T00:00:00.000Z");
    expect(metadata["dist-tags"]).toEqual({ latest: "1.1.0" });
  });

  test("falls back to the plain document when a registry rejects the vendor type", async () => {
    // A custom registry that answers 406 to `application/vnd.npm.install-v1+json`
    // must not cost the scan its baseline: the broker maps a metadata failure to
    // "no baseline", which silently reports every file as added.
    const calls: FetchCall[] = [];
    const kv = fakeKv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init as RequestInit);
      const accept = request.headers.get("accept");
      calls.push({ url: request.url, accept, authorization: null });
      if (accept?.includes("vnd.npm.install-v1+json")) {
        return new Response("Not Acceptable", { status: 406 });
      }
      return new Response(JSON.stringify(PRIVATE_PACKUMENT), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const metadata = await cachedFetch(kv.binding, {
      cacheScope: "org:org-a",
      abbreviated: true,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.accept).toBe("application/json");
    expect(metadata.versions?.["1.1.0"]?.dist?.tarball).toContain("private-1.1.0.tgz");
    // The recovered document is cached, so the retry is paid once per TTL.
    expect(kv.store.size).toBe(1);
  });

  test("does not retry a definitive 404", async () => {
    const calls: FetchCall[] = [];
    const kv = fakeKv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init as RequestInit);
      calls.push({ url: request.url, accept: request.headers.get("accept"), authorization: null });
      return new Response("not found", { status: 404 });
    });

    await expect(
      cachedFetch(kv.binding, { cacheScope: "org:org-a", abbreviated: true }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("a fetch failure is not cached", async () => {
    const kv = fakeKv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(cachedFetch(kv.binding, { cacheScope: "org:org-a" })).rejects.toThrow();
    expect(kv.store.size).toBe(0);
  });
});

describe("projectRegistryMetadata", () => {
  test("keeps versions without a tarball as present-but-empty entries", () => {
    const projected = projectRegistryMetadata({
      versions: {
        "1.0.0": { dist: {}, deprecated: "known-bad release" },
        "0.9.0": null,
        "0.8.0": { deprecated: "x".repeat(1_025) },
      },
      "dist-tags": { latest: "1.0.0", broken: 7 },
      time: { "1.0.0": "2026-01-01T00:00:00.000Z", modified: 5 },
      readme: "big",
    });

    expect(projected.versions).toEqual({
      "1.0.0": { deprecated: true },
      "0.9.0": {},
      "0.8.0": { deprecated: true },
    });
    expect(projected["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(projected.time).toEqual({ "1.0.0": "2026-01-01T00:00:00.000Z" });
    expect("readme" in projected).toBe(false);
  });

  test("tolerates a non-object document", () => {
    expect(projectRegistryMetadata(null)).toEqual({});
    expect(projectRegistryMetadata("nope")).toEqual({});
  });

  test("preserves oversized integrity presence so it cannot fall through to shasum", () => {
    const projected = projectRegistryMetadata({
      versions: {
        "1.0.0": {
          dist: {
            integrity: `sha512-${"A".repeat(600)}`,
            shasum: "ab".repeat(20),
          },
        },
      },
    });

    expect(projected.versions?.["1.0.0"]?.dist).toEqual({
      integrityPresent: true,
      shasum: "ab".repeat(20),
    });
  });
});
