import { hydrate, render } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router, lazy, prerender as ssr } from "preact-iso";
import { Toaster } from "./components";
import { extractPrerenderHead, getPageSeoMetadata } from "./lib/seo";
import {
  isDashboardShellRoute,
  isGeneratedIndexRoute,
  isHydratedPrerenderRoute,
} from "./lib/prerender-routes";
import "./style.css";

const LandingPage = lazy(() => import("./pages/Landing"));
const DocsPage = lazy(() => import("./pages/Docs"));
const PrivacyPage = lazy(() => import("./pages/Privacy"));
const LoginPage = lazy(() => import("./pages/Auth/Login"));
const RegisterPage = lazy(() => import("./pages/Auth/Register"));
const VerifyEmailPage = lazy(() => import("./pages/Auth/VerifyEmail"));
const DashboardPage = lazy(() => import("./pages/Dashboard"));
const ScanDetailPage = lazy(() => import("./pages/Dashboard/ScanDetail"));
const SettingsPage = lazy(() => import("./pages/Dashboard/Settings"));
const AccountPage = lazy(() => import("./pages/Dashboard/Account"));
const InvitePage = lazy(() => import("./pages/Dashboard/Invite"));
const GithubAppCallbackPage = lazy(() => import("./pages/Dashboard/GithubAppCallback"));
const ReportPage = lazy(() => import("./pages/Report"));
const NotFoundPage = lazy(() => import("./pages/NotFound"));

export function App() {
  return (
    <LocationProvider>
      <ErrorBoundary onError={(error) => console.error(error)}>
        <Router>
          <Route path="/" component={LandingPage} />
          <Route path="/docs" component={DocsPage} />
          <Route path="/privacy" component={PrivacyPage} />
          <Route path="/login" component={LoginPage} />
          <Route path="/register" component={RegisterPage} />
          <Route path="/verify-email" component={VerifyEmailPage} />
          <Route path="/reports/:token" component={ReportPage} />
          <Route path="/dashboard" component={DashboardPage} />
          <Route path="/dashboard/scans/:id" component={ScanDetailPage} />
          <Route path="/dashboard/settings" component={SettingsPage} />
          <Route path="/dashboard/account" component={AccountPage} />
          <Route path="/dashboard/invite" component={InvitePage} />
          <Route path="/dashboard/settings/github-app/callback" component={GithubAppCallbackPage} />
          <Route default component={NotFoundPage} />
        </Router>
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
  if (isPrerenderedRoute(location.pathname)) {
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
