// Coarse attribution for the public marketing surfaces (landing, docs, and the
// anonymous package diff). The campaign question this answers is "which channel
// did a visit come from, on which day" — nothing per-visitor.
//
// Privacy posture: the classifier reduces a referrer to one of a closed set of
// buckets and throws the original away. No IP, no full referrer URL, no user
// agent, and no session identifier reaches storage, so nothing here can be
// joined back to a person. That is a deliberate constraint on the anonymous
// surface, not an implementation detail — see docs/security-model.md.

export const TRAFFIC_SOURCES = [
  "bluesky",
  "x",
  "linkedin",
  "hackernews",
  "reddit",
  "youtube",
  "github",
  "search",
  "newsletter",
  "registry",
  "chat",
  "internal",
  "direct",
  "other",
  "bot",
] as const;

export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

const MARKETING_SURFACES = ["landing", "docs", "diff_index", "diff"] as const;

export type MarketingSurface = (typeof MARKETING_SURFACES)[number];

// Matched against the referrer's registrable-ish suffix, longest first, so
// `out.reddit.com` and `news.ycombinator.com` resolve before a bare `.com`
// never would.
const HOST_SOURCES: ReadonlyArray<readonly [string, TrafficSource]> = [
  ["bsky.app", "bluesky"],
  ["bsky.social", "bluesky"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["t.co", "x"],
  ["linkedin.com", "linkedin"],
  ["lnkd.in", "linkedin"],
  ["news.ycombinator.com", "hackernews"],
  ["reddit.com", "reddit"],
  ["redd.it", "reddit"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["github.com", "github"],
  ["github.io", "github"],
  ["npmjs.com", "registry"],
  ["pypi.org", "registry"],
  ["google.com", "search"],
  ["bing.com", "search"],
  ["duckduckgo.com", "search"],
  ["ecosia.org", "search"],
  ["kagi.com", "search"],
  ["slack.com", "chat"],
  ["discord.com", "chat"],
  ["discordapp.com", "chat"],
];

const GOOGLE_SEARCH_PREFIX = "google.";

// utm_source values we publish ourselves. Anything unrecognized collapses to
// "other" so a crafted link cannot invent an unbounded set of storage keys.
const CAMPAIGN_SOURCES = new Map<string, TrafficSource>([
  ["bluesky", "bluesky"],
  ["bsky", "bluesky"],
  ["x", "x"],
  ["twitter", "x"],
  ["linkedin", "linkedin"],
  ["hn", "hackernews"],
  ["hackernews", "hackernews"],
  ["reddit", "reddit"],
  ["youtube", "youtube"],
  ["github", "github"],
  ["newsletter", "newsletter"],
  ["javascriptweekly", "newsletter"],
  ["nodeweekly", "newsletter"],
  ["tldrsec", "newsletter"],
  ["npm", "registry"],
  ["slack", "chat"],
  ["discord", "chat"],
]);

const BOT_UA_RE =
  /bot\b|crawler|spider|crawling|slurp|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegram|preview|headless|lighthouse|monitoring|uptime|curl\/|wget\/|python-requests|go-http-client|okhttp|axios\//i;

export interface TrafficSourceInput {
  referer?: string | null;
  campaignSource?: string | null;
  userAgent?: string | null;
  selfHostname?: string | null;
}

function hostnameOf(referer: string): string | null {
  try {
    return new URL(referer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function matchHost(hostname: string): TrafficSource | null {
  for (const [suffix, source] of HOST_SOURCES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return source;
  }
  // google.co.uk, google.de, … all behave as one channel.
  if (hostname.startsWith(GOOGLE_SEARCH_PREFIX)) return "search";
  return null;
}

export function classifyTrafficSource(input: TrafficSourceInput): TrafficSource {
  // Bots are bucketed rather than dropped: unfurl crawlers are the signal that
  // a link was actually posted somewhere, and keeping them labeled means human
  // counts can exclude them instead of silently absorbing them.
  if (input.userAgent && BOT_UA_RE.test(input.userAgent)) return "bot";

  const campaign = input.campaignSource?.trim().toLowerCase();
  if (campaign) return CAMPAIGN_SOURCES.get(campaign) ?? "other";

  const referer = input.referer?.trim();
  if (!referer) return "direct";

  const hostname = hostnameOf(referer);
  if (!hostname) return "other";

  const self = input.selfHostname?.toLowerCase().replace(/^www\./, "");
  if (self && (hostname === self || hostname.endsWith(`.${self}`))) return "internal";

  return matchHost(hostname) ?? "other";
}

// Only public marketing routes are attributed. Authenticated product routes are
// never recorded, so a dashboard visit cannot be inferred from this data.
export function marketingSurfaceForPath(pathname: string): MarketingSurface | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "") return "landing";
  if (path === "/") return "landing";
  if (path === "/docs") return "docs";
  if (path === "/diff") return "diff_index";
  if (path.startsWith("/diff/")) return "diff";
  return null;
}
