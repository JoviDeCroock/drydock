import { describe, expect, it } from "vitest";
import {
  classifyTrafficSource,
  marketingSurfaceForPath,
  TRAFFIC_SOURCES,
} from "../server/lib/platform/traffic-source";

const SELF = "drydock.org";

describe("classifyTrafficSource", () => {
  it("maps the campaign channels we publish links on", () => {
    const cases: Array<[string, string]> = [
      ["https://bsky.app/profile/jovi.dev/post/abc", "bluesky"],
      ["https://x.com/i/web/status/123", "x"],
      ["https://t.co/abcdef", "x"],
      ["https://www.linkedin.com/feed/update/urn:li:activity:1", "linkedin"],
      ["https://lnkd.in/abc", "linkedin"],
      ["https://news.ycombinator.com/item?id=1", "hackernews"],
      ["https://old.reddit.com/r/node/comments/x", "reddit"],
      ["https://github.com/JoviDeCroock/drydock", "github"],
      ["https://www.npmjs.com/package/tape", "registry"],
    ];
    for (const [referer, expected] of cases) {
      expect(classifyTrafficSource({ referer, selfHostname: SELF })).toBe(expected);
    }
  });

  it("folds every google TLD into one search channel", () => {
    for (const host of ["google.com", "www.google.co.uk", "google.de"]) {
      expect(classifyTrafficSource({ referer: `https://${host}/`, selfHostname: SELF })).toBe(
        "search",
      );
    }
  });

  it("separates our own pages from external referrers", () => {
    expect(classifyTrafficSource({ referer: "https://drydock.org/docs", selfHostname: SELF })).toBe(
      "internal",
    );
    expect(classifyTrafficSource({ referer: "https://www.drydock.org/", selfHostname: SELF })).toBe(
      "internal",
    );
    expect(classifyTrafficSource({ referer: "https://example.com/", selfHostname: SELF })).toBe(
      "other",
    );
  });

  it("treats a missing referrer as direct and an unparseable one as other", () => {
    expect(classifyTrafficSource({ selfHostname: SELF })).toBe("direct");
    expect(classifyTrafficSource({ referer: "   ", selfHostname: SELF })).toBe("direct");
    expect(classifyTrafficSource({ referer: "not a url", selfHostname: SELF })).toBe("other");
  });

  it("prefers an explicit utm_source over the referrer", () => {
    expect(
      classifyTrafficSource({
        referer: "https://news.ycombinator.com/",
        campaignSource: "bluesky",
        selfHostname: SELF,
      }),
    ).toBe("bluesky");
  });

  it("collapses unknown utm_source values instead of creating new buckets", () => {
    // Otherwise a crafted ?utm_source= would create unbounded analytics
    // dimension cardinality.
    const source = classifyTrafficSource({
      campaignSource: "totally-made-up-channel",
      selfHostname: SELF,
    });
    expect(source).toBe("other");
    expect(TRAFFIC_SOURCES).toContain(source);
  });

  it("labels unfurl crawlers as bots regardless of referrer or campaign", () => {
    const crawlers = [
      "Twitterbot/1.0",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0)",
      "Mozilla/5.0 (compatible; Discordbot/2.0)",
      "facebookexternalhit/1.1",
      "curl/8.4.0",
    ];
    for (const userAgent of crawlers) {
      expect(
        classifyTrafficSource({
          userAgent,
          referer: "https://bsky.app/",
          campaignSource: "bluesky",
          selfHostname: SELF,
        }),
      ).toBe("bot");
    }
  });

  it("does not mistake an ordinary browser for a bot", () => {
    const userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    expect(classifyTrafficSource({ userAgent, referer: "https://bsky.app/" })).toBe("bluesky");
  });
});

describe("marketingSurfaceForPath", () => {
  it("attributes only the public marketing surfaces", () => {
    expect(marketingSurfaceForPath("/")).toBe("landing");
    expect(marketingSurfaceForPath("/docs")).toBe("docs");
    expect(marketingSurfaceForPath("/docs/")).toBe("docs");
    expect(marketingSurfaceForPath("/diff")).toBe("diff_index");
    expect(marketingSurfaceForPath("/diff/tape/5.7.0/5.7.1")).toBe("diff");
  });

  it("never attributes authenticated or auth-flow routes", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/scans/abc",
      "/dashboard/settings",
      "/login",
      "/register",
      "/verify-email",
      "/privacy",
    ]) {
      expect(marketingSurfaceForPath(path)).toBeNull();
    }
  });
});
