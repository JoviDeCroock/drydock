// This module is imported by vite.config.ts through prerender-routes.ts. Keep
// it dependency-free and use explicit TypeScript extensions from that config
// import graph so Vite's native config loader can resolve it.
export const DISCOVERY_GUIDE_PATHS = [
  "/npm-staged-publishing",
  "/github-actions-package-gate",
  "/pypi-release-security",
  "/vscode-extension-security",
  "/package-tarball-diff",
  "/security",
  "/open-source",
] as const;

export type DiscoveryGuidePath = (typeof DISCOVERY_GUIDE_PATHS)[number];

export const INCIDENT_CASE_PATHS = [
  "/incidents/node-ipc-peacenotwar",
  "/incidents/es5-ext-postinstall",
] as const;

export type IncidentCasePath = (typeof INCIDENT_CASE_PATHS)[number];
