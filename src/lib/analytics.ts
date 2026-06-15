export const POSTHOG_EU_HOST = "https://eu.i.posthog.com";

type AnalyticsProperty = string | number | boolean | null;
type AnalyticsProperties = Record<string, AnalyticsProperty | undefined>;
type PostHogClient = typeof import("posthog-js").default;

const POSTHOG_PROJECT_KEY = import.meta.env.VITE_POSTHOG_KEY;

let clientPromise: Promise<PostHogClient | null> | null = null;
let client: PostHogClient | null = null;

export function isAnalyticsConfigured(): boolean {
  return analyticsProjectKey() !== null;
}

export function currentAnalyticsHost(): string {
  return POSTHOG_EU_HOST;
}

export function normalizeAnalyticsPath(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function trackPageView(url: string): void {
  trackProductEvent("$pageview", {
    $current_url: url,
    path: normalizeAnalyticsPath(url),
  });
}

export function trackProductEvent(event: string, properties: AnalyticsProperties = {}): void {
  withPostHog((posthog) => {
    posthog.capture(event, cleanProperties(properties));
  });
}

export function identifyAnalyticsUser(userId: string): void {
  withPostHog((posthog) => {
    posthog.identify(userId);
  });
}

export function resetAnalytics(): void {
  withPostHog((posthog) => {
    posthog.reset();
  });
}

function withPostHog(callback: (posthog: PostHogClient) => void): void {
  void (async () => {
    try {
      const posthog = await getPostHogClient();
      if (!posthog) return;
      callback(posthog);
    } catch {
      // Analytics must never break the product flow.
    }
  })();
}

function cleanProperties(properties: AnalyticsProperties): Record<string, AnalyticsProperty> {
  const cleaned: Record<string, AnalyticsProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function getPostHogClient(): Promise<PostHogClient | null> {
  if (client) return Promise.resolve(client);
  const projectKey = analyticsProjectKey();
  if (!projectKey) return Promise.resolve(null);
  if (typeof window === "undefined") return Promise.resolve(null);
  clientPromise ??= import("posthog-js")
    .then((module) => {
      const posthog = module.default;
      posthog.init(projectKey, {
        api_host: POSTHOG_EU_HOST,
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        loaded: (loadedClient) => {
          loadedClient.register({ app: "drydock" });
        },
      });
      client = posthog;
      return posthog;
    })
    .catch(() => null);
  return clientPromise;
}

function analyticsProjectKey(): string | null {
  if (typeof POSTHOG_PROJECT_KEY !== "string" || POSTHOG_PROJECT_KEY.length === 0) return null;
  return POSTHOG_PROJECT_KEY;
}
