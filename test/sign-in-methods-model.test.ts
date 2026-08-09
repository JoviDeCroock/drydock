import { afterEach, describe, expect, test, vi } from "vitest";

// The model is a module singleton, so each case re-imports a fresh instance.
async function loadWith(handler: () => Promise<Response>, userId = "user_1") {
  vi.resetModules();
  const fetchMock = vi.fn(handler);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { signInMethodsModel } = await import("../src/models/auth");
  await signInMethodsModel.load(userId);
  return { signInMethodsModel, fetchMock };
}

function accountsResponse(providerIds: string[]): Response {
  return new Response(
    JSON.stringify(providerIds.map((providerId, i) => ({ id: `acc_${i}`, providerId }))),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signInMethodsModel", () => {
  test("reports a password when the user has a credential account", async () => {
    const { signInMethodsModel, fetchMock } = await loadWith(async () =>
      accountsResponse(["credential", "github"]),
    );

    expect(signInMethodsModel.hasPassword.value).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/list-accounts");
  });

  test("reports no password for a GitHub-only account", async () => {
    // The case that matters: every two-factor endpoint reauthenticates with a
    // password, so this account cannot enrol and the UI must say so instead of
    // offering a dialog that can only fail.
    const { signInMethodsModel } = await loadWith(async () => accountsResponse(["github"]));

    expect(signInMethodsModel.hasPassword.value).toBe(false);
  });

  test("keeps the password path when the lookup fails", async () => {
    const { signInMethodsModel } = await loadWith(async () => {
      throw new Error("offline");
    });

    expect(signInMethodsModel.hasPassword.value).toBe(true);
    expect(signInMethodsModel.loaded.value).toBe(true);
  });

  test("keeps the password path on an unauthenticated response", async () => {
    const { signInMethodsModel } = await loadWith(async () => new Response("", { status: 401 }));

    expect(signInMethodsModel.hasPassword.value).toBe(true);
  });

  test("load is a one-shot for the same user", async () => {
    const { signInMethodsModel, fetchMock } = await loadWith(async () =>
      accountsResponse(["github"]),
    );

    await signInMethodsModel.load("user_1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reloads when a different user signs in", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(accountsResponse(["github"]))
      .mockResolvedValueOnce(accountsResponse(["credential"]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { signInMethodsModel } = await import("../src/models/auth");

    await signInMethodsModel.load("github_user");
    expect(signInMethodsModel.hasPassword.value).toBe(false);

    await signInMethodsModel.load("password_user");
    expect(signInMethodsModel.hasPassword.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
