import { afterEach, describe, expect, test, vi } from "vitest";

async function freshModel(handler: () => Promise<Response>) {
  vi.resetModules();
  const fetchMock = vi.fn(handler);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { authConfigModel } = await import("../src/models/auth");
  return { authConfigModel, fetchMock };
}

function configResponse(githubSignIn: boolean): Response {
  return new Response(JSON.stringify({ githubSignIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authConfigModel", () => {
  test("caches a successful lookup", async () => {
    const { authConfigModel, fetchMock } = await freshModel(async () => configResponse(true));

    await authConfigModel.load();
    await authConfigModel.load();

    expect(authConfigModel.githubSignIn.value).toBe(true);
    expect(authConfigModel.loaded.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries after a network failure", async () => {
    const { authConfigModel, fetchMock } = await freshModel(
      vi
        .fn<() => Promise<Response>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(configResponse(true)),
    );

    await authConfigModel.load();
    expect(authConfigModel.loaded.value).toBe(false);

    await authConfigModel.load();
    expect(authConfigModel.githubSignIn.value).toBe(true);
    expect(authConfigModel.loaded.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries after a non-success response", async () => {
    const { authConfigModel, fetchMock } = await freshModel(
      vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(configResponse(true)),
    );

    await authConfigModel.load();
    await authConfigModel.load();

    expect(authConfigModel.githubSignIn.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
