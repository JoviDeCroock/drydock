// This module is imported by vite.config.ts through prerender-routes.ts. Keep
// it dependency-free and use explicit TypeScript extensions from that config
// import graph so Vite's native config loader can resolve it.
export const DISCOVERY_GUIDE_PATHS = [
  "/npm-staged-publishing",
  "/github-actions-package-gate",
  "/npm-trusted-publishing",
  "/pypi-release-security",
  "/vscode-extension-security",
  "/package-tarball-diff",
  "/security",
  "/open-source",
  "/maintainer-pledge",
] as const;

export type DiscoveryGuidePath = (typeof DISCOVERY_GUIDE_PATHS)[number];

export const INCIDENT_CASE_PATHS = [
  "/incidents/node-ipc-peacenotwar",
  "/incidents/es5-ext-postinstall",
] as const;

export type IncidentCasePath = (typeof INCIDENT_CASE_PATHS)[number];

/**
 * Packages whose version-less diff page is listed in the sitemap.
 *
 * `/diff/<name>` is the only diff URL stable enough to publish: a version-pair
 * path names two releases and goes stale on the next publish, and the pair page
 * it resolves to is the one that should be indexed anyway. The list is curated
 * rather than generated so that what Drydock asks search engines to crawl stays
 * a reviewed decision — these are packages a reader plausibly searches a release
 * diff for, across both registries, and none of them is listed because of
 * anything a review found in it.
 */
export const CURATED_DIFF_PACKAGES: readonly {
  ecosystem: "npm" | "pypi";
  name: string;
}[] = [
  { ecosystem: "npm", name: "react" },
  { ecosystem: "npm", name: "vue" },
  { ecosystem: "npm", name: "express" },
  { ecosystem: "npm", name: "axios" },
  { ecosystem: "npm", name: "lodash" },
  { ecosystem: "npm", name: "typescript" },
  { ecosystem: "npm", name: "next" },
  { ecosystem: "npm", name: "vite" },
  { ecosystem: "npm", name: "eslint" },
  { ecosystem: "npm", name: "semver" },
  { ecosystem: "pypi", name: "requests" },
  { ecosystem: "pypi", name: "urllib3" },
  { ecosystem: "pypi", name: "numpy" },
  { ecosystem: "pypi", name: "pandas" },
  { ecosystem: "pypi", name: "flask" },
  { ecosystem: "pypi", name: "django" },
];
