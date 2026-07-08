import type { SharedScanRow } from "../db/scan-share";

// Shaping helpers for the two discoverable public surfaces: the shields.io
// badge endpoint and the threat feed. Both are name-discoverable indexes, so
// both only ever reflect scans whose org explicitly opted into feed listing
// on top of sharing — a privately shared link never appears in either.

export const THREAT_FEED_SCHEMA = "drydock.threat-feed.v1";

export const PUBLIC_ECOSYSTEMS = ["npm", "pypi", "vscode"] as const;
export type PublicEcosystem = (typeof PUBLIC_ECOSYSTEMS)[number];

/**
 * The reviewed ecosystem lives in the persisted adapter snapshot
 * (`summaryJson.stagedPublish.provenance.ecosystem`) for workflow-gate scans;
 * staged-publish scans are npm by construction.
 */
export function scanEcosystem(summaryJson: unknown): PublicEcosystem {
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
  return "npm";
}

// How trustworthy the package-name claim is. Staged-publish scans fetched the
// artifact from the registry with the org's npm token, so the registry proved
// the org can publish under that name. Workflow-gate scans review a repo-built
// artifact whose manifest claims the name — nothing verifies ownership yet, so
// consumers must be able to discount those claims.
export type PackageIdentity = "registry-verified" | "manifest-claimed";

export function scanPackageIdentity(source: string): PackageIdentity {
  return source === "workflow_gate" ? "manifest-claimed" : "registry-verified";
}

/**
 * Pick the badge's scan among the (already listed + ecosystem-scoped)
 * candidates: the newest registry-verified review wins over any
 * manifest-claimed one, so a workflow-gate scan claiming someone else's npm
 * name can never override the real maintainer's badge.
 */
export function pickBadgeScan(rows: SharedScanRow[]): SharedScanRow | null {
  return (
    rows.find((row) => scanPackageIdentity(row.source) === "registry-verified") ?? rows[0] ?? null
  );
}

/** The release-scoped risk when persisted, falling back to the artifact risk. */
export function sharedScanReleaseRisk(row: SharedScanRow): string {
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
  ecosystem: PublicEcosystem;
  packageIdentity: PackageIdentity;
  releaseRisk: string;
  artifactRisk: string;
  decision: string | null;
  findingCount: number;
  completedAt: string | null;
  listedAt: string | null;
  reportUrl: string;
}

export function buildThreatFeedEntry(row: SharedScanRow, origin: string): ThreatFeedEntry {
  return {
    package: row.packageName,
    version: row.stagedVersion,
    previousVersion: row.previousVersion,
    ecosystem: scanEcosystem(row.summaryJson),
    packageIdentity: scanPackageIdentity(row.source),
    releaseRisk: sharedScanReleaseRisk(row),
    artifactRisk: row.risk,
    decision: row.decision,
    findingCount: row.findingCount ?? 0,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    listedAt: row.publicFeedListedAt ? row.publicFeedListedAt.toISOString() : null,
    reportUrl: `${origin}/reports/${row.publicShareToken}`,
  };
}

// shields.io endpoint-badge schema:
// https://shields.io/badges/endpoint-badge
export interface BadgePayload {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

const BADGE_LABEL = "drydock";
const BADGE_CACHE_SECONDS = 300;

// Version strings originate in package manifests (attacker-shaped for gate
// scans); clamp so a hostile version can't balloon the badge message.
const BADGE_VERSION_MAX = 64;

function badgeVersion(stagedVersion: string | null): string {
  if (!stagedVersion) return "release";
  return stagedVersion.length > BADGE_VERSION_MAX
    ? `${stagedVersion.slice(0, BADGE_VERSION_MAX)}…`
    : stagedVersion;
}

const RISK_BADGE_COLOR: Record<string, string> = {
  low: "brightgreen",
  medium: "yellow",
  high: "red",
  critical: "red",
};

export function buildBadgePayload(row: SharedScanRow | null): BadgePayload {
  if (!row) {
    return {
      schemaVersion: 1,
      label: BADGE_LABEL,
      message: "not reviewed",
      color: "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (row.decision === "no_publish") {
    return {
      schemaVersion: 1,
      label: BADGE_LABEL,
      message: `${badgeVersion(row.stagedVersion)} blocked`,
      color: "red",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  const risk = sharedScanReleaseRisk(row);
  return {
    schemaVersion: 1,
    label: BADGE_LABEL,
    message: `${badgeVersion(row.stagedVersion)} reviewed · ${risk} risk`,
    color: RISK_BADGE_COLOR[risk] ?? "lightgrey",
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
