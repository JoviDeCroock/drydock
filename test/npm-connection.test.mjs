import { afterEach, describe, expect, test, vi } from "vitest";
import { normalizeRegistryUrl, validateNpmCredential } from "../server/lib/npm-connection.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("npm connection validation", () => {
  test("normalizes registry urls to https origins without trailing slash noise", () => {
    expect(normalizeRegistryUrl("https://registry.npmjs.org///?ignored=1#hash")).toBe(
      "https://registry.npmjs.org",
    );
    expect(() => normalizeRegistryUrl("http://registry.npmjs.org")).toThrow(
      "registry URL must use https",
    );
  });

  test("allows loopback http registries only when explicitly enabled", () => {
    expect(
      normalizeRegistryUrl("http://127.0.0.1:5184///?ignored=1#hash", {
        allowInsecureLocalhost: true,
      }),
    ).toBe("http://127.0.0.1:5184");
    expect(
      normalizeRegistryUrl("http://localhost:5184", {
        allowInsecureLocalhost: true,
      }),
    ).toBe("http://localhost:5184");
    expect(() =>
      normalizeRegistryUrl("http://registry.npmjs.org", { allowInsecureLocalhost: true }),
    ).toThrow("registry URL must use https");
  });

  test("checks registry auth and staged list capability without a stage id", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return Response.json({ items: [], page: 0, perPage: 1, total: 0 });
      if (String(url).includes("/-/npm/v1/tokens"))
        return Response.json({
          objects: [{ token: "npm_secr...oken", readonly: true }],
        });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(true);
    expect(validation.status).toBe("valid");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      readOnly: true,
      readOnlyMetadataAvailable: true,
      whoami: "maintainer",
      registryUrl: "https://registry.npmjs.org",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("checks staged view and ranged tarball access when a stage id is supplied", async () => {
    const seen = [];
    const fetchMock = vi.fn(async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      if (String(url).endsWith("/-/stage/stage-123/details"))
        return new Response("unexpected", { status: 500 });
      if (String(url).endsWith("/-/stage/stage-123")) return Response.json({ id: "stage-123" });
      if (String(url).endsWith("/-/stage/stage-123/tarball"))
        return new Response("x", { status: 206 });
      if (String(url).includes("/-/npm/v1/tokens"))
        return Response.json({
          objects: [{ token: "npm_secr...oken", readonly: true }],
        });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
      { stageId: "stage-123" },
    );

    expect(validation.ok).toBe(true);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewAccess: true,
      stagedTarballAccess: true,
      readOnly: true,
      readOnlyMetadataAvailable: true,
      stageId: "stage-123",
      stagedTarballStatus: 206,
    });
  });

  test("marks validation invalid when staged list access is denied", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      if (String(url).includes("/-/npm/v1/tokens"))
        return Response.json({
          objects: [{ token: "npm_secr...oken", readonly: true }],
        });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("invalid");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: false,
      stagedListStatus: 403,
    });
  });

  test("rejects write-capable npm token on npmjs.org", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      if (String(url).includes("/-/npm/v1/tokens"))
        return Response.json({
          objects: [
            { token: "npm_secr...oken", readonly: true, permissions: [{ action: "publish" }] },
          ],
        });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("invalid");
    expect(validation.capabilities.readOnly).toBe(false);
    expect(validation.capabilities.readOnlyMetadataAvailable).toBe(true);
    expect(validation.capabilities.readOnlyDetail).toMatch(/write permissions/);
  });

  test("keeps baseline validation when tokens endpoint is unavailable", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      if (String(url).includes("/-/npm/v1/tokens"))
        return new Response("Unauthorized", { status: 401 });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(true);
    expect(validation.capabilities.readOnly).toBeUndefined();
    expect(validation.capabilities.readOnlyMetadataAvailable).toBe(false);
    expect(validation.capabilities.readOnlyDetail).toMatch(/returned 401/);
  });

  test("keeps baseline validation when token cannot be matched in the listing", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      if (String(url).includes("/-/npm/v1/tokens"))
        return Response.json({
          objects: [{ token: "npm_othe...oken", readonly: true }],
        });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(true);
    expect(validation.capabilities.readOnly).toBeUndefined();
    expect(validation.capabilities.readOnlyMetadataAvailable).toBe(false);
    expect(validation.capabilities.readOnlyDetail).toMatch(/could not match token/);
  });

  test("skips read-only check for non-npmjs registries", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://custom-registry.example.com",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(true);
    expect(validation.capabilities.readOnly).toBe(true);
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/-/npm/v1/tokens"))).toBe(false);
  });
});
