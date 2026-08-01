import { reliableFetch } from "../../platform/reliable-fetch";

export interface RegistryMetadata {
  versions?: Record<string, { dist?: { tarball?: string } }>;
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

// npm's abbreviated packument (the media type the npm CLI itself asks for)
// drops readmes and every per-version manifest field we do not read, which for
// a long-lived package is the difference between a multi-megabyte document and
// a small one. `application/json` stays in the Accept list so a registry that
// does not implement the abbreviated form answers with the full document
// instead of 406 — both project to the same shape below.
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
  if (!isValidNpmPackageName(name)) {
    throw new Error("invalid package name");
  }
  const registry = (
    options.npmRegistry ||
    env.NPM_REGISTRY ||
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const headers = new Headers({
    accept: options.abbreviated ? ABBREVIATED_PACKUMENT_ACCEPT : "application/json",
  });
  if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);
  const res = await reliableFetch(`${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`, {
    headers,
  });
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`);
  return projectRegistryMetadata(await res.json());
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
    const versions: Record<string, { dist?: { tarball?: string } }> = {};
    for (const [version, entry] of Object.entries(doc.versions)) {
      const tarball = entry?.dist?.tarball;
      // Every published version must survive as a truthy entry: baseline
      // selection walks the key set and dist-tag resolution checks presence.
      versions[version] = typeof tarball === "string" ? { dist: { tarball } } : {};
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

export function compareSemver(a: string, b: string) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareParsedSemver(pa, pb);
  return a.localeCompare(b);
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

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareParsedSemver(a: ParsedSemver, b: ParsedSemver) {
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = a[key] - b[key];
    if (diff) return diff;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) {
      const diff = leftNumber - rightNumber;
      if (diff) return diff;
    } else if (leftNumber !== null) {
      return -1;
    } else if (rightNumber !== null) {
      return 1;
    } else {
      const diff = left.localeCompare(right);
      if (diff) return diff;
    }
  }
  return 0;
}
