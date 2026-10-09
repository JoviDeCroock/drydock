import { afterEach, describe, expect, test, vi } from "vitest";
import { newPasswordProblem, readResetToken } from "../src/models/password-reset";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The models are module singletons wired to `fetch`, so each case re-imports.
async function freshModel(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.resetModules();
  const fetchMock = vi.fn<typeof fetch>((input, init) => handler(String(input), init));
  globalThis.fetch = fetchMock;
  const { PasswordResetModel } = await import("../src/models/password-reset");
  const { sessionModel } = await import("../src/models/auth");
  return { model: new PasswordResetModel(), sessionModel, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readResetToken", () => {
  test("reads the token from the emailed link's fragment", () => {
    expect(readResetToken("#token=abc123")).toBe("abc123");
    expect(readResetToken("#token=a%2Bb")).toBe("a+b");
  });

  test("treats a missing or empty token as no link", () => {
    expect(readResetToken("")).toBeNull();
    expect(readResetToken("#")).toBeNull();
    expect(readResetToken("#token=")).toBeNull();
    expect(readResetToken("#other=1")).toBeNull();
  });
});

describe("newPasswordProblem", () => {
  test("mirrors the server's 12 to 256 character bounds", () => {
    expect(newPasswordProblem("a".repeat(11), "a".repeat(11))).toMatch(/at least 12/);
    expect(newPasswordProblem("a".repeat(12), "a".repeat(12))).toBeNull();
    expect(newPasswordProblem("a".repeat(256), "a".repeat(256))).toBeNull();
    expect(newPasswordProblem("a".repeat(257), "a".repeat(257))).toMatch(/at most 256/);
  });

  test("requires the confirmation to match", () => {
    expect(newPasswordProblem("a".repeat(12), "b".repeat(12))).toMatch(/don't match/);
  });
});

describe("PasswordResetModel", () => {
  test("requests a link for the address and records what was asked", async () => {
    const { model, fetchMock } = await freshModel(async () =>
      json({ status: true, message: "If this email exists in our system, check your email" }),
    );

    expect(await model.requestLink("someone@example.test")).toBe(true);

    expect(model.sentTo.value).toBe("someone@example.test");
    expect(model.error.value).toBeNull();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/request-password-reset");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "someone@example.test" });
  });

  test("asks for a link that returns to where the visitor was headed", async () => {
    const { model, fetchMock } = await freshModel(async () => json({ status: true }));
    vi.stubGlobal("window", { location: { origin: "https://drydock.example" } });

    await model.requestLink("someone@example.test", "/diff/react/19.0.0?path=src");
    await model.requestLink("someone@example.test", "https://drydock.example/dashboard/scans/s1");
    await model.requestLink("someone@example.test", "/dashboard/invite?token=invite-secret");
    await model.requestLink("someone@example.test", "https://evil.example/dashboard");

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        email: "someone@example.test",
        redirectTo: "/reset-password?returnTo=%2Fdiff%2Freact%2F19.0.0%3Fpath%3Dsrc",
      },
      {
        email: "someone@example.test",
        redirectTo: "/reset-password?returnTo=%2Fdashboard%2Fscans%2Fs1",
      },
      { email: "someone@example.test" },
      { email: "someone@example.test" },
    ]);
  });

  test("refuses a mismatched or short password without spending the link", async () => {
    const { model, fetchMock } = await freshModel(async () => json({ status: true }));

    expect(await model.complete("tok", "a".repeat(12), "b".repeat(12))).toBe(false);
    expect(await model.complete("tok", "short", "short")).toBe(false);

    expect(model.error.value).toMatch(/at least 12/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("redeems the link, then clears this browser's revoked session", async () => {
    const { model, sessionModel, fetchMock } = await freshModel(async () => json({ status: true }));
    sessionModel.session.value = { user: { id: "user_1" } };

    expect(await model.complete("tok", "a".repeat(12), "a".repeat(12))).toBe(true);

    expect(model.done.value).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/reset-password",
      "/api/auth/sign-out",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      token: "tok",
      newPassword: "a".repeat(12),
    });
    expect(sessionModel.session.value).toBeNull();
  });

  test("explains an expired or reused link", async () => {
    const { model } = await freshModel(async () =>
      json({ code: "INVALID_TOKEN", message: "Invalid token" }, 400),
    );

    expect(await model.complete("tok", "a".repeat(12), "a".repeat(12))).toBe(false);

    expect(model.done.value).toBe(false);
    expect(model.error.value).toMatch(/invalid, expired, or already used/);
  });
});

describe("authConfigModel password reset flag", () => {
  test("reports password reset only when the deployment says so", async () => {
    vi.resetModules();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      json({ githubSignIn: false, emailVerification: true, passwordReset: true }),
    );
    const { authConfigModel } = await import("../src/models/auth");

    expect(authConfigModel.passwordReset.value).toBe(false);
    await authConfigModel.load();
    expect(authConfigModel.passwordReset.value).toBe(true);
    expect(authConfigModel.settled.value).toBe(true);
  });

  test("settles without offering reset when the lookup fails, and shares one request", async () => {
    vi.resetModules();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    globalThis.fetch = fetchMock;
    const { authConfigModel } = await import("../src/models/auth");

    await Promise.all([authConfigModel.load(), authConfigModel.load()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authConfigModel.settled.value).toBe(true);
    expect(authConfigModel.loaded.value).toBe(false);
    expect(authConfigModel.passwordReset.value).toBe(false);
  });
});
