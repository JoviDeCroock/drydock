import { afterEach, describe, expect, test, vi } from "vitest";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
  listStagedPublishes,
  parseStagedPublishDetails,
  parseStagedPublishesResponse,
} from "../server/lib/staged-publishes.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("staged publish metadata", () => {
  test("parses list items with tag and shasum metadata", () => {
    const parsed = parseStagedPublishesResponse({
      items: [
        {
          id: "stage-beta-123",
          packageName: "@npmcli/example-package",
          version: "2.0.0-beta.3",
          tag: "beta",
          createdAt: "2026-03-16T09:00:00.000Z",
          actor: "octocat",
          actorType: "user",
          access: "public",
          shasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
        },
      ],
      total: 1,
      perPage: 10,
      page: 0,
    });

    expect(parsed.items).toEqual([
      {
        id: "stage-beta-123",
        packageName: "@npmcli/example-package",
        version: "2.0.0-beta.3",
        tag: "beta",
        createdAt: "2026-03-16T09:00:00.000Z",
        actor: "octocat",
        actorType: "user",
        access: "public",
        shasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
      },
    ]);
  });

  test("deduces list item metadata and ignores malformed stage ids", () => {
    const page = parseStagedPublishesResponse({
      items: [
        { id: "stage-good-123", packageName: "pkg", version: "1.0.0" },
        { id: "../bad", packageName: "bad", version: "1.0.0" },
      ],
      total: 2,
      perPage: 50,
      page: 0,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ id: "stage-good-123", packageName: "pkg", version: "1.0.0" }),
    ]);
  });

  test("parses detail responses with a fallback id", () => {
    expect(
      parseStagedPublishDetails(
        {
          packageName: "example-lib",
          version: "0.4.0",
          tag: "next",
          actor_type: "trusted automation",
        },
        "stage-next-123",
      ),
    ).toMatchObject({
      id: "stage-next-123",
      packageName: "example-lib",
      version: "0.4.0",
      tag: "next",
      actorType: "trusted automation",
    });
  });

  test("does not treat metadata-only staged view responses as prepared manifests", () => {
    const detail = parseStagedPublishDetails({
      id: "stage-good-123",
      packageName: "pkg",
      version: "1.0.1",
      tag: "latest",
      createdAt: "2026-05-24T04:35:48.540Z",
      actor: "maintainer",
      actorType: "user",
      access: "public",
      shasum: "abc123",
    });

    expect(detail?.packageJson).toBeNull();
  });

  test("extracts prepared package manifests from staged view version metadata", () => {
    const detail = parseStagedPublishDetails({
      id: "stage-good-123",
      packageName: "pkg",
      version: "1.0.1",
      versions: {
        "1.0.1": {
          name: "pkg",
          version: "1.0.1",
          scripts: { install: "node-gyp rebuild" },
          gypfile: true,
          dependencies: { leftpad: "1.3.0" },
        },
      },
    });

    expect(detail?.packageJson).toMatchObject({
      name: "pkg",
      version: "1.0.1",
      scripts: { install: "node-gyp rebuild" },
      gypfile: true,
      dependencies: { leftpad: "1.3.0" },
    });
  });

  test("fetches staged details from the stage view endpoint", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://registry.npmjs.org/-/stage/stage-next-123");
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      expect(init.headers["user-agent"]).toBe("staged-publish-review/staged-view");
      return Response.json({
        id: "stage-next-123",
        packageName: "example-lib",
        version: "0.4.0",
        tag: "next",
      });
    });
    globalThis.fetch = fetchMock;

    await expect(
      fetchStagedPublishDetails("https://registry.npmjs.org", "npm_secret_token", "stage-next-123"),
    ).resolves.toMatchObject({
      id: "stage-next-123",
      packageName: "example-lib",
      version: "0.4.0",
      tag: "next",
    });
  });

  test("includes page when fetching a staged publish list page", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://registry.npmjs.org/-/stage?perPage=50&page=2");
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      expect(init.headers["user-agent"]).toBe("staged-publish-review/staged-list");
      return Response.json({ items: [], total: 0, perPage: 50, page: 2 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      listStagedPublishes("https://registry.npmjs.org", "npm_secret_token", {
        perPage: 50,
        page: 2,
      }),
    ).resolves.toMatchObject({ items: [], total: 0, perPage: 50, page: 2 });
  });

  test("probes staged tarball access with a ranged credentialed request", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://registry.npmjs.org/-/stage/stage-access-123/tarball");
      expect(init.headers.authorization).toBe("Bearer npm_secret_token");
      expect(init.headers.range).toBe("bytes=0-0");
      expect(init.headers["user-agent"]).toBe("staged-publish-review/staged-tarball-access");
      return new Response("", { status: 206 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      checkStagedPublishAccess(
        "https://registry.npmjs.org",
        "npm_secret_token",
        "stage-access-123",
      ),
    ).resolves.toEqual({ allowed: true, status: 206, detail: null });
  });

  test("treats per-stage auth failures as unauthorized candidates", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(
      checkStagedPublishAccess(
        "https://registry.npmjs.org",
        "npm_secret_token",
        "stage-denied-123",
      ),
    ).resolves.toEqual({ allowed: false, status: 403, detail: "Forbidden" });
  });

  test("allows non-auth tarball failures to be handled by scan execution", async () => {
    globalThis.fetch = vi.fn(async () => new Response("registry failure", { status: 503 }));

    await expect(
      checkStagedPublishAccess("https://registry.npmjs.org", "npm_secret_token", "stage-retry-123"),
    ).resolves.toEqual({ allowed: true, status: 503, detail: null });
  });
});
