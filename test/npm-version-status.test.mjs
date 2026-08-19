import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchNpmVersionStatus,
  isTerminalNpmVersionStatus,
} from "../server/lib/ecosystems/npm/version-status";
import { shouldRemindAboutForgottenApproval } from "../server/lib/ecosystems/npm/release-outcome";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function respond(status, body) {
  const fetchMock = vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe("npm version status lookup", () => {
  test("escapes the scope slash, which the packument route does not", async () => {
    const fetchMock = respond(200, {
      packageName: "@scope/pkg",
      version: "1.2.3",
      status: "published",
    });

    const result = await fetchNpmVersionStatus(
      "https://registry.npmjs.org",
      "npm_token",
      "@scope/pkg",
      "1.2.3",
    );

    expect(result).toEqual({ ok: true, status: "published" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/-/package/%40scope%2Fpkg/version/1.2.3/status",
    );
  });

  test("accepts npm-safe tildes in package names", async () => {
    const fetchMock = respond(200, {
      packageName: "pkg~canary",
      version: "1.2.3",
      status: "staged",
    });

    const result = await fetchNpmVersionStatus(
      "https://registry.npmjs.org",
      "npm_token",
      "pkg~canary",
      "1.2.3",
    );

    expect(result).toEqual({ ok: true, status: "staged" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/-/package/pkg~canary/version/1.2.3/status",
    );
  });

  test("carries the token in the Authorization header and nowhere else", async () => {
    const fetchMock = respond(200, {
      packageName: "pkg",
      version: "1.0.0",
      status: "validating",
    });

    await fetchNpmVersionStatus("https://registry.npmjs.org", "npm_secret", "pkg", "1.0.0");

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer npm_secret");
    // A token in the query string ends up in registry access logs.
    expect(url).not.toContain("npm_secret");
    expect(init.headers["user-agent"]).not.toContain("npm_secret");
  });

  test.each([
    [404, "not_found"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [400, "rejected"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("http %i never produces a status", async (httpStatus, reason) => {
    respond(httpStatus, { error: "nope" });

    const result = await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", "1.0.0");

    expect(result).toEqual({ ok: false, reason, httpStatus });
  });

  test("a status npm has not documented is unknown, not passed through", async () => {
    respond(200, { packageName: "pkg", version: "1.0.0", status: "quarantined" });

    const result = await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", "1.0.0");

    expect(result).toEqual({ ok: false, reason: "unavailable", httpStatus: 200 });
  });

  test.each([
    ["package name", { packageName: "other", version: "1.0.0", status: "published" }],
    ["version", { packageName: "pkg", version: "2.0.0", status: "published" }],
  ])("a response for a different %s is unknown", async (_field, body) => {
    respond(200, body);

    const result = await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", "1.0.0");

    expect(result).toEqual({ ok: false, reason: "unavailable", httpStatus: 200 });
  });

  test("a transport failure is unknown rather than a throw", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection reset");
    });

    const result = await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", "1.0.0");

    expect(result).toEqual({ ok: false, reason: "unavailable", httpStatus: null });
  });

  test("does not retry, so one throttled lookup is not three", async () => {
    const fetchMock = respond(429, { error: "slow down" });

    await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", "1.0.0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["../../etc/passwd", "1.0.0"],
    ["pkg", "1.0.0/../../other"],
    ["pkg", "1.0.0?x=1"],
    ["@scope/../pkg", "1.0.0"],
  ])("refuses to build a request from %s@%s", async (packageName, version) => {
    const fetchMock = respond(200, { status: "published" });

    const result = await fetchNpmVersionStatus(
      "https://registry.npmjs.org",
      "t",
      packageName,
      version,
    );

    expect(result).toEqual({ ok: false, reason: "rejected", httpStatus: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not call out when there is nothing to ask about", async () => {
    const fetchMock = respond(200, { status: "published" });

    expect(await fetchNpmVersionStatus("https://registry.npmjs.org", "t", null, "1.0.0")).toEqual({
      ok: false,
      reason: "incomplete_input",
      httpStatus: null,
    });
    expect(await fetchNpmVersionStatus("https://registry.npmjs.org", "t", "pkg", null)).toEqual({
      ok: false,
      reason: "incomplete_input",
      httpStatus: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("published remains open because npm can later report it deleted", () => {
    expect(isTerminalNpmVersionStatus("published")).toBe(false);
    expect(isTerminalNpmVersionStatus("blocked")).toBe(true);
    expect(isTerminalNpmVersionStatus("deleted")).toBe(true);
    expect(isTerminalNpmVersionStatus("staged")).toBe(false);
    expect(isTerminalNpmVersionStatus("validating")).toBe(false);
    expect(isTerminalNpmVersionStatus(null)).toBe(false);
  });
});

describe("forgotten-approval reminder", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const longAgo = new Date("2026-08-18T00:00:00.000Z");
  const approved = {
    decision: "publish",
    decidedAt: longAgo,
    registryPublishReminderAt: null,
  };

  test("fires when we approved and npm is still holding it", () => {
    expect(shouldRemindAboutForgottenApproval(approved, "staged", now)).toBe(true);
  });

  test("does not fire while npm is the one still working", () => {
    expect(shouldRemindAboutForgottenApproval(approved, "validating", now)).toBe(false);
  });

  test.each(["published", "blocked", "deleted"])(
    "does not fire once npm is done (%s)",
    (status) => {
      expect(shouldRemindAboutForgottenApproval(approved, status, now)).toBe(false);
    },
  );

  test("does not fire on a release nobody approved here", () => {
    expect(shouldRemindAboutForgottenApproval({ ...approved, decision: null }, "staged", now)).toBe(
      false,
    );
    expect(
      shouldRemindAboutForgottenApproval({ ...approved, decision: "no_publish" }, "staged", now),
    ).toBe(false);
  });

  test("does not fire on a publish still in progress", () => {
    const justDecided = { ...approved, decidedAt: new Date(now.getTime() - 60_000) };
    expect(shouldRemindAboutForgottenApproval(justDecided, "staged", now)).toBe(false);
  });

  test("sends once, not once per sweep", () => {
    const alreadySent = { ...approved, registryPublishReminderAt: new Date(longAgo) };
    expect(shouldRemindAboutForgottenApproval(alreadySent, "staged", now)).toBe(false);
  });

  test("does not fire without a decision timestamp to measure from", () => {
    expect(
      shouldRemindAboutForgottenApproval({ ...approved, decidedAt: null }, "staged", now),
    ).toBe(false);
  });
});
