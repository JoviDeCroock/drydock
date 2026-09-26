import type { scans } from "../db/schema";
import { parseStagedArtifactIntegrity } from "./ecosystems/artifact-integrity";
import { coloCacheDelete } from "./platform/colo-cache";

export const THREAT_FEED_SCHEMA = "drydock.threat-feed.v1";

/**
 * The scan columns a public surface (feed entry, badge) is built from.
 * `registryVersion`, `organizationId`, `registryPackageName` and `registryUrl`
 * are internal only: they order and bind releases, and are never serialized
 * into a public feed entry or badge. `registryVersion` is the registry's own
 * version string, never the manifest's.
 */
export type SharedScanRow = Pick<
  typeof scans.$inferSelect,
  | "registryVersion"
  | "organizationId"
  | "registryPackageName"
  | "registryUrl"
  | "source"
  | "packageName"
  | "stagedVersion"
  | "previousVersion"
  | "risk"
  | "decision"
  | "findingCount"
  | "riskSummaryJson"
  | "summaryJson"
  | "publicShareToken"
  | "publicFeedListedAt"
  | "completedAt"
> & { scanId: string };

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
 * token: npm let that token read this exact stage, under npm's own name for
 * it. That is the only credential-backed tie in the system between the
 * reviewing organization and a package name, so every trust decision keyed on
 * identity starts here. It is read access, not publish rights — a read-only
 * token passes — and it covers npm's name, never the manifest's (see
 * `scanPublicPackageName`).
 */
export const REGISTRY_VERIFIED_SCAN_SOURCES = ["manual", "auto_discovery"] as const;
const REGISTRY_VERIFIED_SOURCES: ReadonlySet<string> = new Set(REGISTRY_VERIFIED_SCAN_SOURCES);

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
 * The registry whose names the public `npm` badge and feed speak for. Stored
 * registry URLs are normalized (`normalizeRegistryUrl`: lowercase host, no
 * trailing slash, no default port), so this is an exact comparison, and the
 * SQL twins compare against the same two strings.
 */
export const PUBLIC_NPM_REGISTRY_URLS = [
  "https://registry.npmjs.org",
  "https://registry.npmjs.org/",
] as const;

function isPublicNpmRegistryUrl(registryUrl: string | null): boolean {
  return (PUBLIC_NPM_REGISTRY_URLS as readonly string[]).includes(registryUrl ?? "");
}

/**
 * What one scan proves about the name it carries — the identity every
 * anonymous surface renders. A credential-backed *source* earns
 * `registry-verified` only while the scan has a public name
 * (`scanPublicPackageName`): a stage on the public npm registry whose manifest
 * agrees with npm's name for it. Otherwise the name on the entry is only what
 * the manifest claims, and the entry says so — the same tier as a workflow
 * gate — so a decision is never presented as verified for a name no
 * credential reached.
 */
