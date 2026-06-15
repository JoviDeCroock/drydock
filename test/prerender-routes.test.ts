import { describe, expect, it } from "vitest";
import { isGeneratedIndexRoute, isPrerenderedRoute, prerender } from "../src";
import { docsPageSeo, getPageSeoMetadata, homePageSeo } from "../src/lib/seo";

describe("isPrerenderedRoute", () => {
  it("matches generated public prerender pages with or without canonical trailing slashes", () => {
    expect(isPrerenderedRoute("/")).toBe(true);
    expect(isPrerenderedRoute("/login")).toBe(true);
    expect(isPrerenderedRoute("/login/")).toBe(true);
    expect(isPrerenderedRoute("/register")).toBe(true);
    expect(isPrerenderedRoute("/register/")).toBe(true);
    expect(isPrerenderedRoute("/docs")).toBe(true);
    expect(isPrerenderedRoute("/docs/")).toBe(true);
  });

  it("matches generated dashboard shell pages with or without canonical trailing slashes", () => {
    expect(isGeneratedIndexRoute("/dashboard")).toBe(true);
    expect(isGeneratedIndexRoute("/dashboard/")).toBe(true);
    expect(isGeneratedIndexRoute("/dashboard/account")).toBe(true);
    expect(isGeneratedIndexRoute("/dashboard/invite")).toBe(true);
    expect(isGeneratedIndexRoute("/dashboard/settings")).toBe(true);
    expect(isGeneratedIndexRoute("/dashboard/settings/github-app/callback")).toBe(true);
  });

  it("hydrates only pages with prerendered app markup", () => {
    expect(isPrerenderedRoute("/dashboard")).toBe(false);
    expect(isPrerenderedRoute("/dashboard/settings")).toBe(false);
    expect(isPrerenderedRoute("/docs/intro")).toBe(false);
  });

  it("emits an empty app shell for dashboard route indexes", async () => {
    const result = await prerender({ url: "/dashboard/settings" });

    expect(result).toEqual({ html: "", links: new Set() });
  });
});

describe("page SEO metadata", () => {
  it("is defined only for the public landing and docs pages", () => {
    expect(getPageSeoMetadata("/")).toBe(homePageSeo);
    expect(getPageSeoMetadata("/docs")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/docs/")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/login")).toBeUndefined();
    expect(getPageSeoMetadata("/register")).toBeUndefined();
  });
});
