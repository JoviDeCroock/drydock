import { hydrate, render } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router, prerender as ssr } from "preact-iso";
import { Toaster } from "./components/Toast";
import { AppErrorBoundary } from "./features/error-report/AppErrorBoundary";
import { lazyRoute } from "./features/error-report/lazy-route";
import { applyActiveOrganizationFromUrl } from "./models/active-organization";
import { extractPrerenderHead, getPageSeoMetadata } from "./lib/seo";
import {
  isDashboardShellRoute,
  isGeneratedIndexRoute,
  isHydratedPrerenderRoute,
} from "./lib/prerender-routes";
import "./style.css";

const LandingPage = lazyRoute(() => import("./pages/Landing"));
const DocsPage = lazyRoute(() => import("./pages/Docs"));
const PrivacyPage = lazyRoute(() => import("./pages/Privacy"));
const LoginPage = lazyRoute(() => import("./pages/Auth/Login"));
const RegisterPage = lazyRoute(() => import("./pages/Auth/Register"));
const VerifyEmailPage = lazyRoute(() => import("./pages/Auth/VerifyEmail"));
const DashboardPage = lazyRoute(() => import("./pages/Dashboard"));
const ScanDetailPage = lazyRoute(() => import("./pages/Dashboard/ScanDetail"));
const PackageReleasesPage = lazyRoute(() => import("./pages/Dashboard/PackageReleases"));
const SettingsPage = lazyRoute(() => import("./pages/Dashboard/Settings"));
const AccountPage = lazyRoute(() => import("./pages/Dashboard/Account"));
const InvitePage = lazyRoute(() => import("./pages/Dashboard/Invite"));
const GithubAppCallbackPage = lazyRoute(() => import("./pages/Dashboard/GithubAppCallback"));
const PackageDiffPage = lazyRoute(() => import("./pages/Diff"));
const PublicReportPage = lazyRoute(() => import("./pages/PublicReport"));
const DiscoveryGuidePage = lazyRoute(() => import("./pages/Guides"));
const IncidentCasePage = lazyRoute(() => import("./pages/Incidents"));
const NotFoundPage = lazyRoute(() => import("./pages/NotFound"));

export function App() {
  return (
    <LocationProvider>
      <ErrorBoundary>
        <AppErrorBoundary>
          <Router>
            <Route path="/" component={LandingPage} />
            <Route path="/docs" component={DocsPage} />
            <Route path="/privacy" component={PrivacyPage} />
            <Route path="/npm-staged-publishing" component={DiscoveryGuidePage} />
            <Route path="/github-actions-package-gate" component={DiscoveryGuidePage} />
            <Route path="/npm-trusted-publishing" component={DiscoveryGuidePage} />
            <Route path="/pypi-release-security" component={DiscoveryGuidePage} />
            <Route path="/vscode-extension-security" component={DiscoveryGuidePage} />
            <Route path="/package-tarball-diff" component={DiscoveryGuidePage} />
            <Route path="/security" component={DiscoveryGuidePage} />
            <Route path="/open-source" component={DiscoveryGuidePage} />
            <Route path="/diff" component={PackageDiffPage} />
            <Route path="/diff/*" component={PackageDiffPage} />
            <Route path="/incidents/node-ipc-peacenotwar" component={IncidentCasePage} />
            <Route path="/incidents/es5-ext-postinstall" component={IncidentCasePage} />
            <Route path="/login" component={LoginPage} />
            <Route path="/register" component={RegisterPage} />
            <Route path="/verify-email" component={VerifyEmailPage} />
            {/*
            Both paths, like /diff above. `:token` is a required segment, so it
            cannot match the prerender URL `/reports` — without the bare route
            the shell falls through to `default` and every share link serves a
            200 whose body says "Page not found" until the bundle hydrates.
            PublicReportPage server-renders its loading skeleton for an empty
            token — the correct shell for a real share link — and swaps in the
            "no public index" explainer once mounted on the client.
          */}
            <Route path="/reports" component={PublicReportPage} />
            <Route path="/reports/:token" component={PublicReportPage} />
            <Route path="/dashboard" component={DashboardPage} />
            <Route path="/dashboard/scans/:id" component={ScanDetailPage} />
            <Route path="/dashboard/packages/:name+" component={PackageReleasesPage} />
            <Route path="/dashboard/settings" component={SettingsPage} />
            <Route path="/dashboard/account" component={AccountPage} />
            <Route path="/dashboard/invite" component={InvitePage} />
            <Route
              path="/dashboard/settings/github-app/callback"
              component={GithubAppCallbackPage}
            />
            <Route default component={NotFoundPage} />
          </Router>
        </AppErrorBoundary>
      </ErrorBoundary>
      <Toaster />
    </LocationProvider>
  );
}

export function isPrerenderedRoute(pathname: string) {
  return isHydratedPrerenderRoute(pathname);
}

export { isGeneratedIndexRoute };

function emptyAppShell() {
  return { html: "", links: new Set<string>() };
}

if (typeof window !== "undefined") {
  const appElement = document.getElementById("app");
  if (!appElement) throw new Error("App element not found");
  // Adopt an emailed `?org=<id>` deep-link before the router mounts so the first
  // org-scoped request (which reads the active org from localStorage) targets the
  // organization the link is about. Scoped to the dashboard, the only surface the
  // param means anything on. A package page keeps its `?org=` and pins it
  // itself, so the organization stays part of the page's address.
  if (
    location.pathname.startsWith("/dashboard") &&
    !location.pathname.startsWith("/dashboard/packages/")
  ) {
    applyActiveOrganizationFromUrl();
  }
  if (isPrerenderedRoute(location.pathname) && appElement.firstChild) {
    hydrate(<App />, appElement);
  } else {
    appElement.innerHTML = "";
    render(<App />, appElement);
  }
}

export async function prerender(data: Record<string, unknown>) {
  const prerenderUrl = typeof data.url === "string" ? data.url : location.pathname;
  const pathname = new URL(prerenderUrl, "http://localhost").pathname;
  if (isDashboardShellRoute(pathname)) return emptyAppShell();

  const result = await ssr(<App {...data} />);
  const extractedHead = extractPrerenderHead();
  const shouldEmitHead = getPageSeoMetadata(pathname);
  const head = shouldEmitHead ? extractedHead : undefined;

  // The prerender crawler follows every rendered <a href> as a route to prerender.
  // Keep it to the statically prerendered set so conditional links (e.g. the docs
  // page's authenticated "Open settings" link) don't generate stray HTML.
  const links = new Set<string>();
  for (const href of result.links ?? []) {
    if (isGeneratedIndexRoute(new URL(href, "http://localhost").pathname)) {
      links.add(href);
    }
  }

  return head ? { ...result, links, head } : { ...result, links };
}
