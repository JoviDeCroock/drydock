import type { SharedScanRow } from "../db/scan-share";
import { coloCacheDelete } from "./platform/colo-cache";

export const THREAT_FEED_SCHEMA = "drydock.threat-feed.v1";

export const PUBLIC_ECOSYSTEMS = ["npm", "pypi", "vscode"] as const;
export type PublicEcosystem = (typeof PUBLIC_ECOSYSTEMS)[number];

const PUBLIC_PACKAGE_NAME_MAX: Record<PublicEcosystem, number> = {
  npm: 214,
  pypi: 214,
  vscode: 257,
};

export function publicPackageNameMax(ecosystem: PublicEcosystem): number {
  return PUBLIC_PACKAGE_NAME_MAX[ecosystem];
}

export function publicPackageLookupKey(ecosystem: PublicEcosystem, packageName: string): string {
  const normalized =
    ecosystem === "pypi"
      ? packageName.toLowerCase().replace(/[-_.]+/g, "-")
      : ecosystem === "vscode"
        ? packageName.toLowerCase()
        : packageName;
  return `${ecosystem}:${normalized}`;
}

export const DEFAULT_BADGE_TAG = "latest";

const BADGE_TAG_RE = /^[A-Za-z0-9!~*'()._-]{1,64}$/;

export function isValidBadgeTag(tag: string): boolean {
  return BADGE_TAG_RE.test(tag);
}

export function scanDistTag(summaryJson: unknown): string | null {
  if (summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)) {
    const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
    if (stagedPublish && typeof stagedPublish === "object" && !Array.isArray(stagedPublish)) {
      const tag = (stagedPublish as { tag?: unknown }).tag;
      if (typeof tag === "string" && isValidBadgeTag(tag)) return tag;
    }
  }
  return null;
}

export function badgeTagMatches(scanTag: string | null, requestedTag: string): boolean {
  if (scanTag === null) return requestedTag === DEFAULT_BADGE_TAG;
  return scanTag === requestedTag;
}

function badgeCacheKey(origin: string, packageKey: string, tag: string): Request {
  return new Request(
    `${origin}/public/badge-key/${encodeURIComponent(packageKey)}/${encodeURIComponent(tag)}`,
  );
}

function threatFeedCacheKey(origin: string): Request {
  return new Request(`${origin}/public/threat-feed.json`);
}

export function publicFeedCacheKey(origin: string, routePath: string, search = ""): Request {
  const badge = /^\/badge\/([^/]+)\/(.+)$/.exec(routePath);
  if (badge) {
    const ecosystem = badge[1] as PublicEcosystem;
    if (PUBLIC_ECOSYSTEMS.includes(ecosystem)) {
      let name = badge[2];
      try {
        name = decodeURIComponent(name);
      } catch {}
      // Keep invalid and blank tags off the warmed default-tag cache key.
      const raw = new URLSearchParams(search).get("tag")?.trim();
      return badgeCacheKey(
        origin,
        publicPackageLookupKey(ecosystem, name),
        raw ?? DEFAULT_BADGE_TAG,
      );
    }
  }
  return new Request(origin + "/public" + routePath);
}

export function resolveBadgeTag(raw: string | null | undefined): string {
  const tag = raw?.trim();
  return tag && isValidBadgeTag(tag) ? tag : DEFAULT_BADGE_TAG;
}

export function purgePublicFeedCache(
  executionCtx: ExecutionContext | null,
  origin: string,
  publicPackageKey: string | null,
  badgeTag: string | null = null,
): void {
  coloCacheDelete(executionCtx, threatFeedCacheKey(origin));
  if (publicPackageKey) {
    coloCacheDelete(
      executionCtx,
      badgeCacheKey(origin, publicPackageKey, badgeTag ?? DEFAULT_BADGE_TAG),
    );
  }
}

function provenanceEcosystem(summaryJson: unknown): PublicEcosystem | null {
  if (summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)) {
    const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
    if (stagedPublish && typeof stagedPublish === "object" && !Array.isArray(stagedPublish)) {
      const provenance = (stagedPublish as { provenance?: unknown }).provenance;
      if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) {
        const ecosystem = (provenance as { ecosystem?: unknown }).ecosystem;
        if (ecosystem === "pypi" || ecosystem === "vscode" || ecosystem === "npm") {
          return ecosystem;
        }
      }
    }
  }
  return null;
}

