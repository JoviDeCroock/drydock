import { describe, expect, it } from "vitest";
import { isPrerenderedRoute } from "../src";
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

  it("does not hydrate pages that are not prerendered by the build", () => {
    expect(isPrerenderedRoute("/dashboard")).toBe(false);
    expect(isPrerenderedRoute("/docs/intro")).toBe(false);
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
