import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchPublishedTarballStream } from "../../server/lib/ecosystems/npm/published-tarball";

const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const CUSTOM_REGISTRY = "https://npm.internal.example.com";

function tarballResponse(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
    },
  });
}

function stubFetch(body: string) {
  const authHeaders: Array<string | null> = [];
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    authHeaders.push(new Headers(init?.headers).get("authorization"));
    return tarballResponse(body);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, authHeaders };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("published tarball colo cache", () => {
  test("anonymous warm fetch populates the cache and repeat fetches skip the registry", async () => {
    const url = `${PUBLIC_REGISTRY}/pkg-a/-/pkg-a-1.0.0.tgz`;
    const { fetchSpy } = stubFetch("tarball-bytes-a");
    const pending: Promise<unknown>[] = [];

    const first = await fetchPublishedTarballStream(url, {
      registryUrl: PUBLIC_REGISTRY,
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(first)).toBe("tarball-bytes-a");

    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const second = await fetchPublishedTarballStream(url, {
      registryUrl: PUBLIC_REGISTRY,
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(second)).toBe("tarball-bytes-a");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
  });

  test("token requests on the public registry read the cache but warm it anonymously", async () => {
    const url = `${PUBLIC_REGISTRY}/pkg-b/-/pkg-b-1.0.0.tgz`;
    const { fetchSpy, authHeaders } = stubFetch("tarball-bytes-b");
    const pending: Promise<unknown>[] = [];

    const first = await fetchPublishedTarballStream(url, {
      registryUrl: PUBLIC_REGISTRY,
      npmToken: "npm_secret",
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(first)).toBe("tarball-bytes-b");
    await Promise.all(pending);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(authHeaders[0]).toBe("Bearer npm_secret");
    expect(authHeaders[1]).toBeNull();

    const second = await fetchPublishedTarballStream(url, {
      registryUrl: PUBLIC_REGISTRY,
      npmToken: "npm_secret",
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(second)).toBe("tarball-bytes-b");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("token requests on custom registries never read or write the cache", async () => {
    const url = `${CUSTOM_REGISTRY}/pkg-c/-/pkg-c-1.0.0.tgz`;
    await caches.default.put(
      url,
      new Response("poisoned-bytes", {
        status: 200,
        headers: {
          "cache-control": "public, max-age=600",
          "content-length": String("poisoned-bytes".length),
        },
      }),
    );
    const { fetchSpy } = stubFetch("live-bytes-c");
    const pending: Promise<unknown>[] = [];

    const stream = await fetchPublishedTarballStream(url, {
      registryUrl: CUSTOM_REGISTRY,
      npmToken: "npm_secret",
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(stream)).toBe("live-bytes-c");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
  });

  test("unauthenticated custom https registries are cacheable", async () => {
    const url = `${CUSTOM_REGISTRY}/pkg-d/-/pkg-d-1.0.0.tgz`;
    const { fetchSpy } = stubFetch("tarball-bytes-d");
    const pending: Promise<unknown>[] = [];

    await readAll(
      await fetchPublishedTarballStream(url, {
        registryUrl: CUSTOM_REGISTRY,
        waitUntil: (promise) => pending.push(promise),
      }),
    );
    await Promise.all(pending);

    const second = await fetchPublishedTarballStream(url, {
      registryUrl: CUSTOM_REGISTRY,
      waitUntil: (promise) => pending.push(promise),
    });
    expect(await readAll(second)).toBe("tarball-bytes-d");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("an anonymous evidence fetch can bypass both cache reads and warming", async () => {
    const url = `${PUBLIC_REGISTRY}/pkg-f/-/pkg-f-1.0.0.tgz`;
    await caches.default.put(
      url,
      new Response("stale-bytes-f", {
        status: 200,
        headers: { "content-length": String("stale-bytes-f".length) },
      }),
    );
    const { fetchSpy } = stubFetch("live-bytes-f");
    const pending: Promise<unknown>[] = [];

    const stream = await fetchPublishedTarballStream(url, {
      registryUrl: PUBLIC_REGISTRY,
      cacheMode: "bypass",
      waitUntil: (promise) => pending.push(promise),
    });

    expect(await readAll(stream)).toBe("live-bytes-f");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
  });

  test("insecure localhost registries (fake-registry e2e) bypass the cache", async () => {
    const registry = "http://localhost:4873";
    const url = `${registry}/pkg-e/-/pkg-e-1.0.0.tgz`;
    const { fetchSpy } = stubFetch("tarball-bytes-e");
    const pending: Promise<unknown>[] = [];

    for (let i = 0; i < 2; i += 1) {
      const stream = await fetchPublishedTarballStream(url, {
        registryUrl: registry,
        allowInsecureLocalhost: true,
        waitUntil: (promise) => pending.push(promise),
      });
      expect(await readAll(stream)).toBe("tarball-bytes-e");
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);
    expect(await caches.default.match(url)).toBeUndefined();
  });
});
