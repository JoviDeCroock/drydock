import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiTokensModel, type PublicApiToken } from "../src/models/api-tokens";

function token(id: string, organizationId: string): PublicApiToken {
  return {
    id,
    organizationId,
    name: id,
    scopes: ["scans:read"],
    tokenLast4: id.slice(-4).padStart(4, "0"),
    createdByUserId: "user-1",
    lastUsedAt: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ApiTokensModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("clears org-scoped token state while loading another organization", async () => {
    const orgB = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/org-a/api-tokens")) {
        return Promise.resolve(jsonResponse({ tokens: [token("token-a", "org-a")] }));
      }
      if (url.includes("/org-b/api-tokens")) return orgB.promise;
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = new ApiTokensModel();
    await model.load("org-a", true);
    expect(model.tokens.value.map((item) => item.id)).toEqual(["token-a"]);
    expect(model.loaded.value).toBe(true);

    const loadOrgB = model.load("org-b", true);
    expect(model.tokens.value).toEqual([]);
    expect(model.loaded.value).toBe(false);

    orgB.resolve(jsonResponse({ error: "failed" }, 500));
    await loadOrgB;

    expect(model.tokens.value).toEqual([]);
    expect(model.loaded.value).toBe(true);
    expect(model.error.value).toBe("failed");
  });

  test("does not append a stale create result after switching organizations", async () => {
    const createOrgA = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/org-a/api-tokens") && init?.method === "POST") {
        return createOrgA.promise;
      }
      if (url.includes("/org-a/api-tokens")) {
        return Promise.resolve(jsonResponse({ tokens: [token("token-a", "org-a")] }));
      }
      if (url.includes("/org-b/api-tokens")) {
        return Promise.resolve(jsonResponse({ tokens: [token("token-b", "org-b")] }));
      }
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = new ApiTokensModel();
    await model.load("org-a", true);
    model.draftName.value = "new token";

    const create = model.create("org-a");
    await model.load("org-b", true);

    createOrgA.resolve(
      jsonResponse({ token: token("token-new-a", "org-a"), secret: "drydock_secret_a" }, 201),
    );
    await create;

    expect(model.tokens.value.map((item) => item.id)).toEqual(["token-b"]);
    expect(model.createdSecret.value).toBeNull();
  });

  test("does not remove later organization tokens when a stale revoke finishes", async () => {
    const revokeOrgA = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/org-a/api-tokens/token-a") && init?.method === "DELETE") {
        return revokeOrgA.promise;
      }
      if (url.includes("/org-a/api-tokens")) {
        return Promise.resolve(jsonResponse({ tokens: [token("token-a", "org-a")] }));
      }
      if (url.includes("/org-b/api-tokens")) {
        return Promise.resolve(jsonResponse({ tokens: [token("token-b", "org-b")] }));
      }
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = new ApiTokensModel();
    await model.load("org-a", true);

    const revoke = model.revoke("org-a", "token-a");
    await model.load("org-b", true);

    revokeOrgA.resolve(jsonResponse({ ok: true }));
    await revoke;

    expect(model.tokens.value.map((item) => item.id)).toEqual(["token-b"]);
    expect(model.error.value).toBeNull();
  });
});
