import { isRecord } from "../../platform/guards";
import { reliableFetch } from "../../platform/reliable-fetch";
import { compareParsedSemver, parseSemver, type ParsedSemver } from "../semver";

export { compareSemver } from "../semver";

interface RegistryVersionMetadata {
  dist?: { tarball?: string };
  /**
   * Whether npm lists SLSA provenance for this version (`dist.attestations.provenance`).
   * Undefined when the registry entry had no `dist` object, or the document was
   * cached before this field was projected: both read as "unknown".
   */
  hasProvenance?: boolean;
}

export interface RegistryMetadata {
  versions?: Record<string, RegistryVersionMetadata>;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
}

type BaselineSelectionSource = "dist-tag" | "semver-predecessor" | "highest-published" | "none";

export interface BaselineVersionSelection {
  version: string | null;
  tag: string | null;
  source: BaselineSelectionSource;
  distTagVersion: string | null;
  reason: string;
}

const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function isValidNpmPackageName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 214) return false;
  return NPM_PACKAGE_NAME_RE.test(name);
}

// npm requires lowercase only when a name is first registered; legacy packages
// such as `JSONStream` keep publishing under their original mixed-case names,
// which npm treats as distinct from the lowercase spelling. Use it for names
// npm itself reported and for read-only lookups (including the claims route,
// which can only read or manage the caller's own claim), never to register or
// watch a newly typed name. The charset is deliberately narrower than npm's historical
// URL-safe set (`!'()*` are refused) so names stay inert in reports and URLs.
const NPM_LEGACY_PACKAGE_NAME_RE =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const NPM_RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);

export function isValidLegacyNpmPackageName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 214) return false;
  if (NPM_RESERVED_PACKAGE_NAMES.has(name.toLowerCase())) return false;
  return NPM_LEGACY_PACKAGE_NAME_RE.test(name);
}

// npm's abbreviated packument (the media type the npm CLI itself asks for)
// drops readmes and every per-version manifest field we do not read, which for
// a long-lived package is the difference between a multi-megabyte document and
// a small one. `application/json` stays in the Accept list so a registry that
// negotiates content answers with the full document rather than refusing; one
// that refuses anyway is caught by the retry below. Both project to the same
// shape, so callers cannot tell which arrived.
const ABBREVIATED_PACKUMENT_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

export interface FetchPackageMetadataOptions {
  npmToken?: string;
  npmRegistry?: string;
  /**
   * Ask for the abbreviated packument. Safe wherever only tarball URLs and
   * dist-tags are needed (the scan pipeline). Leave off when per-version
   * publish times are needed: `time` exists only in the full document.
   */
  abbreviated?: boolean;
}

export async function fetchPackageMetadata(
  env: Cloudflare.Env,
  name: string,
  options: FetchPackageMetadataOptions = {},
): Promise<RegistryMetadata> {
  // Read-only lookup of a name npm already serves; the name is URL-encoded below.
  if (!isValidLegacyNpmPackageName(name)) {
    throw new Error("invalid package name");
  }
  const registry = (
    options.npmRegistry ||
    env.NPM_REGISTRY ||
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const url = `${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
  const fetchWith = (accept: string) => {
    const headers = new Headers({ accept });
    if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);
    return reliableFetch(url, { headers });
  };

  let res = await fetchWith(
    options.abbreviated ? ABBREVIATED_PACKUMENT_ACCEPT : "application/json",
  );
  if (!res.ok && options.abbreviated && mayRejectVendorMediaType(res.status)) {
    // A registry that refuses the vendor media type must not silently cost the
    // scan its baseline: the broker maps a metadata failure to "no baseline",
    // which reports every file as added. Custom registries are a supported
    // deployment, so fall back to the plain document once before giving up.
    res = await fetchWith("application/json");
  }
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`);
  return projectRegistryMetadata(await res.json());
}

// Statuses a registry might answer with when it does not understand
// `application/vnd.npm.install-v1+json`. 401/403/404 are definitive answers
// about the request itself, and 5xx has already been retried by reliableFetch,
// so neither is worth a second round trip.
function mayRejectVendorMediaType(status: number): boolean {
  return status === 400 || status === 406 || status === 415 || status === 422;
}

