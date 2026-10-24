import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locationStub } from "preact-iso/prerender";
import incidentBenchmarkReport from "../public/benchmarks/shai-hulud-nx/v1.json";
import { isGeneratedIndexRoute, isPrerenderedRoute, prerender } from "../src";
import { packageDiffIndexPath } from "../src/lib/package-diff-path";
import { ADDITIONAL_PRERENDER_ROUTES } from "../src/lib/prerender-routes";
import { CURATED_DIFF_PACKAGES } from "../src/lib/public-content-routes";
import {
  agentsPageSeo,
  DISCOVERY_GUIDE_PATHS,
  discoveryGuideSeoByPath,
  docsPageSeo,
  getPageSeoMetadata,
  homePageSeo,
  INCIDENT_CASE_PATHS,
  incidentBenchmarkSeo,
  incidentCaseSeoByPath,
  packageDiffIndexSeo,
  packageDiffSeo,
  privacyPageSeo,
} from "../src/lib/seo";
import { SITE_URL } from "../src/lib/seo-metadata";

const PUBLIC_ARTICLE_PATHS = [
  ...DISCOVERY_GUIDE_PATHS,
  ...INCIDENT_CASE_PATHS,
  incidentBenchmarkSeo.path,
];

describe("isPrerenderedRoute", () => {
  it("matches generated public prerender pages with or without canonical trailing slashes", () => {
    expect(isPrerenderedRoute("/")).toBe(true);
    expect(isPrerenderedRoute("/login")).toBe(true);
    expect(isPrerenderedRoute("/login/")).toBe(true);
    expect(isPrerenderedRoute("/register")).toBe(true);
    expect(isPrerenderedRoute("/register/")).toBe(true);
    expect(isPrerenderedRoute("/docs")).toBe(true);
    expect(isPrerenderedRoute("/docs/")).toBe(true);
    expect(isPrerenderedRoute("/agents")).toBe(true);
    expect(isPrerenderedRoute("/agents/")).toBe(true);
    expect(isPrerenderedRoute("/privacy")).toBe(true);
    expect(isPrerenderedRoute("/privacy/")).toBe(true);
    for (const path of PUBLIC_ARTICLE_PATHS) {
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

  it("prerenders the canonical homepage promise and diff action with matching metadata", async () => {
    locationStub("/");
    const result = await prerender({ url: "/" });
    const head = "head" in result ? result.head : undefined;

    expect(result.html).toMatch(
      /<h1\b[^>]*>See what changed in the package your users will install\.<\/h1>/,
    );
    expect(result.html).toMatch(/<a\b[^>]*href="\/diff"[^>]*>Diff a package<\/a>/);
    expect(result.html).toContain(homePageSeo.description);
    expect(head?.title).toBe(homePageSeo.title);
    expect(Array.from(head?.elements ?? [])).toEqual(
      expect.arrayContaining([
        { type: "meta", props: { name: "description", content: homePageSeo.description } },
        { type: "meta", props: { property: "og:description", content: homePageSeo.description } },
        { type: "meta", props: { name: "twitter:description", content: homePageSeo.description } },
        expect.objectContaining({
          type: "link",
          props: expect.objectContaining({ rel: "canonical", href: `${SITE_URL}/` }),
        }),
      ]),
    );
  });

  it("emits an empty app shell for dashboard route indexes", async () => {
    const result = await prerender({ url: "/dashboard/settings" });

    expect(result).toEqual({ html: "", links: new Set() });
  });

  it.each([
    ["package-only", "/diff/react"],
    ["PyPI package-only", "/diff/pypi/requests"],
    ["atpm handle", "/diff/atpm/@ebey.dev/counter/0.0.14/0.0.15"],
  ])("keeps public diff context visible while resolving a %s route", async (_, url) => {
    locationStub(url);
    const result = await prerender({ url });

    expect(result.html).toContain("public package diff");
  });
});

// The route table in src/index.tsx is the one list nothing else derives from.
// A public page listed for prerendering, metadata, and the sitemap but missing
// there renders "Page not found" under a 200 — /maintainer-pledge shipped that
// way. Reading the source keeps this check free of a router render per path.
const ROUTE_PATTERNS = [
  ...readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8").matchAll(
    /<ScopedRoute\s+path="([^"]+)"/g,
  ),
].map(([, path]) => path);

function hasRoute(pathname: string) {
  return ROUTE_PATTERNS.some((pattern) => {
    if (pattern === pathname) return true;
    if (pattern.endsWith("/*")) return pathname.startsWith(pattern.slice(0, -1));
    const segments = pattern.split("/");
    const actual = pathname.split("/");
    return (
      segments.length === actual.length &&
      segments.every((segment, index) => segment.startsWith(":") || segment === actual[index])
    );
  });
}

const SITEMAP_PATHS = [
  ...readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8").matchAll(
    /<loc>([^<]+)<\/loc>/g,
  ),
].map(([, loc]) => new URL(loc).pathname);

