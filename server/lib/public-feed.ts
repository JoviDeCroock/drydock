import type { SharedScanRow } from "../db/scan-share";
import { coloCacheDelete } from "./platform/colo-cache";
import { isRecord } from "./platform/guards";

export const THREAT_FEED_SCHEMA = "drydock.threat-feed.v1";

export const PUBLIC_ECOSYSTEMS = ["npm", "pypi", "vscode", "browser"] as const;
export type PublicEcosystem = (typeof PUBLIC_ECOSYSTEMS)[number];

const PUBLIC_PACKAGE_NAME_MAX: Record<PublicEcosystem, number> = {
  npm: 214,
  pypi: 214,
  vscode: 257,
  browser: 255,
};

export function publicPackageNameMax(ecosystem: PublicEcosystem): number {
  return PUBLIC_PACKAGE_NAME_MAX[ecosystem];
}

export function publicPackageLookupKey(ecosystem: PublicEcosystem, packageName: string): string {
  const normalized =
    ecosystem === "pypi"
      ? packageName.toLowerCase().replace(/[-_.]+/g, "-")
      : ecosystem === "vscode" || ecosystem === "browser"
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
  if (isRecord(summaryJson)) {
    const stagedPublish = summaryJson.stagedPublish;
    if (isRecord(stagedPublish)) {
      const tag = stagedPublish.tag;
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
  if (isRecord(summaryJson)) {
    const stagedPublish = summaryJson.stagedPublish;
    if (isRecord(stagedPublish)) {
      const provenance = stagedPublish.provenance;
      if (isRecord(provenance)) {
        const ecosystem = provenance.ecosystem;
        if (isPublicEcosystem(ecosystem)) return ecosystem;
      }
    }
  }
  return null;
}

function isPublicEcosystem(value: unknown): value is PublicEcosystem {
  return typeof value === "string" && (PUBLIC_ECOSYSTEMS as readonly string[]).includes(value);
}

// Never guess an ecosystem for a gate scan with missing provenance.
export function scanEcosystem(source: string, summaryJson: unknown): PublicEcosystem | null {
  return provenanceEcosystem(summaryJson) ?? (source === "workflow_gate" ? null : "npm");
}

export function scanPublicPackageIdentity(
  source: string,
  summaryJson: unknown,
  packageName: string | null,
): string | null {
  if (!packageName || source !== "workflow_gate") return packageName;
  if (!isRecord(summaryJson)) return packageName;
  const stagedPublish = summaryJson.stagedPublish;
  if (!isRecord(stagedPublish)) return packageName;
  if (!("publicPackageIdentity" in stagedPublish)) return packageName;
  const identity = stagedPublish.publicPackageIdentity;
  return typeof identity === "string" && identity.trim() ? identity : null;
}

type PackageIdentity = "registry-verified" | "manifest-claimed";

function scanPackageIdentity(source: string): PackageIdentity {
  return source === "workflow_gate" ? "manifest-claimed" : "registry-verified";
}

// A manifest claim must not displace a registry-verified npm review.
export function pickBadgeScan(rows: SharedScanRow[]): SharedScanRow | null {
  return (
    rows.find((row) => scanPackageIdentity(row.source) === "registry-verified") ?? rows[0] ?? null
  );
}

function sharedScanReleaseRisk(row: SharedScanRow): string {
  const breakdown = row.riskSummaryJson;
  if (isRecord(breakdown)) {
    const releaseRisk = breakdown.releaseRisk;
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
    ...(row && scanPackageIdentity(row.source) === "manifest-claimed" ? ["unverified"] : []),
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
