import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { fetchPkgPrNewTarballStream, fetchPublishedTarballStream, isPublishedTarballUrlAllowed } =
  await import("../server/lib/published-tarball");

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

describe("fetchPublishedTarballStream credential + origin guard", () => {
  test("attaches the npm token only for an allowed same-origin URL", async () => {
    const { captured } = stubFetch(() => streamResponse(new Uint8Array([1, 2, 3])));

    const stream = await fetchPublishedTarballStream(ALLOWED_URL, {
      registryUrl: REGISTRY,
      npmToken: "npm_secret_token",
    });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_token");
  });

  test("never fetches (or sends the token) for a foreign origin", async () => {
    const { fetchSpy } = stubFetch(() => streamResponse(new Uint8Array([1])));

    await expect(
      fetchPublishedTarballStream("https://evil.example.com/pkg/-/pkg-1.0.0.tgz", {
        registryUrl: REGISTRY,
        npmToken: "npm_should_not_leak",
      }),
    ).rejects.toMatchObject({ name: "SandboxError" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("omits Authorization when no token is configured", async () => {
    const { captured } = stubFetch(() => streamResponse(new Uint8Array([9])));

    const stream = await fetchPublishedTarballStream(ALLOWED_URL, { registryUrl: REGISTRY });
    await new Response(stream).arrayBuffer();

    expect(captured[0].authorization).toBeNull();
  });

  test("streams tarballs larger than the old 25 MB buffer cap", async () => {
    // The parent no longer buffers the baseline, so a big-binary previous
    // version streams through instead of degrading the scan to no-baseline.
    stubFetch(() => streamResponse(new Uint8Array([1]), { contentLength: 26 * 1024 * 1024 }));

    const stream = await fetchPublishedTarballStream(ALLOWED_URL, { registryUrl: REGISTRY });
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  test("rejects when the advertised content-length exceeds the stream cap", async () => {
    stubFetch(() => streamResponse(new Uint8Array([1]), { contentLength: 64 }));

    const detail = await rejectionDetail(
      fetchPublishedTarballStream(ALLOWED_URL, { registryUrl: REGISTRY, maxBytes: 16 }),
    );
    expect(detail.status).toBe(413);
  });

  test("passes bytes between the sandbox cap and the 2x backstop through untouched", async () => {
    // The sandbox enforces the real compressed cap (with a degradable 413);
    // a parent-side error at the same threshold would reach the parser as an
    // anonymous stream failure and fail the whole scan instead of degrading.
    // The parent must therefore never win that race: bytes past `maxBytes`
    // but under 2x flow through untouched.
    stubFetch(() => streamResponse(new Uint8Array(24).fill(3), { contentLength: undefined }));

    const stream = await fetchPublishedTarballStream(ALLOWED_URL, {
      registryUrl: REGISTRY,
      maxBytes: 16,
    });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(24).fill(3));
  });

  test("errors the stream at the 2x backstop when content-length is absent", async () => {
    stubFetch(() => streamResponse(new Uint8Array(64), { contentLength: undefined }));

    const stream = await fetchPublishedTarballStream(ALLOWED_URL, {
      registryUrl: REGISTRY,
      maxBytes: 16,
    });
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow(/tarball too large/);
  });

  test("maps upstream non-OK responses to a download failure", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));

    const detail = await rejectionDetail(
      fetchPublishedTarballStream(ALLOWED_URL, { registryUrl: REGISTRY }),
    );
    expect(detail.status).toBe(404);
  });
});

// pkg.pr.new preview fetches are structurally anonymous: the function takes no
// token option, so the only things to verify are the URL gate and that no
// Authorization header is ever attached.
describe("fetchPkgPrNewTarballStream", () => {
  const PREVIEW_URL = "https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55";

  test("streams an allowed preview URL without credentials", async () => {
    const { captured } = stubFetch(() => streamResponse(new Uint8Array([7, 8, 9])));

    const stream = await fetchPkgPrNewTarballStream(PREVIEW_URL);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    expect(Array.from(bytes)).toEqual([7, 8, 9]);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(PREVIEW_URL);
    expect(captured[0].authorization).toBeNull();
  });

  test("never fetches a non-pkg.pr.new or non-canonical URL", async () => {
    const { fetchSpy } = stubFetch(() => streamResponse(new Uint8Array([1])));

    for (const url of [
      "https://evil.example.com/tinybench@a832a55",
      "https://pkg.pr.new.evil.example.com/tinybench@a832a55",
      "http://pkg.pr.new/tinybench@a832a55",
      "https://pkg.pr.new/tinybench@a832a55?x=1",
      "https://pkg.pr.new/tinybench@a832a55/", // trailing slash: not canonical
      "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
    ]) {
      const detail = await rejectionDetail(fetchPkgPrNewTarballStream(url));
      expect(detail.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("propagates upstream status for a missing preview", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));

    const detail = await rejectionDetail(fetchPkgPrNewTarballStream(PREVIEW_URL));
    expect(detail.status).toBe(404);
  });

  test("rejects an oversized advertised content-length", async () => {
    stubFetch(() => streamResponse(new Uint8Array([1]), { contentLength: 64 }));

    const detail = await rejectionDetail(fetchPkgPrNewTarballStream(PREVIEW_URL, { maxBytes: 16 }));
    expect(detail.status).toBe(413);
  });
});