function scanIdentity(row: {
  source: string;
  packageName: string | null;
  registryPackageName: string | null;
  registryUrl: string | null;
}): PackageIdentity {
  const identity = scanPackageIdentity(row.source);
  if (identity !== "registry-verified") return identity;
  return scanPublicPackageName(row) ? "registry-verified" : "manifest-claimed";
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

/**
 * The name a scan may be publicly identified by on the name-keyed badge index,
 * or null when it has none.
 *
 * `package_name` is the *reviewed tarball's* manifest, which is package bytes:
 * a stage the organization's token can read may carry a manifest naming any
 * package at all. What the credential establishes is npm's name for the stage
 * (`registry_package_name`, taken from npm's stage record, never the
 * manifest). So a credential-backed scan is identified by npm's name, and only
 * while the manifest agrees with it; a scan whose bytes claim another name has
 * no public identity at all. npm resolves package names exactly — no case
 * folding or other normalization — so agreement is plain equality.
 *
 * And only on the public npm registry. An organization may point its npm
 * connection at any https registry, including one it runs itself, so a stage
 * record from anywhere else proves nothing about a name on the public
 * registry the `npm` badge and feed speak for.
 *
 * Only a manifest-claimed source answers under its own manifest name, which is
 * exactly the claim it makes and why it renders `unverified`. Every other
 * source must agree with npm, so a source added later has no identity until
 * it is classified deliberately.
 */
export function scanPublicPackageName(row: {
  source: string;
  packageName: string | null;
  registryPackageName: string | null;
  registryUrl: string | null;
}): string | null {
  if (!row.packageName) return null;
  const identity = scanPackageIdentity(row.source);
  if (identity === "manifest-claimed") return row.packageName;
  if (identity !== "registry-verified" || !isPublicNpmRegistryUrl(row.registryUrl)) return null;
  return row.registryPackageName === row.packageName ? row.registryPackageName : null;
}

/**
 * The badge cache key a row occupies, or null when it can never occupy one —
 * no public name (see `scanPublicPackageName`), a source that may not answer
 * the name-keyed badge index, or a scan whose ecosystem was never established.
 * The one rule for "which badge would this row answer", so the listing write
 * and the cache purge cannot drift from each other or from the badge route.
 */
export function badgeLookupKey(row: {
  source: string;
  packageName: string | null;
  registryPackageName: string | null;
  registryUrl: string | null;
  summaryJson: unknown;
}): string | null {
  const name = scanPublicPackageName(row);
  if (!name) return null;
  const ecosystem = badgeEcosystem(row.source, row.summaryJson);
  return ecosystem ? publicPackageLookupKey(ecosystem, name) : null;
}

/**
 * The release line a scan belongs to, persisted as `badge_package_key` for
 * every badge-eligible scan whether or not it may answer the badge. It is what
 * lets a badge notice that the package released again, and it is never an
 * admission signal: a row answers only through `public_package_key` (listed)
 * or `badge_public` (default-on), and both require a public name.
 *
 * For a credential-backed scan the line is npm's name for the stage, even when
 * the manifest disagrees with it: that release is still one npm published
 * under the name, and a badge must go grey beside it rather than keep vouching
 * for the older version. The manifest's name never places a staged scan on a
 * line, and neither does a stage from any registry but public npm — a private
 * registry's package of the same name is a different package. A gate review's
 * line is the name it claims, as its identity is.
 */
export function badgeReleaseLineKey(row: {
  source: string;
  packageName: string | null;
  registryPackageName: string | null;
  registryUrl: string | null;
  summaryJson: unknown;
}): string | null {
  if (scanPackageIdentity(row.source) !== "registry-verified") return badgeLookupKey(row);
  if (!row.registryPackageName || !isPublicNpmRegistryUrl(row.registryUrl)) return null;
  const ecosystem = badgeEcosystem(row.source, row.summaryJson);
  return ecosystem ? publicPackageLookupKey(ecosystem, row.registryPackageName) : null;
}

/**
 * The SHA-1 of the bytes this staged review read, when the scan proved they
 * are the bytes npm recorded for the stage (`artifactIntegrity` verified:
 * npm's declared digest and the digest computed from the download agree).
 * Null for anything less — a legacy scan, an unverified or mismatched stage.
 * It is what a published tarball's bytes can be compared with.
 */
export function verifiedStagedDigest(summaryJson: unknown): string | null {
  if (summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)) {
    const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
    if (stagedPublish && typeof stagedPublish === "object" && !Array.isArray(stagedPublish)) {
      const integrity = parseStagedArtifactIntegrity(
        (stagedPublish as { artifactIntegrity?: unknown }).artifactIntegrity,
      );
      if (integrity?.status === "verified") return integrity.computed;
    }
  }
  return null;
}

/** npm's own access level for the stage, from its staged-publish record. */
function stagedPublishAccess(summaryJson: unknown): string | null {
  if (summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)) {
    const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
    if (stagedPublish && typeof stagedPublish === "object" && !Array.isArray(stagedPublish)) {
      const access = (stagedPublish as { access?: unknown }).access;
      if (typeof access === "string") return access;
    }
  }
  return null;
}

/**
 * Whether this review may answer the badge with **no opt-in at all**.
 *
 * The badge is name-keyed and anonymous, so default-on is only safe where
 * being public is provable rather than assumed. Four things must hold, and
 * every one of them fails closed:
 *
 * - **Registry-verified source, under npm's name.** npm let the
 *   organization's own token read this exact stage, and the reviewed manifest
 *   agrees with npm's name for it (`scanPublicPackageName`). A manifest claim
 *   is not enough: anyone can build a tarball calling itself `react`, and
 *   without this they could mint an approval for a name they have no claim on.
 * - **The public npm registry.** Any other host says nothing about publicness.
 * - **npm's own `access`.** The staged-publish record npm returns says whether
 *   the stage is `public` or `restricted`. This is the registry's answer, from
 *   the same response as the stage id and shasum — not `publishConfig` out of
 *   the tarball, which is package bytes and may not be trusted here.
 * - **A verified digest of the reviewed bytes** (`verifiedStagedDigest`).
 *   Without one, nothing can notice npm serving other bytes under the approved
 *   version, and an unattended green badge must be able to.
 *
 * Reading npm rather than the name shape matters: "unscoped therefore public"
 * is a true inference but a narrow one, and it silently excludes every scoped
 * package that is published publicly. The registry already answers the
 * question directly, and `publication-auto-enrollment.ts` gates on the same
 * field for the same reason.
 *
 * This is about the *package*; whether a given release is public is a separate
 * question the badge answers with npm's own version status.
 */
