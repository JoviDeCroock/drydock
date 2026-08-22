import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchPackageMetadata } from "../server/lib/ecosystems/npm/registry";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("npm packument body bounds", () => {
  test("a caller deadline cancels a body that stalls after headers", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const controller = new AbortController();
    const pending = fetchPackageMetadata({}, "package-name", { signal: controller.signal });
    controller.abort(new Error("dependency review deadline"));

    await expect(pending).rejects.toThrow("dependency review deadline");
    expect(cancelled).toBe(true);
  });

  test("rejects an oversized advertised packument before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    );

    await expect(fetchPackageMetadata({}, "package-name")).rejects.toThrow(
      "metadata body too large",
    );
    expect(cancelled).toBe(true);
  });
});
