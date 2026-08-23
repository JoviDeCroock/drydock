import { DISCOVERY_GUIDE_PATHS, INCIDENT_CASE_PATHS } from "./seo-metadata";

const HYDRATED_PRERENDER_ROUTES = [
  "/",
  "/login",
  "/register",
  "/docs",
  "/privacy",
  "/diff",
  "/reports",
  ...DISCOVERY_GUIDE_PATHS,
  ...INCIDENT_CASE_PATHS,
] as const;

const DASHBOARD_SHELL_ROUTES = [
  "/dashboard",
  "/dashboard/account",
  "/dashboard/invite",
  "/dashboard/settings",
  "/dashboard/settings/github-app/callback",
] as const;

export const ADDITIONAL_PRERENDER_ROUTES = [
  "/login",
  "/register",
  "/docs",
  "/privacy",
  "/diff",
  // Shell for /reports/:token. Without it the SPA fallback serves the
  // prerendered landing page, so a shared report link unfurls with the
  // marketing card and flashes marketing copy before client routing.
  "/reports",
  ...DISCOVERY_GUIDE_PATHS,
  ...INCIDENT_CASE_PATHS,
  ...DASHBOARD_SHELL_ROUTES,
] as const;

export function isHydratedPrerenderRoute(pathname: string) {
  return routeIncludes(HYDRATED_PRERENDER_ROUTES, pathname);
}

export function isDashboardShellRoute(pathname: string) {
  return routeIncludes(DASHBOARD_SHELL_ROUTES, pathname);
}

export function isGeneratedIndexRoute(pathname: string) {
  return isHydratedPrerenderRoute(pathname) || isDashboardShellRoute(pathname);
}

function routeIncludes(routes: readonly string[], pathname: string) {
  return routes.includes(canonicalizeRoutePath(pathname));
}

function canonicalizeRoutePath(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
