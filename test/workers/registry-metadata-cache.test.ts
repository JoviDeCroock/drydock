import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchPackageMetadataCached } from "../../server/lib/ecosystems/npm/registry-cache";
import { fetchPublicPackageMetadata } from "../../server/lib/ecosystems/npm/public-metadata";
import { createPackumentExtractor } from "../../server/lib/ecosystems/npm/packument-stream";
import {
  projectPackumentExtract,
  projectRegistryMetadata,
} from "../../server/lib/ecosystems/npm/registry";
import { PublicDiffError } from "../../server/lib/public-diff/error";

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

const CEILING_BYTES = 128 * 1024 * 1024;
const CHUNK = new Uint8Array(1024 * 1024).fill(0x61);
const OPENING = new TextEncoder().encode('{"name":"big","readme":"');

/** A packument whose one string never ends, pulled lazily; `pulled` counts what was read. */
function endlessPackument(headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = state.pulled === 0 ? OPENING : CHUNK;
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { status: 200, headers }) };
}

describe("packument size ceiling", () => {
  test("refuses a declared length over the ceiling without reading the body", async () => {
    const { state, response } = endlessPackument({ "content-length": String(CEILING_BYTES + 1) });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const kv = fakeKv();

    await expect(cachedFetch(kv.binding, { cacheScope: "org:org-a" })).rejects.toThrow(
      "registry metadata too large",
    );
    expect(state.pulled).toBeLessThanOrEqual(OPENING.byteLength);
    expect(kv.store.size).toBe(0);
  });

  test(
    "stops streaming an undeclared body at the ceiling and cancels it",
    { timeout: 60_000 },
    async () => {
      const { state, response } = endlessPackument();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      await expect(cachedFetch(fakeKv().binding, { cacheScope: "org:org-a" })).rejects.toThrow(
        "registry metadata too large",
      );
      expect(state.pulled).toBeLessThanOrEqual(CEILING_BYTES + 2 * CHUNK.byteLength);
      expect(state.cancelled).toBe(true);
    },
  );

  test("refuses a packument whose retained fields exceed the budget, though small on the wire", async () => {
    // ~12 Mi characters of tarball URLs in a ~12 MB document: under the byte
    // ceiling, over what the extract may hold.
    const tarball = `https://registry.npmjs.org/big/-/${"a".repeat(3_900)}.tgz`;
    const versions = Object.fromEntries(
      Array.from({ length: 3_000 }, (_, i) => [`1.0.${i}`, { dist: { tarball } }]),
    );
    const body = JSON.stringify({ name: "big", versions });
    expect(body.length).toBeLessThan(CEILING_BYTES);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    await expect(cachedFetch(fakeKv().binding, { cacheScope: "org:org-a" })).rejects.toThrow(
      "registry metadata too large",
    );
  });

  test("charges escape-expanded bytes, so the cached JSON cannot outgrow the budget", async () => {
    // ~2.6 Mi decoded characters but ~14.6 MB once each control character is
    // written back as \u0001 (each tarball still fits one captured field):
    // past the budget, so refused rather than left to a KV put that would
    // fail on size.
    const tarball = `https://registry.npmjs.org/big/-/${"\u0001".repeat(600)}.tgz`;
    const versions = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, i) => [`1.0.${i}`, { dist: { tarball } }]),
    );
    const body = JSON.stringify({ name: "big", versions });
    expect(body.length).toBeGreaterThan(8 * 1024 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    await expect(cachedFetch(fakeKv().binding, { cacheScope: "org:org-a" })).rejects.toThrow(
      "registry metadata too large",
    );
  });

  test("the streamed projection equals the parsed-document projection", () => {
    const doc = {
      ...PRIVATE_PACKUMENT,
      versions: {
        ...PRIVATE_PACKUMENT.versions,
        "1.2.0": { dist: { tarball: "t", attestations: { provenance: { predicateType: "p" } } } },
        "1.3.0": { dist: { attestations: { provenance: "no" } } },
        "1.4.0": null,
      },
      "dist-tags": { latest: "1.1.0", broken: 7 },
    };
    const extractor = createPackumentExtractor();
    extractor.write(new TextEncoder().encode(JSON.stringify(doc)));
    expect(projectPackumentExtract(extractor.end())).toEqual(projectRegistryMetadata(doc));
  });
});

describe("public packument reads", () => {
  async function publicFetch(cache: KVNamespace) {
    const ctx = createExecutionContext();
    try {
      return await fetchPublicPackageMetadata(
        { ...env, COMPARE_CACHE: cache } as Cloudflare.Env,
        ctx,
        "big",
        "https://registry.npmjs.org",
      );
    } finally {
      await waitOnExecutionContext(ctx);
    }
  }

  async function rejection(promise: Promise<unknown>): Promise<PublicDiffError> {
    const err = await promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(PublicDiffError);
    return err as PublicDiffError;
  }

  test("answers an oversized packument with 413 and serves the repeat from cache", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => endlessPackument({ "content-length": String(CEILING_BYTES + 1) }).response,
      );
    const kv = fakeKv();

    expect((await rejection(publicFetch(kv.binding))).status).toBe(413);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await rejection(publicFetch(kv.binding))).status).toBe(413);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("caches an upstream failure briefly but not a missing package", async () => {
    const kv = fakeKv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("not found", { status: 404 }));
    expect((await rejection(publicFetch(kv.binding))).status).toBe(404);
    expect((await rejection(publicFetch(kv.binding))).status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(kv.store.size).toBe(0);

    fetchSpy.mockImplementation(async () => new Response("bad gateway", { status: 400 }));
    expect((await rejection(publicFetch(kv.binding))).status).toBe(502);
    expect((await rejection(publicFetch(kv.binding))).status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("projectRegistryMetadata", () => {
  test("keeps versions without a tarball as present-but-empty entries", () => {
    const projected = projectRegistryMetadata({
      versions: { "1.0.0": { dist: {} }, "0.9.0": null },
      "dist-tags": { latest: "1.0.0", broken: 7 },
      time: { "1.0.0": "2026-01-01T00:00:00.000Z", modified: 5 },
      readme: "big",
    });

    // A dist object without attestations is npm saying "no provenance"; an
    // entry with no dist object at all says nothing.
    expect(projected.versions).toEqual({ "1.0.0": { hasProvenance: false }, "0.9.0": {} });
    expect(projected["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(projected.time).toEqual({ "1.0.0": "2026-01-01T00:00:00.000Z" });
    expect("readme" in projected).toBe(false);
  });

  test("tolerates a non-object document", () => {
    expect(projectRegistryMetadata(null)).toEqual({});
    expect(projectRegistryMetadata("nope")).toEqual({});
  });
});
