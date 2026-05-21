import { afterEach, describe, expect, test, vi } from "vitest";
import { normalizeRegistryUrl, validateNpmCredential } from "../server/lib/npm-connection.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("npm connection validation", () => {
  test("normalizes registry urls to https origins without trailing slash noise", () => {
    expect(normalizeRegistryUrl("https://registry.npmjs.org///?ignored=1#hash")).toBe("https://registry.npmjs.org");
    expect(() => normalizeRegistryUrl("http://registry.npmjs.org")).toThrow("registry URL must use https");
  });

  test("checks registry auth and staged list capability without a stage id", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [], page: 0, perPage: 1, total: 0 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential("https://registry.npmjs.org", "npm_secret_token");

    expect(validation.ok).toBe(true);
    expect(validation.status).toBe("valid");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      whoami: "maintainer",
      registryUrl: "https://registry.npmjs.org",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("checks staged view and ranged tarball access when a stage id is supplied", async () => {
    const seen = [];
    const fetchMock = vi.fn(async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return Response.json({ items: [] });
      if (String(url).endsWith("/-/stage/stage-123/details")) return new Response("unexpected", { status: 500 });
      if (String(url).endsWith("/-/stage/stage-123")) return Response.json({ id: "stage-123" });
      if (String(url).endsWith("/-/stage/stage-123/tarball")) return new Response("x", { status: 206 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential("https://registry.npmjs.org", "npm_secret_token", { stageId: "stage-123" });

    expect(validation.ok).toBe(true);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewAccess: true,
      stagedTarballAccess: true,
      stageId: "stage-123",
      stagedTarballStatus: 206,
    });
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://registry.npmjs.org/-/whoami",
      "https://registry.npmjs.org/-/stage?perPage=1",
      "https://registry.npmjs.org/-/stage/stage-123",
      "https://registry.npmjs.org/-/stage/stage-123/tarball",
    ]);
    expect(seen.at(-1).headers.range).toBe("bytes=0-0");
  });

  test("marks validation invalid when staged list access is denied", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1")) return new Response("denied", { status: 403, statusText: "Forbidden" });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential("https://registry.npmjs.org", "npm_secret_token");

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("invalid");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: false,
      stagedListStatus: 403,
    });
  });
});
