import { afterEach, describe, expect, test, vi } from "vitest";

async function deleteWith(password?: string) {
  vi.resetModules();
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { sessionModel } = await import("../src/models/auth");

  await sessionModel.deleteAccount(password);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account deletion model", () => {
  test("sends the credential for a password account", async () => {
    const fetchMock = await deleteWith("correct horse battery staple");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/delete-user");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      password: "correct horse battery staple",
    });
  });

  test("uses fresh-session reauthentication for a social-only account", async () => {
    const fetchMock = await deleteWith();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/delete-user");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
  });
});
