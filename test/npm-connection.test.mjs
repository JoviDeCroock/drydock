import { afterEach, describe, expect, test, vi } from "vitest";
import {
  normalizeRegistryUrl,
  publicNpmConnection,
  validateNpmCredential,
} from "../server/lib/npm-connection.ts";

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

  test("auto-probes a representative stage from the list response when no stageId is supplied", async () => {
    const seen = [];
    const fetchMock = vi.fn(async (url, init) => {
      seen.push(String(url));
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return Response.json({ items: [{ id: "stage-from-list" }], page: 0, perPage: 1, total: 1 });
      if (String(url).endsWith("/-/stage/stage-from-list"))
        return Response.json({ id: "stage-from-list" });
      if (String(url).endsWith("/-/stage/stage-from-list/tarball"))
        return new Response("x", { status: 206 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(true);
    expect(validation.status).toBe("valid");
    expect(validation.reasons).toEqual([]);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewAccess: true,
      stagedTarballAccess: true,
      probedStageSource: "list",
      stageId: "stage-from-list",
      whoami: "maintainer",
    });
    expect(seen).toContain("https://registry.npmjs.org/-/stage/stage-from-list/tarball");
  });

  test("marks validation capability_limited when the staged list is empty", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return Response.json({ items: [], page: 0, perPage: 1, total: 0 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("capability_limited");
    expect(validation.reasons).toEqual(["no_stages_to_probe"]);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("checks staged view and ranged tarball access when a stage id is supplied", async () => {
    const seen = [];
    const fetchMock = vi.fn(async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return Response.json({ items: [{ id: "list-stage" }] });
      if (String(url).endsWith("/-/stage/stage-123")) return Response.json({ id: "stage-123" });
      if (String(url).endsWith("/-/stage/stage-123/tarball"))
        return new Response("x", { status: 206 });
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
      { stageId: "stage-123" },
    );

    expect(validation.ok).toBe(true);
    expect(validation.status).toBe("valid");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewAccess: true,
      stagedTarballAccess: true,
      probedStageSource: "caller",
      stageId: "stage-123",
      stagedTarballStatus: 206,
    });
    const probedTarball = seen.find((entry) => entry.url.endsWith("/-/stage/stage-123/tarball"));
    expect(probedTarball?.headers.range).toBe("bytes=0-0");
    expect(seen.find((entry) => entry.url.endsWith("/-/stage/list-stage"))).toBeUndefined();
  });

  test("marks validation invalid when staged list access is denied", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("invalid");
    expect(validation.reasons).toContain("staged_list_denied");
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: false,
      stagedListStatus: 403,
    });
  });

  test("publicNpmConnection never returns token ciphertext or nonce material", () => {
    const sensitive = {
      id: "conn_1",
      organizationId: "org_a",
      registryUrl: "https://registry.npmjs.org",
      label: "npm registry",
      tokenCiphertext: "v1:secret_ciphertext_blob",
      tokenNonce: "secret_nonce_blob",
      tokenFingerprint: "fp_abc",
      tokenLast4: "1234",
      validationStatus: "valid",
      capabilitiesJson: { registryAuth: true },
      validatedAt: new Date(0),
      lastUsedAt: null,
      createdByUserId: "user_a",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const safe = publicNpmConnection(sensitive);
    expect(safe).not.toBeNull();
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("secret_ciphertext_blob");
    expect(serialized).not.toContain("secret_nonce_blob");
    expect(safe).not.toHaveProperty("tokenCiphertext");
    expect(safe).not.toHaveProperty("tokenNonce");
  });

  test("marks validation capability_limited when the auto-probed tarball is denied", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/-/whoami")) return Response.json({ username: "maintainer" });
      if (String(url).endsWith("/-/stage?perPage=1"))
        return Response.json({ items: [{ id: "probe-stage" }] });
      if (String(url).endsWith("/-/stage/probe-stage")) return Response.json({ id: "probe-stage" });
      if (String(url).endsWith("/-/stage/probe-stage/tarball"))
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      return new Response("unexpected", { status: 500 });
    });

    const validation = await validateNpmCredential(
      "https://registry.npmjs.org",
      "npm_secret_token",
    );

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("capability_limited");
    expect(validation.reasons).toEqual(["staged_tarball_denied"]);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewAccess: true,
      stagedTarballAccess: false,
      probedStageSource: "list",
      stageId: "probe-stage",
    });
  });
});
