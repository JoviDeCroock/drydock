export interface RegistryMetadata {
  versions?: Record<string, { dist?: { tarball?: string } }>;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
}

export type BaselineSelectionSource =
  | "dist-tag"
  | "semver-predecessor"
  | "highest-published"
  | "none";

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

export async function fetchPackageMetadata(
  env: Cloudflare.Env,
  name: string,
  options: { npmToken?: string; npmRegistry?: string } = {},
): Promise<RegistryMetadata> {
  if (!isValidNpmPackageName(name)) {
    throw new Error("invalid package name");
  }
  const registry = (
    options.npmRegistry ||
    env.NPM_REGISTRY ||
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const headers = new Headers({ accept: "application/json" });
  if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);
  const res = await fetch(`${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`, {
    headers,
  });
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`);
  return (await res.json()) as RegistryMetadata;
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
  const candidates = Object.keys(versionsByName).filter(
    (version) => version !== stagedVersion && parseSemver(version),
  );
  if (!candidates.length) return null;
  candidates.sort(compareSemver);

  const staged = parseSemver(stagedVersion);
  if (staged) {
    const predecessors = candidates.filter((version) => compareSemver(version, stagedVersion) < 0);
    const previous = predecessors.at(-1);
    if (previous) {
      return {
        version: previous,
        source: "semver-predecessor",
        reason: "semver-predecessor",
      };
    }
  }

  return {
    version: candidates.at(-1)!,
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
