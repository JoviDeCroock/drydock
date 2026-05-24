import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchStagedPublishDetails,
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
});