// A published-pair summary carries no provenance block; the mode names the
// registry the pair was resolved against. Read it only under that mode so a
// staged or gate summary can never have a stray field speak for its ecosystem.
function publishedPairEcosystem(summaryJson: unknown): PublicEcosystem | null {
  if (summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)) {
    const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
    if (stagedPublish && typeof stagedPublish === "object" && !Array.isArray(stagedPublish)) {
      const details = stagedPublish as { mode?: unknown; ecosystem?: unknown };
      if (details.mode === "published_pair") {
        const ecosystem = details.ecosystem;
        if (ecosystem === "pypi" || ecosystem === "vscode" || ecosystem === "npm") {
          return ecosystem;
        }
      }
    }
  }
  return null;
}

/**
 * Scan sources whose artifact was reached with the organization's own npm
 * token, which the registry accepted for that exact name. That acceptance is
 * the only proof in the system that the reviewing organization can publish
 * under the name, so every trust decision keyed on identity starts here.
 */
const REGISTRY_VERIFIED_SOURCES: ReadonlySet<string> = new Set(["manual", "auto_discovery"]);

/**
 * Never guess an ecosystem for a gate scan with missing provenance, and never
 * for a published-pair review either: only the staged sources may fall back to
 * npm, because npm is the sole staged ecosystem and rows predating the
 * provenance snapshot carry no other clue. Defaulting a published PyPI review
 * to npm would file it under the npm badge key for the same name.
 */
export function scanEcosystem(source: string, summaryJson: unknown): PublicEcosystem | null {
  const declared = provenanceEcosystem(summaryJson) ?? publishedPairEcosystem(summaryJson);
  if (declared) return declared;
  return REGISTRY_VERIFIED_SOURCES.has(source) ? "npm" : null;
}

type PackageIdentity = "registry-verified" | "manifest-claimed" | "public-review";

/**
 * How much the scan's source proves about the reviewer's relationship to the
 * package name. Fails closed: only the credential-backed staged sources are
 * registry-verified, so a source added later inherits the weakest identity
 * until it is classified here deliberately.
 */
function scanPackageIdentity(source: string): PackageIdentity {
  if (REGISTRY_VERIFIED_SOURCES.has(source)) return "registry-verified";
  return source === "workflow_gate" ? "manifest-claimed" : "public-review";
}

/**
 * Whether a scan may answer the global `/public/badge/:ecosystem/:package`
 * index, which is keyed by package name alone and reads as the maintainer's own
 * verdict on the release.
 *
 * A public-review scan reviews a release that is already published, needs no
 * credential to start, and establishes nothing about the reviewing
 * organization — any account can run one against any public package. Letting
 * one occupy the badge would let an attacker mint an authoritative-looking
 * approval for a package they have no relationship with, and displace the real
 * maintainer's credential-backed review. Such reviews stay shareable and
 * feed-listable, where the entry names its own identity.
 */
export function isBadgeEligibleSource(source: string): boolean {
  return scanPackageIdentity(source) !== "public-review";
}

/**
 * The `scans.source` values `isBadgeEligibleSource` rejects, for the SQL that
 * pages badge candidates. Kept beside the classifier it mirrors; a test asserts
 * the two agree across every declared scan source.
 */
export const BADGE_INELIGIBLE_SOURCES = ["published"] as const;

/**
 * The ecosystem whose badge index a scan may occupy, or null when it can never
 * occupy one. The one rule for "would the badge answer with this review?", so
 * the listing write, the cache purge, and the dashboard's embed snippet cannot
 * drift from each other or from the badge route.
 */
export function badgeEcosystem(source: string, summaryJson: unknown): PublicEcosystem | null {
  return isBadgeEligibleSource(source) ? scanEcosystem(source, summaryJson) : null;
}

// A manifest claim must not displace a registry-verified npm review, and an
// unaffiliated public review must not occupy the badge at all.
export function pickBadgeScan(rows: SharedScanRow[]): SharedScanRow | null {
  const eligible = rows.filter((row) => isBadgeEligibleSource(row.source));
  return (
    eligible.find((row) => scanPackageIdentity(row.source) === "registry-verified") ??
    eligible[0] ??
    null
  );
}

function sharedScanReleaseRisk(row: SharedScanRow): string {
  const breakdown = row.riskSummaryJson;
  if (breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)) {
    const releaseRisk = (breakdown as { releaseRisk?: unknown }).releaseRisk;
    if (typeof releaseRisk === "string" && releaseRisk) return releaseRisk;
  }
  return row.risk;
}

