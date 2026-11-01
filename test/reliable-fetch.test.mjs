import { afterEach, describe, expect, test, vi } from "vitest";
import { reliableFetch, reliableFetchBudgetMs } from "../server/lib/platform/reliable-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("reliableFetch", () => {
  test("retries transient GET responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    globalThis.fetch = fetchMock;

    const response = await reliableFetch("https://registry.npmjs.org/pkg", {
      baseDelayMs: 0,
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not retry POST unless explicitly opted in", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    globalThis.fetch = fetchMock;

    const response = await reliableFetch("https://api.github.com/callback", {
      method: "POST",
      baseDelayMs: 0,
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries opted-in POST responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;

    const response = await reliableFetch("https://api.github.com/callback", {
      method: "POST",
      retryMethods: ["POST"],
      baseDelayMs: 0,
    });

    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("reliableFetchBudgetMs", () => {
  test("covers every attempt timing out plus the capped delays between them", () => {
    expect(reliableFetchBudgetMs()).toBe(3 * 15_000 + 2 * 2_000);
    expect(reliableFetchBudgetMs({ timeoutMs: 5_000, attempts: 1 })).toBe(5_000);
    expect(reliableFetchBudgetMs({ timeoutMs: 60_000, maxDelayMs: 500 })).toBe(181_000);
    expect(reliableFetchBudgetMs({ timeoutMs: 0 })).toBe(Infinity);
  });
});