describe("public route parity", () => {
  it("routes every prerendered and sitemap path to a page", () => {
    const publicPaths = new Set([
      ...ADDITIONAL_PRERENDER_ROUTES,
      ...DISCOVERY_GUIDE_PATHS,
      ...INCIDENT_CASE_PATHS,
      ...SITEMAP_PATHS,
    ]);
    const unrouted = [...publicPaths].filter((path) => !hasRoute(path));

    expect(unrouted).toEqual([]);
  });

  it("makes the agent guide readable and linkable before JavaScript runs", async () => {
    locationStub("/agents");
    const result = await prerender({ url: "/agents" });
    const head = "head" in result ? result.head : undefined;

    expect(head?.title).toBe(agentsPageSeo.title);
    expect(result.html).toContain("Review dependency upgrades with your coding agent.");
    expect(result.html).toContain('href="/agents/package-review.md"');
    expect(result.html).toContain('href="/diff/react/18.2.0/18.3.1"');
    expect(result.html).toContain('href="/diff/pypi/requests/2.31.0/2.32.3"');
    expect(result.html).toContain("textSamplesOmitted");
    expect(result.html).toContain('id="mcp"');
    expect(result.html).toContain("https://drydock.org/api/public/v1/mcp");
    expect(result.html).not.toContain("Page not found");
  });

  it("connects the Docs jump list and instruction to the public agent guide", async () => {
    locationStub("/docs");
    const result = await prerender({ url: "/docs" });

    expect(result.html).toContain('href="#agent-package-review"');
    expect(result.html).toContain('id="agent-package-review"');
    expect(result.html).toContain('href="/agents"');
    expect(result.html).toContain("AGENTS.md · package review");
  });

  it("keeps the project instruction and its public download identical", () => {
    const source = readFileSync(
      new URL("../src/features/agent-quickstart/package-review.md", import.meta.url),
      "utf8",
    );
    const download = readFileSync(
      new URL("../public/agents/package-review.md", import.meta.url),
      "utf8",
    );

    expect(download).toBe(source);
  });

  it("resolves every machine-readable discovery link to a public page or static document", () => {
    const discovery = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
    const paths = [...discovery.matchAll(/\]\(https:\/\/drydock\.org([^)]*)\)/g)].map(
      ([, path]) => path,
    );

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        isPrerenderedRoute(path) || existsSync(new URL("../public" + path, import.meta.url)),
      ).toBe(true);
    }
  });

  it.each(PUBLIC_ARTICLE_PATHS)("prerenders %s under its own title", async (path) => {
    locationStub(path);
    const result = await prerender({ url: path });

    const head = "head" in result ? result.head : undefined;

    expect(head?.title).toBe(getPageSeoMetadata(path)?.title);
    expect(result.html).not.toContain("Page not found");
  });

  it("prerenders benchmark measurements, evidence, source citations, and reproduction links", async () => {
    locationStub(incidentBenchmarkSeo.path);
    const { html } = await prerender({ url: incidentBenchmarkSeo.path });

    expect(html).toContain("sanitized behavior reconstructions");
    expect(html).toContain("not the original compromised tarballs");
    expect(html).toContain('id="citation"');
    expect(html).toContain(incidentBenchmarkReport.suiteVersion);
    expect(html).toContain(incidentBenchmarkReport.rulesVersion);
    expect(html).toContain(incidentBenchmarkReport.corpusSha256);
    expect(html).toContain(
      `${incidentBenchmarkReport.summary.malicious.caught}/${incidentBenchmarkReport.summary.malicious.total} caught at high release risk or above with required rule evidence`,
    );
    expect(html).toContain(
      `${incidentBenchmarkReport.summary.benign.falsePositives}/${incidentBenchmarkReport.summary.benign.total} false positives`,
    );
    expect(html).toContain(
      `${incidentBenchmarkReport.summary.benign.falsePositives} of ${incidentBenchmarkReport.summary.benign.total} benign controls also reached medium release risk or above`,
    );
    expect(html).toContain("pnpm run benchmark:incidents");
    expect(html).toContain('href="/benchmarks/shai-hulud-nx/v1.json"');
    expect(html.match(/download="drydock-shai-hulud-nx-v1.json"/g)).toHaveLength(2);
    expect(html).toContain(`/tree/${incidentBenchmarkReport.engineRevision}/server/lib/review`);
    for (const testCase of incidentBenchmarkReport.cases) {
      expect(html).toContain(testCase.title);
      expect(html).toContain(`/blob/main/${testCase.fixturePath}`);
      for (const finding of testCase.findings) {
        expect(html).toContain(finding.ruleId);
      }
    }
    for (const source of incidentBenchmarkReport.sources) {
      expect(html).toContain(source.url);
    }
  });
});

describe("page SEO metadata", () => {
  it("names the product and the artifact promise in the home result", () => {
    expect(homePageSeo).toMatchObject({
      title: "Drydock Package Review: See what changed in the package your users will install",
    });
    expect(homePageSeo.description).toBe(
      "Inspect changed files and supply-chain findings. Try a public package diff without an account or installation. Add a review to your built release when you’re ready to publish.",
    );
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

  it("gives the benchmark its own canonical metadata with an explicit reconstruction scope", () => {
    expect(getPageSeoMetadata(incidentBenchmarkSeo.path)).toBe(incidentBenchmarkSeo);
    expect(getPageSeoMetadata(`${incidentBenchmarkSeo.path}/`)).toBe(incidentBenchmarkSeo);
    expect(incidentBenchmarkSeo.description).toContain("behavior reconstructions");
  });

  it("is defined only for the public landing, docs, and privacy pages", () => {
    expect(getPageSeoMetadata("/")).toBe(homePageSeo);
    expect(getPageSeoMetadata("/docs")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/docs/")).toBe(docsPageSeo);
    expect(getPageSeoMetadata("/agents")).toBe(agentsPageSeo);
    expect(getPageSeoMetadata("/agents/")).toBe(agentsPageSeo);
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
  it("lists every prerendered guide, incident page, and benchmark", () => {
    for (const path of PUBLIC_ARTICLE_PATHS) {
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
