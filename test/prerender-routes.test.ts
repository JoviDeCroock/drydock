import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isGeneratedIndexRoute, isPrerenderedRoute, prerender } from "../src";
import {
  DISCOVERY_GUIDE_PATHS,
  discoveryGuideSeoByPath,
  docsPageSeo,
  getPageSeoMetadata,
  homePageSeo,
  INCIDENT_CASE_PATHS,
  incidentCaseSeoByPath,
  packageDiffSeo,
  privacyPageSeo,
} from "../src/lib/seo";

describe("isPrerenderedRoute", () => {
  it("matches generated public prerender pages with or without canonical trailing slashes", () => {
    expect(isPrerenderedRoute("/")).toBe(true);
    expect(isPrerenderedRoute("/login")).toBe(true);
    expect(isPrerenderedRoute("/login/")).toBe(true);
    expect(isPrerenderedRoute("/register")).toBe(true);
    expect(isPrerenderedRoute("/register/")).toBe(true);
    expect(isPrerenderedRoute("/docs")).toBe(true);
    expect(isPrerenderedRoute("/docs/")).toBe(true);
    expect(isPrerenderedRoute("/privacy")).toBe(true);
    expect(isPrerenderedRoute("/privacy/")).toBe(true);
    for (const path of [...DISCOVERY_GUIDE_PATHS, ...INCIDENT_CASE_PATHS]) {
      expect(isPrerenderedRoute(path)).toBe(true);
      expect(isPrerenderedRoute(`${path}/`)).toBe(true);
    }
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
  it("names the package-security category in the home result", () => {
    expect(homePageSeo).toMatchObject({
      title: "Drydock Package Review: pre-publish package security",
    });
    expect(homePageSeo.description).toContain("exact npm, PyPI, or VS Code artifact");
  });

  it("gives each incident analysis distinct canonical metadata", () => {
    expect(Object.keys(incidentCaseSeoByPath)).toEqual(INCIDENT_CASE_PATHS);
    const titles = new Set<string>();
    for (const path of INCIDENT_CASE_PATHS) {
      const metadata = incidentCaseSeoByPath[path];
      expect(getPageSeoMetadata(path)).toBe(metadata);
      expect(getPageSeoMetadata(`${path}/`)).toBe(metadata);
      titles.add(metadata.title);
    }
    expect(titles.size).toBe(INCIDENT_CASE_PATHS.length);
  });

  it("is defined only for the public landing, docs, and privacy pages", () => {
    expect(getPageSeoMetadata("/")).toBe(homePageSeo);
    expect(getPageSeoMetadata("/docs")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/docs/")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/privacy")).toBe(privacyPageSeo);
    expect(getPageSeoMetadata("/privacy/")).toBe(privacyPageSeo);
    expect(getPageSeoMetadata("/diff")).toEqual(packageDiffSeo());
    expect(getPageSeoMetadata("/login")).toBeUndefined();
    expect(getPageSeoMetadata("/register")).toBeUndefined();
  });

  it("builds canonical metadata for a package diff detail page", () => {
    expect(packageDiffSeo("@preact/signals", "1.0.0", "2.0.0")).toMatchObject({
      title: "@preact/signals 1.0.0 → 2.0.0 | Drydock package diff",
      path: "/diff/@preact/signals/1.0.0/2.0.0",
    });
  });

  it("gives every focused guide distinct canonical metadata", () => {
    expect(Object.keys(discoveryGuideSeoByPath)).toEqual(DISCOVERY_GUIDE_PATHS);
    const titles = new Set<string>();
    for (const path of DISCOVERY_GUIDE_PATHS) {
      const metadata = discoveryGuideSeoByPath[path];
      expect(metadata.path).toBe(path);
      expect(getPageSeoMetadata(path)).toBe(metadata);
      expect(getPageSeoMetadata(`${path}/`)).toBe(metadata);
      titles.add(metadata.title);
    }
    expect(titles.size).toBe(DISCOVERY_GUIDE_PATHS.length);
  });
});

describe("sitemap", () => {
  it("wraps every sitemap location in a url entry", () => {
    const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
    const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)];
    const locations = [...sitemap.matchAll(/<loc>[^<]+<\/loc>/g)];

    expect(entries).toHaveLength(locations.length);
    expect(entries.every((entry) => /<loc>[^<]+<\/loc>/.test(entry[1]))).toBe(true);
  });
});