export interface ThreatFeedEntry {
  package: string | null;
  version: string | null;
  previousVersion: string | null;
  ecosystem: PublicEcosystem | null;
  tag: string | null;
  packageIdentity: PackageIdentity;
  releaseRisk: string;
  artifactRisk: string;
  decision: string | null;
  totalFindingCount: number;
  completedAt: string | null;
  listedAt: string | null;
  reportUrl: string;
}

export function buildThreatFeedEntry(row: SharedScanRow, origin: string): ThreatFeedEntry {
  return {
    package: row.packageName,
    version: row.stagedVersion,
    previousVersion: row.previousVersion,
    ecosystem: scanEcosystem(row.source, row.summaryJson),
    tag: scanDistTag(row.summaryJson),
    packageIdentity: scanPackageIdentity(row.source),
    releaseRisk: sharedScanReleaseRisk(row),
    artifactRisk: row.risk,
    decision: row.decision,
    totalFindingCount: row.findingCount ?? 0,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    listedAt: row.publicFeedListedAt ? row.publicFeedListedAt.toISOString() : null,
    reportUrl: `${origin}/reports/${row.publicShareToken}`,
  };
}

export interface BadgePayload {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

const BADGE_LABEL = "drydock";
const BADGE_CACHE_SECONDS = 300;
const BADGE_UNAVAILABLE_CACHE_SECONDS = 30;

const BADGE_VERSION_MAX = 64;
// Strip invisible direction controls from attacker-shaped manifest versions.
const BADGE_INVISIBLE_CHARS = /[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\u180E]/g;
// eslint-disable-next-line no-control-regex -- stripping C0/C1 is the point
const BADGE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function badgeVersion(stagedVersion: string | null): string {
  if (!stagedVersion) return "release";
  const cleaned = stagedVersion
    .replace(BADGE_INVISIBLE_CHARS, "")
    .replace(BADGE_CONTROL_CHARS, "")
    .trim();
  if (!cleaned) return "release";
  return cleaned.length > BADGE_VERSION_MAX ? `${cleaned.slice(0, BADGE_VERSION_MAX)}…` : cleaned;
}

const RISK_BADGE_COLOR: Record<string, string> = {
  low: "brightgreen",
  medium: "yellow",
  high: "red",
  critical: "red",
};

function badgeLabel(row: SharedScanRow | null, tag: string): string {
  const qualifiers = [
    ...(tag === DEFAULT_BADGE_TAG ? [] : [tag]),
    // Anything short of registry-verified says so, so a row that ever reaches
    // here without the registry's proof cannot read as the maintainer's own.
    ...(row && scanPackageIdentity(row.source) !== "registry-verified" ? ["unverified"] : []),
  ];
  return qualifiers.length > 0 ? `${BADGE_LABEL} (${qualifiers.join(", ")})` : BADGE_LABEL;
}

export function buildUnavailableBadgePayload(tag: string = DEFAULT_BADGE_TAG): BadgePayload {
  return {
    schemaVersion: 1,
    label: badgeLabel(null, tag),
    message: "unavailable",
    color: "lightgrey",
    cacheSeconds: BADGE_UNAVAILABLE_CACHE_SECONDS,
  };
}

export function buildBadgePayload(
  row: SharedScanRow | null,
  tag: string = DEFAULT_BADGE_TAG,
): BadgePayload {
  if (!row) {
    return {
      schemaVersion: 1,
      label: badgeLabel(null, tag),
      message: "not reviewed",
      color: "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (row.decision === "no_publish") {
    return {
      schemaVersion: 1,
      label: badgeLabel(row, tag),
      message: `${badgeVersion(row.stagedVersion)} blocked`,
      color: "red",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (row.decision === "publish") {
    return {
      schemaVersion: 1,
      label: badgeLabel(row, tag),
      message: `${badgeVersion(row.stagedVersion)} approved`,
      color: scanPackageIdentity(row.source) === "registry-verified" ? "brightgreen" : "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  const risk = sharedScanReleaseRisk(row);
  return {
    schemaVersion: 1,
    label: badgeLabel(row, tag),
    message: `${badgeVersion(row.stagedVersion)} reviewed · ${risk} risk`,
    color:
      scanPackageIdentity(row.source) === "registry-verified"
        ? (RISK_BADGE_COLOR[risk] ?? "lightgrey")
        : risk === "low"
          ? "lightgrey"
          : (RISK_BADGE_COLOR[risk] ?? "lightgrey"),
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