/**
 * Narrow a registry document to the fields Drydock actually reads. Packuments
 * for popular packages are among the largest JSON documents this Worker parses
 * (tens of megabytes for a package with thousands of versions, most of it
 * readmes and duplicated per-version manifests), and holding the whole thing
 * while a scan also holds two parsed package sides is exactly the memory the
 * 128 MiB isolate does not have. Projecting right at the fetch boundary lets
 * the parsed document be collected immediately, and keeps the cached copy
 * small. `RegistryMetadata` is the whole contract — every consumer is typed
 * against it — so nothing downstream can read a field dropped here.
 */
export function projectRegistryMetadata(raw: unknown): RegistryMetadata {
  if (!raw || typeof raw !== "object") return {};
  const doc = raw as RegistryMetadata;
  const projected: RegistryMetadata = {};

  if (doc.versions && typeof doc.versions === "object") {
    const versions: Record<string, RegistryVersionMetadata> = {};
    for (const [version, entry] of Object.entries(doc.versions)) {
      const dist: unknown = entry?.dist;
      const tarball = isRecord(dist) ? dist.tarball : undefined;
      // Every published version must survive as a truthy entry: baseline
      // selection walks the key set and dist-tag resolution checks presence.
      const projectedEntry: RegistryVersionMetadata =
        typeof tarball === "string" ? { dist: { tarball } } : {};
      if (isRecord(dist)) {
        const attestations = dist.attestations;
        projectedEntry.hasProvenance = isRecord(attestations) && isRecord(attestations.provenance);
      }
      versions[version] = projectedEntry;
    }
    projected.versions = versions;
  }

  const distTags = doc["dist-tags"];
  if (distTags && typeof distTags === "object") {
    const tags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(distTags)) {
      if (typeof version === "string") tags[tag] = version;
    }
    projected["dist-tags"] = tags;
  }

  const time = doc.time;
  if (time && typeof time === "object") {
    const times: Record<string, string> = {};
    for (const [version, at] of Object.entries(time)) {
      if (typeof at === "string") times[version] = at;
    }
    projected.time = times;
  }

  return projected;
}

export function pickPreviousVersion(
  metadata: { versions?: Record<string, unknown> },
  stagedVersion: string,
) {
  return pickBaselineVersion(metadata, stagedVersion).version;
}

export function pickBaselineVersion(
  metadata: { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> },
  stagedVersion: string,
  stagedTag?: string | null,
): BaselineVersionSelection {
  const tag = stagedTag?.trim() || null;
  const versionsByName = metadata.versions || {};
  const distTagVersion = tag ? metadata["dist-tags"]?.[tag] || null : null;

  if (tag && distTagVersion && distTagVersion !== stagedVersion && versionsByName[distTagVersion]) {
    return {
      version: distTagVersion,
      tag,
      source: "dist-tag",
      distTagVersion,
      reason: `dist-tag:${tag}`,
    };
  }

  const fallback = pickSemverFallbackVersion(versionsByName, stagedVersion);
  if (fallback) {
    return {
      version: fallback.version,
      tag,
      source: fallback.source,
      distTagVersion,
      reason: fallback.reason,
    };
  }

  return {
    version: null,
    tag,
    source: "none",
    distTagVersion,
    reason: tag && distTagVersion === stagedVersion ? "dist-tag-points-at-staged-version" : "none",
  };
}

function pickSemverFallbackVersion(
  versionsByName: Record<string, unknown>,
  stagedVersion: string,
): { version: string; source: "semver-predecessor" | "highest-published"; reason: string } | null {
  const candidates: { version: string; parsed: ParsedSemver }[] = [];
  for (const version of Object.keys(versionsByName)) {
    if (version === stagedVersion) continue;
    const parsed = parseSemver(version);
    if (parsed) candidates.push({ version, parsed });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => compareParsedSemver(a.parsed, b.parsed));

  const staged = parseSemver(stagedVersion);
  if (staged) {
    const predecessors = candidates.filter((c) => compareParsedSemver(c.parsed, staged) < 0);
    const previous = predecessors.at(-1);
    if (previous) {
      return {
        version: previous.version,
        source: "semver-predecessor",
        reason: "semver-predecessor",
      };
    }
  }

  return {
    version: candidates.at(-1)!.version,
    source: "highest-published",
    reason: "highest-published-fallback",
  };
}
