import { useEffect } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import {
  capturePageview,
  identifyUser,
  initAnalytics,
  resetAnalytics,
  setOrganizationGroup,
} from "../lib/analytics";
import { sessionModel } from "../models/auth";
import { activeOrganizationId } from "../models/active-organization";

// Headless: boots the analytics SDK once, then keeps PostHog's identity and the
// SPA pageview stream in sync with the router and auth/org signals. Every call
// no-ops until the SDK is initialised, so SSR/prerender and unconfigured builds
// are unaffected.
export function AnalyticsTracker() {
  const location = useLocation();

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    capturePageview();
  }, [location.url]);

  useSignalEffect(() => {
    const user = sessionModel.user.value;
    if (user) identifyUser(user.id);
    else resetAnalytics();
  });

  useSignalEffect(() => {
    const organizationId = activeOrganizationId.value;
    if (organizationId) setOrganizationGroup(organizationId);
  });

  return null;
}
