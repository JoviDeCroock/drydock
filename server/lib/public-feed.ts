import type { SharedScanRow } from "../db/scan-share";
import { coloCacheDelete } from "./platform/colo-cache";

// Shaping helpers for the two discoverable public surfaces: the shields.io
// badge endpoint and the threat feed. Both are name-discoverable indexes, so
// both only ever reflect scans whose org explicitly opted into feed listing
// on top of sharing — a privately shared link never appears in either.

export const THREAT_FEED_SCHEMA = "drydock.threat-feed.v1";

export const PUBLIC_ECOSYSTEMS = ["npm", "pypi", "vscode"] as const;
export type PublicEcosystem = (typeof PUBLIC_ECOSYSTEMS)[number];

const PUBLIC_PACKAGE_NAME_MAX: Record<PublicEcosystem, number> = {
  npm: 214,
  pypi: 214,
  // publisher (128) + "." + extension name (128).
  vscode: 257,
};

export function publicPackageNameMax(ecosystem: PublicEcosystem): number {
  return PUBLIC_PACKAGE_NAME_MAX[ecosystem];
}

/**
 * Canonical lookup key for a package name, per that ecosystem's own identity
 * rules. The ecosystem prefix makes a cross-ecosystem collision impossible.
 *
 * npm is deliberately *not* case-folded, unlike the other two. Its registry
 * treats names case-sensitively for existing packages — `JSONStream` and
 * `jsonstream` are different packages — so folding would merge two real
 * packages onto one badge. PyPI folds per PEP 503 and the VS Code marketplace
 * treats extension ids case-insensitively, so for those, *not* folding would
 * fragment one package across several keys.
 */
export function publicPackageLookupKey(ecosystem: PublicEcosystem, packageName: string): string {
  const normalized =
    ecosystem === "pypi"
      ? packageName.toLowerCase().replace(/[-_.]+/g, "-")
      : ecosystem === "vscode"
        ? packageName.toLowerCase()
        : packageName;
  return `${ecosystem}:${normalized}`;
}

// Colo-cache keys for the two cacheable public surfaces. These live here, next
// to `publicPackageLookupKey`, rather than in a route module: the write side
// (the badge/feed GETs) and the purge side (the dashboard's share and listing
// mutations) are different routes, and a route importing another route is how
// the two drifted onto different origins in the first place.
function badgeCacheKey(origin: string, packageKey: string): Request {
  return new Request(`${origin}/public/badge-key/${encodeURIComponent(packageKey)}`);
}

function threatFeedCacheKey(origin: string): Request {
  return new Request(`${origin}/public/threat-feed.json`);
}

/**
 * Colo-cache key for a cacheable public path. Badge paths collapse to their
 * canonical package key, so every encoding of one package shares one entry and
 * `purgePublicFeedCache` can delete it by key after a revoke or unlist.
 */
export function publicFeedCacheKey(origin: string, routePath: string): Request {
  const badge = /^\/badge\/([^/]+)\/(.+)$/.exec(routePath);
  if (badge) {
    const ecosystem = badge[1] as PublicEcosystem;
    if (PUBLIC_ECOSYSTEMS.includes(ecosystem)) {
      let name = badge[2];
      try {
        name = decodeURIComponent(name);
      } catch {
        // Undecodable name: fall through and key on the raw path.
      }
      return badgeCacheKey(origin, publicPackageLookupKey(ecosystem, name));
    }
  }
  return new Request(origin + "/public" + routePath);
}

/**
 * Drop the colo-cached badge and threat feed after a share is revoked or a
 * listing is turned off, so the withdrawal is not delayed by the TTL.
 *
 * **This is colo-local.** It clears the entries in the colo that served the
 * revoking admin's request and nowhere else; every other region keeps serving
 * the withdrawn badge until `max-age` expires, and shields.io's own cache
 * (≥300s) sits in front of that. Revocation of the *report* is immediate —
 * `no-store` plus a D1 lookup on every request. These two derived surfaces are
 * eventually consistent by construction, which is why their TTLs are short.
 */
