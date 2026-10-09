import { hydrate, render } from "preact";
import { ErrorBoundary, LocationProvider, Router, prerender as ssr } from "preact-iso";
import { Toaster } from "./components/Toast";
import { AppErrorBoundary } from "./features/error-report/AppErrorBoundary";
import { lazyRoute } from "./features/error-report/lazy-route";
import { ScopedRoute } from "./features/routing/ScopedRoute";
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
const ForgotPasswordPage = lazyRoute(() => import("./pages/Auth/ForgotPassword"));
const ResetPasswordPage = lazyRoute(() => import("./pages/Auth/ResetPassword"));
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
            <ScopedRoute path="/" component={LandingPage} />
            <ScopedRoute path="/docs" component={DocsPage} />
            <ScopedRoute path="/privacy" component={PrivacyPage} />
            <ScopedRoute path="/npm-staged-publishing" component={DiscoveryGuidePage} />
            <ScopedRoute path="/github-actions-package-gate" component={DiscoveryGuidePage} />
            <ScopedRoute path="/npm-trusted-publishing" component={DiscoveryGuidePage} />
            <ScopedRoute path="/pypi-release-security" component={DiscoveryGuidePage} />
            <ScopedRoute path="/vscode-extension-security" component={DiscoveryGuidePage} />
            <ScopedRoute path="/package-tarball-diff" component={DiscoveryGuidePage} />
            <ScopedRoute path="/security" component={DiscoveryGuidePage} />
            <ScopedRoute path="/open-source" component={DiscoveryGuidePage} />
            <ScopedRoute path="/maintainer-pledge" component={DiscoveryGuidePage} />
            <ScopedRoute path="/diff" component={PackageDiffPage} />
            <ScopedRoute path="/diff/*" component={PackageDiffPage} />
            <ScopedRoute path="/incidents/node-ipc-peacenotwar" component={IncidentCasePage} />
            <ScopedRoute path="/incidents/es5-ext-postinstall" component={IncidentCasePage} />
            <ScopedRoute path="/login" component={LoginPage} />
            <ScopedRoute path="/register" component={RegisterPage} />
            <ScopedRoute path="/verify-email" component={VerifyEmailPage} />
            <ScopedRoute path="/forgot-password" component={ForgotPasswordPage} />
            <ScopedRoute path="/reset-password" component={ResetPasswordPage} />
            {/*
            Both paths, like /diff above. `:token` is a required segment, so it
            cannot match the prerender URL `/reports` — without the bare route
            the shell falls through to `default` and every share link serves a
            200 whose body says "Page not found" until the bundle hydrates.
            PublicReportPage server-renders its loading skeleton for an empty
            token — the correct shell for a real share link — and swaps in the
            "no public index" explainer once mounted on the client.
          */}
            <ScopedRoute path="/reports" component={PublicReportPage} />
            <ScopedRoute path="/reports/:token" component={PublicReportPage} />
            <ScopedRoute path="/dashboard" component={DashboardPage} />
            <ScopedRoute path="/dashboard/scans/:id" component={ScanDetailPage} />
            <ScopedRoute path="/dashboard/packages/:name+" component={PackageReleasesPage} />
            <ScopedRoute path="/dashboard/settings" component={SettingsPage} />
            <ScopedRoute path="/dashboard/account" component={AccountPage} />
            <ScopedRoute path="/dashboard/invite" component={InvitePage} />
            <ScopedRoute
              path="/dashboard/settings/github-app/callback"
              component={GithubAppCallbackPage}
            />
            <ScopedRoute default component={NotFoundPage} />
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
  // param means anything on. Package and review pages keep their `?org=` and
  // pin it themselves, so the organization stays part of the page's address.
  if (
    location.pathname.startsWith("/dashboard") &&
    !location.pathname.startsWith("/dashboard/packages/") &&
    !location.pathname.startsWith("/dashboard/scans/")
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