export function isDefaultBadgePublic(row: {
  source: string;
  packageName: string | null;
  registryPackageName: string | null;
  registryUrl: string | null;
  summaryJson: unknown;
}): boolean {
  if (!REGISTRY_VERIFIED_SOURCES.has(row.source)) return false;
  if (scanEcosystem(row.source, row.summaryJson) !== "npm") return false;
  // Also requires the public npm registry: any other host — a mirror, a
  // proxy, an enterprise registry — says nothing about publicness.
  if (!scanPublicPackageName(row)?.trim()) return false;
  if (stagedPublishAccess(row.summaryJson) !== "public") return false;
  // A badge that answers with no opt-in must be able to notice when npm
  // serves other bytes under the version it approves, which takes a digest
  // of the reviewed bytes to compare against (`findPublicationDiscrepancy`).
  return verifiedStagedDigest(row.summaryJson) !== null;
}

// A manifest claim must not displace a registry-verified npm review, and an
// unaffiliated public review must not occupy the badge at all.
export function pickBadgeScan(rows: SharedScanRow[]): SharedScanRow | null {
  const eligible = rows.filter((row) => isBadgeEligibleSource(row.source));
  return eligible.find((row) => scanIdentity(row) === "registry-verified") ?? eligible[0] ?? null;
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
    packageIdentity: scanIdentity(row),
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
    ...(row && scanIdentity(row) !== "registry-verified" ? ["unverified"] : []),
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

/**
 * `supersededBy` is the version of a newer published release on this line that
 * has no listed review (see `findNewerPublishedRelease`). The badge then
 * answers about *that* version rather than the older one it holds a review
 * for: a consumer reads the badge next to an install command, and a green
 * "3.0.0 approved" beside a registry serving 3.0.1 vouches for bytes nobody
 * installs. It also closes the obvious way to game the badge — list the
 * releases that reviewed well, quietly skip the ones that did not.
 *
 * "not reviewed" is the same claim this badge already makes for a package with
 * no listed review at all: nothing is public, not that nobody looked. The
 * newer release's own decision is never consulted or disclosed.
 */
export function buildBadgePayload(
  row: SharedScanRow | null,
  tag: string = DEFAULT_BADGE_TAG,
  supersededBy: string | null = null,
): BadgePayload {
  // The registry's own version wherever there is one. `stagedVersion` is
  // replaced with the *inspected tarball's* manifest after a scan, so it is
  // reviewed package bytes: sanitized by `badgeVersion`, but still an
  // attacker-authored string on an anonymous surface, and not a version npm
  // ever confirmed. Only a review with no registry answer at all — a gate
  // review, which already renders `unverified` — falls back to it.
  const version = badgeVersion(row?.registryVersion ?? row?.stagedVersion ?? null);
  if (!row) {
    return {
      schemaVersion: 1,
      label: badgeLabel(null, tag),
      message: "not reviewed",
      color: "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (supersededBy) {
    return {
      schemaVersion: 1,
      // The pick no longer speaks for the line, so its identity qualifier
      // would describe a review this badge is not reporting.
      label: badgeLabel(null, tag),
      message: `${badgeVersion(supersededBy)} not reviewed`,
      color: "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (row.decision === "no_publish") {
    return {
      schemaVersion: 1,
      label: badgeLabel(row, tag),
      message: `${version} blocked`,
      color: "red",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  if (row.decision === "publish") {
    return {
      schemaVersion: 1,
      label: badgeLabel(row, tag),
      message: `${version} approved`,
      color: scanIdentity(row) === "registry-verified" ? "brightgreen" : "lightgrey",
      cacheSeconds: BADGE_CACHE_SECONDS,
    };
  }
  const risk = sharedScanReleaseRisk(row);
  return {
    schemaVersion: 1,
    label: badgeLabel(row, tag),
    message: `${version} reviewed · ${risk} risk`,
    color:
      scanIdentity(row) === "registry-verified"
        ? (RISK_BADGE_COLOR[risk] ?? "lightgrey")
        : risk === "low"
          ? "lightgrey"
          : (RISK_BADGE_COLOR[risk] ?? "lightgrey"),
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
