import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { fetchPublishedTarballBytes, isPublishedTarballUrlAllowed } =
  await import("../server/lib/published-tarball.ts");

const REGISTRY = "https://registry.npmjs.org";
const ALLOWED_URL = "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz";

function stubFetch(responseFactory) {
  const captured = [];
  const fetchSpy = vi.fn(async (url, init) => {
    const headers = new Headers(init?.headers);
    captured.push({ url, authorization: headers.get("authorization") });
    return responseFactory();
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { captured, fetchSpy };
}

function streamResponse(bytes, { contentLength } = {}) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function rejectionDetail(promise) {
  try {
    await promise;
  } catch (err) {
    return JSON.parse(err.detail);
  }
  throw new Error("expected promise to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPublishedTarballUrlAllowed", () => {
  test("accepts same-origin published .tgz under /-/", () => {
    expect(isPublishedTarballUrlAllowed(ALLOWED_URL, REGISTRY, false)).toBe(true);
  });

  test("rejects foreign origins", () => {
    expect(
      isPublishedTarballUrlAllowed(
        "https://evil.example.com/@scope/pkg/-/pkg-1.0.0.tgz",
        REGISTRY,
        false,
      ),
    ).toBe(false);
  });

  test("rejects non-.tgz paths and paths without /-/", () => {
    expect(
      isPublishedTarballUrlAllowed(
        "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.zip",
        REGISTRY,
        false,
      ),
    ).toBe(false);
    expect(
      isPublishedTarballUrlAllowed(
        "https://registry.npmjs.org/@scope/pkg-1.0.0.tgz",
        REGISTRY,
        false,
      ),
    ).toBe(false);
  });

  test("rejects http registries unless insecure localhost is allowed", () => {
    const httpUrl = "http://localhost:4873/pkg/-/pkg-1.0.0.tgz";
    expect(isPublishedTarballUrlAllowed(httpUrl, "http://localhost:4873", false)).toBe(false);
    expect(isPublishedTarballUrlAllowed(httpUrl, "http://localhost:4873", true)).toBe(true);
  });
});

describe("fetchPublishedTarballBytes credential + origin guard", () => {
  test("attaches the npm token only for an allowed same-origin URL", async () => {
    const { captured } = stubFetch(() => streamResponse(new Uint8Array([1, 2, 3])));

    const bytes = await fetchPublishedTarballBytes(ALLOWED_URL, {
      registryUrl: REGISTRY,
      npmToken: "npm_secret_token",
    });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_token");
  });

  test("never fetches (or sends the token) for a foreign origin", async () => {
    const { fetchSpy } = stubFetch(() => streamResponse(new Uint8Array([1])));

    await expect(
      fetchPublishedTarballBytes("https://evil.example.com/pkg/-/pkg-1.0.0.tgz", {
        registryUrl: REGISTRY,
        npmToken: "npm_should_not_leak",
      }),
    ).rejects.toMatchObject({ name: "SandboxError" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("omits Authorization when no token is configured", async () => {
    const { captured } = stubFetch(() => streamResponse(new Uint8Array([9])));

    await fetchPublishedTarballBytes(ALLOWED_URL, { registryUrl: REGISTRY });

    expect(captured[0].authorization).toBeNull();
  });

  test("rejects when the advertised content-length exceeds the cap", async () => {
    stubFetch(() => streamResponse(new Uint8Array([1]), { contentLength: 26 * 1024 * 1024 }));

    const detail = await rejectionDetail(
      fetchPublishedTarballBytes(ALLOWED_URL, { registryUrl: REGISTRY }),
    );
    expect(detail.status).toBe(413);
  });

  test("enforces the byte cap while streaming when content-length is absent", async () => {
    stubFetch(() => streamResponse(new Uint8Array(64), { contentLength: undefined }));

    const detail = await rejectionDetail(
      fetchPublishedTarballBytes(ALLOWED_URL, { registryUrl: REGISTRY, maxBytes: 16 }),
    );
    expect(detail.status).toBe(413);
  });

  test("maps upstream non-OK responses to a download failure", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));

    const detail = await rejectionDetail(
      fetchPublishedTarballBytes(ALLOWED_URL, { registryUrl: REGISTRY }),
    );
    expect(detail.status).toBe(404);
  });
});
