import { render } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router, lazy } from "preact-iso";
import "./style.css";

const LandingPage = lazy(() => import("./pages/Landing"));
const LoginPage = lazy(() => import("./pages/Auth/Login"));
const RegisterPage = lazy(() => import("./pages/Auth/Register"));
const DashboardPage = lazy(() => import("./pages/Dashboard"));
const ScanDetailPage = lazy(() => import("./pages/Dashboard/ScanDetail"));
const SettingsPage = lazy(() => import("./pages/Dashboard/Settings"));
const GithubAppCallbackPage = lazy(() => import("./pages/Dashboard/GithubAppCallback"));
const NotFoundPage = lazy(() => import("./pages/NotFound"));

export function App() {
  return (
    <LocationProvider>
      <ErrorBoundary onError={(error) => console.error(error)}>
        <Router>
          <Route path="/" component={LandingPage} />
          <Route path="/login" component={LoginPage} />
          <Route path="/register" component={RegisterPage} />
          <Route path="/dashboard" component={DashboardPage} />
          <Route path="/dashboard/scans/:id" component={ScanDetailPage} />
          <Route path="/dashboard/settings" component={SettingsPage} />
          <Route path="/dashboard/settings/github-app/callback" component={GithubAppCallbackPage} />
          <Route default component={NotFoundPage} />
        </Router>
      </ErrorBoundary>
    </LocationProvider>
  );
}

const appElement = document.getElementById("app");
if (!appElement) throw new Error("App element not found");
render(<App />, appElement);
