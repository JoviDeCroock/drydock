import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locationStub } from "preact-iso/prerender";
import { isGeneratedIndexRoute, isPrerenderedRoute, prerender } from "../src";
import { packageDiffIndexPath } from "../src/lib/package-diff-path";
import { CURATED_DIFF_PACKAGES } from "../src/lib/public-content-routes";
import {
  DISCOVERY_GUIDE_PATHS,
  discoveryGuideSeoByPath,
  docsPageSeo,
  getPageSeoMetadata,
  homePageSeo,
  INCIDENT_CASE_PATHS,
  incidentCaseSeoByPath,
  packageDiffIndexSeo,
  packageDiffSeo,
  privacyPageSeo,
} from "../src/lib/seo";
import { SITE_URL } from "../src/lib/seo-metadata";

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

  it.each([
    ["package-only", "/diff/react"],
    ["atpm handle", "/diff/atpm/@ebey.dev/counter/0.0.14/0.0.15"],
  ])("keeps public diff context visible while resolving a %s route", async (_, url) => {
    locationStub(url);
    const result = await prerender({ url });

    expect(result.html).toContain("public package diff");
  });
});

describe("page SEO metadata", () => {
  it("names the product and the artifact promise in the home result", () => {
    expect(homePageSeo).toMatchObject({
      title: "Drydock Package Review: read the artifact before you publish",
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

  // The version-less page used to fall back to packageDiffSeo(), whose path is
  // "/diff" — every package pointed its canonical at the diff tool, so no
  // package page could be indexed as itself.
  it("canonicalises a version-less package page to that package, not to /diff", () => {
    expect(packageDiffIndexSeo("npm", "react")).toMatchObject({
      title: "react release diffs | Drydock",
      path: "/diff/react",
    });
    expect(packageDiffIndexSeo("pypi", "requests").path).toBe("/diff/pypi/requests");
    expect(packageDiffIndexSeo("npm", "@preact/signals").path).toBe("/diff/@preact/signals");
    expect(packageDiffIndexSeo("npm", "react").description).toContain("npm package react");
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
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
  const paths = locations.map((loc) => new URL(loc).pathname);

  it("wraps every sitemap location in a url entry", () => {
    const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)];

    expect(entries).toHaveLength(locations.length);
    expect(entries.every((entry) => /<loc>[^<]+<\/loc>/.test(entry[1]))).toBe(true);
  });

  it("lists every location once, under the canonical origin", () => {
    expect(new Set(locations).size).toBe(locations.length);
    expect(locations.every((loc) => loc.startsWith(`${SITE_URL}/`))).toBe(true);
  });

  // A public page nobody can discover is the failure this catches: adding a
  // route to DISCOVERY_GUIDE_PATHS is the step that gets remembered, and
  // listing it for crawlers is the one that does not.
  it("lists every prerendered guide and incident page", () => {
    for (const path of [...DISCOVERY_GUIDE_PATHS, ...INCIDENT_CASE_PATHS]) {
      expect(paths).toContain(path);
    }
  });

  it("lists the curated package diff pages", () => {
    for (const { ecosystem, name } of CURATED_DIFF_PACKAGES) {
      expect(paths).toContain(packageDiffIndexPath(ecosystem, name));
    }
  });

  it("lists no path that robots.txt disallows", () => {
    const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)$/gm)].map(([, value]) => value);

    for (const path of paths) {
      expect(disallowed.some((prefix) => path.startsWith(prefix))).toBe(false);
    }
  });
});
