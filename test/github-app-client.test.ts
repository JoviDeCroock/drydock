import { afterEach, describe, expect, test, vi } from "vitest";
import { githubHeaders, nextLink, paginate } from "../server/lib/github-app/client";

afterEach(() => vi.unstubAllGlobals());

function page(body: unknown, next?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (next) headers.link = `<${next}>; rel="next"`;
  return new Response(JSON.stringify(body), { headers });
}

describe("githubHeaders", () => {
  test("carries the bearer, API version, and user agent", () => {
    expect(githubHeaders("tok")).toEqual({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
      "User-Agent": "drydock-app",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  test("extra headers extend the set for request bodies", () => {
    expect(githubHeaders("tok", { "Content-Type": "application/json" })).toMatchObject({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
  });
});

describe("nextLink", () => {
  test("reads rel=next among other relations", () => {
    expect(nextLink('<https://x/a?page=3>; rel="next", <https://x/a?page=9>; rel="last"')).toBe(
      "https://x/a?page=3",
    );
    expect(nextLink('<https://x/a?page=9>; rel="last"')).toBe("");
    expect(nextLink(null)).toBe("");
  });
});

describe("paginate", () => {
  test("follows the Link chain to its end and hands every page to the reader", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api/p1") return page([1], "https://api/p2");
      if (url === "https://api/p2") return page([2]);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const seen: number[] = [];
    await paginate(
      "https://api/p1",
      { headers: githubHeaders("tok"), maxPages: 10 },
      async (response) => {
        seen.push(...((await response.json()) as number[]));
      },
    );
    expect(seen).toEqual([1, 2]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api/p1", "https://api/p2"]);
  });

  test("stops at maxPages even when the chain continues", async () => {
    const fetchMock = vi.fn(async (url: string) => page([url], `${url}x`));
    vi.stubGlobal("fetch", fetchMock);
    let pages = 0;
    await paginate("https://api/p", { headers: {}, maxPages: 3 }, async () => {
      pages += 1;
    });
    expect(pages).toBe(3);
  });

  test("stops on a link it has already fetched instead of looping", async () => {
    const fetchMock = vi.fn(async () => page([], "https://api/p"));
    vi.stubGlobal("fetch", fetchMock);
    let pages = 0;
    await paginate("https://api/p", { headers: {}, maxPages: 50 }, async () => {
      pages += 1;
    });
    expect(pages).toBe(1);
  });

  test("a vetoed next link ends the walk without fetching it", async () => {
    const fetchMock = vi.fn(async () => page([], "https://evil.example/p2"));
    vi.stubGlobal("fetch", fetchMock);
    await paginate(
      "https://api/p1",
      {
        headers: {},
        maxPages: 5,
        followNext: (next) => new URL(next).hostname === "api",
      },
      async () => undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a reader error propagates and ends the walk", async () => {
    const fetchMock = vi.fn(async () => page([], "https://api/p2"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      paginate("https://api/p1", { headers: {}, maxPages: 5 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