export function purgePublicFeedCache(
  executionCtx: ExecutionContext | null,
  origin: string,
  publicPackageKey: string | null,
): void {
  coloCacheDelete(executionCtx, threatFeedCacheKey(origin));
  if (publicPackageKey) coloCacheDelete(executionCtx, badgeCacheKey(origin, publicPackageKey));
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

/**
 * The reviewed ecosystem, or null when it cannot be established.
 *
 * It lives in the persisted adapter snapshot
 * (`summaryJson.stagedPublish.provenance.ecosystem`) for workflow-gate scans.
 * Staged-publish scans carry no snapshot and are npm by construction — only npm
 * has a staged adapter.
 *
 * A gate scan whose snapshot is missing or malformed (a legacy pre-provenance
 * record, or a redaction that failed) resolves to null rather than falling back
 * to npm. Defaulting is what turns "we don't know" into a claim: a PyPI or VS
 * Code release would take the npm badge for its own name, in the one ecosystem
 * where a real registry-verified review exists to be displaced. Null means the
 * scan can still be feed-listed — it just isn't badge-discoverable.
 */
export function scanEcosystem(source: string, summaryJson: unknown): PublicEcosystem | null {
  return provenanceEcosystem(summaryJson) ?? (source === "workflow_gate" ? null : "npm");
}

// How trustworthy the package-name claim is. Staged-publish scans fetched the
// artifact from the registry with the org's npm token, so the registry proved
// the org can publish under that name. Workflow-gate scans review a repo-built
// artifact whose manifest claims the name — nothing verifies ownership yet, so
// consumers must be able to discount those claims.
type PackageIdentity = "registry-verified" | "manifest-claimed";

function scanPackageIdentity(source: string): PackageIdentity {
  return source === "workflow_gate" ? "manifest-claimed" : "registry-verified";
}

/**
 * Pick the badge's scan among the (already listed + ecosystem-scoped)
 * candidates: the newest registry-verified review wins over any
 * manifest-claimed one, so on npm a workflow-gate scan claiming someone else's
 * name cannot displace the real maintainer's staged review.
 *
 * That preference is only a *tiebreak*, and it does not generalize: only npm has
 * a staged adapter, so every PyPI and VS Code scan is a workflow gate and is
 * therefore always `manifest-claimed`. There is never a registry-verified row to
 * prefer. `buildBadgePayload` is what closes the gap — a manifest-claimed pick
 * is labelled as unverified rather than presented as a plain review.
 */
export function pickBadgeScan(rows: SharedScanRow[]): SharedScanRow | null {
  return (
    rows.find((row) => scanPackageIdentity(row.source) === "registry-verified") ?? rows[0] ?? null
  );
}

/** The release-scoped risk when persisted, falling back to the artifact risk. */
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
  // Null when a gate scan's provenance snapshot never established one — the
  // feed says "unknown" rather than guessing on a partner's behalf.
  ecosystem: PublicEcosystem | null;
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
    ecosystem: scanEcosystem(row.source, row.summaryJson),
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
// Short, because this payload is a statement about Drydock's availability, not
// about the package. shields enforces a 300s floor of its own, so it cannot be
// honoured exactly — but nothing here should ask to be remembered.
const BADGE_UNAVAILABLE_CACHE_SECONDS = 30;

// Version strings originate in package manifests (attacker-shaped for gate
// scans); clamp so a hostile version can't balloon the badge message.
const BADGE_VERSION_MAX = 64;
// Zero-width and bidirectional-override code points. The badge is rendered into
// SVG text by shields, so an RLO in a version string reverses the visible run
// and can make the message read as something it does not say. Same set the tar
// parser strips from entry names, and the same reasoning.
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

/**
 * A badge is read as an assertion about a package name, by people who will never
 * open the report behind it. Only a registry-verified review proves the
 * publisher controls that name; a workflow-gate review proves only that some
 * organization built an artifact whose manifest claims it. Anyone can do the
 * latter for any name, and for PyPI and VS Code it is the *only* kind of review
 * that exists — so the distinction has to be visible on the badge, not just in
 * the feed entry that a badge viewer never sees.
 */
function badgeLabel(row: SharedScanRow): string {
  return scanPackageIdentity(row.source) === "registry-verified"
    ? BADGE_LABEL
    : `${BADGE_LABEL} (unverified)`;
}

/**
 * The badge for "Drydock could not answer" — throttling, mostly.
 *
 * This must never be `buildBadgePayload(null)`. That payload asserts *nobody
 * reviewed this package*, and shields would cache the assertion for at least
 * five minutes. Every Drydock badge in the world reaches us through a handful
 * of shields egress addresses against a per-IP limiter with no per-package
 * dimension, so an unrelated burst can throttle the request for a package
 * whose review says `blocked` — and every README rendering that badge would
 * quietly show neutral grey instead. "We don't know" and "nobody reviewed
 * this" have to be distinguishable.
 */
export function buildUnavailableBadgePayload(): BadgePayload {
  return {
    schemaVersion: 1,
    label: BADGE_LABEL,
    message: "unavailable",
    color: "lightgrey",
    cacheSeconds: BADGE_UNAVAILABLE_CACHE_SECONDS,
  };
}

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
      label: badgeLabel(row),
      message: `${badgeVersion(row.stagedVersion)} blocked`,
      color: "red",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  const risk = sharedScanReleaseRisk(row);
  return {
    schemaVersion: 1,
    label: badgeLabel(row),
    message: `${badgeVersion(row.stagedVersion)} reviewed · ${risk} risk`,
    // An unverified claim never renders as a clean green pass: the color is the
    // only thing most readers take from a badge.
    color:
      scanPackageIdentity(row.source) === "registry-verified"
        ? (RISK_BADGE_COLOR[risk] ?? "lightgrey")
        : risk === "low"
          ? "lightgrey"
          : (RISK_BADGE_COLOR[risk] ?? "lightgrey"),
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
