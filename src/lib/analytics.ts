import posthog from "posthog-js";
import { ANALYTICS_PROXY_PREFIX } from "../../server/lib/analytics-proxy-path";

// PostHog is reached through the same-origin Worker proxy (see
// server/lib/analytics-proxy.ts), so `api_host` is the first-party prefix. The
// UI host only powers "view in PostHog" deep links from the toolbar.
const POSTHOG_UI_HOST = "https://eu.posthog.com";

const PUBLIC_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;

// Product funnel event names. Centralised so capture sites and analysis stay in
// lock-step; values are stable wire identifiers — never rename casually.
export const AnalyticsEvent = {
  Pageview: "$pageview",
  ScanDiscoveryRun: "scan_discovery_run",
  ScanDetailViewed: "scan_detail_viewed",
  ScanDecisionRecorded: "scan_decision_recorded",
  WorkflowGateDecisionRecorded: "workflow_gate_decision_recorded",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

// Only primitive, non-PII properties may ride along on an event. Package names,
// reasons, emails, and tokens must never be captured.
export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

const ORGANIZATION_GROUP_TYPE = "organization";

let started = false;

function enabled(): boolean {
  return started && typeof window !== "undefined";
}

// Initialise the browser SDK. No-ops when no key is configured (local dev,
// self-hosting, forks) or off the browser (SSR/prerender). Safe to call repeatedly.
export function initAnalytics(): void {
  if (started) return;
  if (typeof window === "undefined") return;
  if (!PUBLIC_KEY) return;

  posthog.init(PUBLIC_KEY, {
    api_host: ANALYTICS_PROXY_PREFIX,
    ui_host: POSTHOG_UI_HOST,
    // Anonymous visitors don't get a stored person profile; we only persist one
    // once a signed-in reviewer is identified.
    person_profiles: "identified_only",
    // SPA navigations are captured manually in AnalyticsTracker.
    capture_pageview: false,
    capture_pageleave: true,
    // A security workbench should never silently hoover up DOM interactions,
    // session video, or surveys — every signal we send is deliberate.
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    respect_dnt: true,
  });
  started = true;
}

export function capturePageview(): void {
  if (!enabled()) return;
  posthog.capture(AnalyticsEvent.Pageview);
}

export function trackEvent(event: AnalyticsEventName, properties?: AnalyticsProperties): void {
  if (!enabled()) return;
  posthog.capture(event, properties);
}

// Associate subsequent events with a stable, opaque user id. We pass no email
// or name so PostHog never stores reviewer PII.
export function identifyUser(userId: string): void {
  if (!enabled()) return;
  posthog.identify(userId);
}

// Roll events up by organization for per-customer funnels and retention.
export function setOrganizationGroup(organizationId: string): void {
  if (!enabled()) return;
  posthog.group(ORGANIZATION_GROUP_TYPE, organizationId);
}

// Clear identity on sign-out so the next account on a shared device starts fresh.
export function resetAnalytics(): void {
  if (!enabled()) return;
  posthog.reset();
}
