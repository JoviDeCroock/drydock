import { batch, createModel, signal } from "@preact/signals";
import type {
  DiffEntry,
  FileRecord,
  Finding,
  FindingDiffAnnotation,
  PackageJsonDiff,
  PackageJsonSummary,
} from "../../server/lib/review";
import type { ScanRiskBreakdown } from "../../server/lib/review/risk";
import { packageDiffPath, type DiffEcosystem } from "../lib/package-diff-path";
import { apiFetch, errorMessage } from "./api";

export interface PublicDiffVersionsResponse {
  ecosystem: DiffEcosystem;
  packageName: string;
  versions: Array<{ version: string; distTags: string[]; publishedAt?: string }>;
  suggested: { from: string; to: string } | null;
}

export interface PublicDiffResponse {
  ecosystem: DiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  fromPackageJson: PackageJsonSummary | null;
  toPackageJson: PackageJsonSummary | null;
  diff: DiffEntry[];
  packageJsonDiff: PackageJsonDiff;
  findings: Array<Finding & FindingDiffAnnotation>;
  risk: ScanRiskBreakdown;
  textSamplesOmitted: boolean;
  // Coverage caveats (e.g. an artifact kind omitted because it exceeded a
  // sandbox cap); rendered as a banner above the diff.
  notices: string[];
  cachedAt: string;
}

export interface PublicDiffFileResponse {
  path: string;
  before: FileRecord | null;
  after: FileRecord | null;
  textSamplesOmitted: boolean;
}

// Short-lived per-package cache: the package-only /diff/<name> route fetches
// versions to resolve a pair and then redirects to the full-spec page, whose
// model fetches versions again — without the cache every added-dependency
// "view diff" click charges the anonymous IP rate limit twice for the same
// payload. Only fully diffable responses (a suggested pair) are cached: a
// "needs two versions" or failed response is evicted so a retry after the
// package publishes its second version hits the network instead of replaying
// the stale answer for the whole TTL.
interface VersionsCacheEntry {
  at: number;
  value: Promise<PublicDiffVersionsResponse>;
}
const versionsCache = new Map<string, VersionsCacheEntry>();
const VERSIONS_CACHE_TTL_MS = 60_000;

export function getPublicDiffVersions(
  ecosystem: DiffEcosystem,
  packageName: string,
): Promise<PublicDiffVersionsResponse> {
  const cacheKey = `${ecosystem}:${packageName}`;
  const cached = versionsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VERSIONS_CACHE_TTL_MS) return cached.value;
  const value: Promise<PublicDiffVersionsResponse> = apiFetch(
    `/api/public/v1/package-diff/versions?package=${encodeURIComponent(packageName)}${ecosystemQuery(ecosystem)}`,
  );
  const entry: VersionsCacheEntry = { at: Date.now(), value };
  versionsCache.set(cacheKey, entry);
  // Evict by identity so a slow request that resolves after a newer fetch has
  // replaced this entry cannot delete the fresher one.
  const evictIfCurrent = () => {
    if (versionsCache.get(cacheKey) === entry) versionsCache.delete(cacheKey);
  };
  value.then((result) => {
    if (!result.suggested) evictIfCurrent();
  }, evictIfCurrent);
  return value;
}

// One resolution path for turning a bare package name into a diff route,
// shared by the diff landing form and the package-only /diff/<name> route
// (the target of added-dependency "view diff" links), so both entry points
// always agree on the suggested pair and the error copy.
export async function resolveSuggestedDiffPath(
  ecosystem: DiffEcosystem,
  packageName: string,
): Promise<{ path: string } | { error: string }> {
  try {
    const versions = await getPublicDiffVersions(ecosystem, packageName);
    if (!versions.suggested) {
      return { error: "This package needs at least two published versions to diff." };
    }
    return {
      path: packageDiffPath(
        ecosystem,
        versions.packageName,
        versions.suggested.from,
        versions.suggested.to,
      ),
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function getPublicDiff(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
): Promise<PublicDiffResponse> {
  return apiFetch(
    `/api/public/v1/package-diff?${diffQuery(ecosystem, packageName, fromVersion, toVersion)}`,
  );
}

function getPublicDiffFile(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
  path: string,
): Promise<PublicDiffFileResponse> {
  return apiFetch(
    `/api/public/v1/package-diff/file?${diffQuery(ecosystem, packageName, fromVersion, toVersion)}&path=${encodeURIComponent(path)}`,
  );
}

function diffQuery(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
): string {
  return `package=${encodeURIComponent(packageName)}&from=${encodeURIComponent(fromVersion)}&to=${encodeURIComponent(toVersion)}${ecosystemQuery(ecosystem)}`;
}

// npm requests keep their historical parameter-free URLs so long-lived colo
// cache entries stay valid; only PyPI adds the ecosystem parameter.
function ecosystemQuery(ecosystem: DiffEcosystem): string {
  return ecosystem === "pypi" ? "&ecosystem=pypi" : "";
}

// One model instance per (package, from, to) page view; the page remounts the
// model when the route changes, so all state here is for a single version pair.
export const PackageDiffModel = createModel(
  (ecosystem: DiffEcosystem, packageName: string, fromVersion: string, toVersion: string) => {
    const loading = signal(true);
    const error = signal<string | null>(null);
    const diff = signal<PublicDiffResponse | null>(null);
    const versions = signal<PublicDiffVersionsResponse | null>(null);
    const selectedPath = signal<string | null>(null);
    const fileLoading = signal(false);
    const fileError = signal<string | null>(null);
    const file = signal<PublicDiffFileResponse | null>(null);
    const fileCache = new Map<string, PublicDiffFileResponse>();

    return {
      loading,
      error,
      diff,
      versions,
      selectedPath,
      fileLoading,
      fileError,
      file,
      async load() {
        loading.value = true;
        error.value = null;
        const [diffResult, versionsResult] = await Promise.allSettled([
          getPublicDiff(ecosystem, packageName, fromVersion, toVersion),
          getPublicDiffVersions(ecosystem, packageName),
        ]);
        const versionsData = versionsResult.status === "fulfilled" ? versionsResult.value : null;
        if (diffResult.status === "fulfilled") {
          const diffData = diffResult.value;
          batch(() => {
            diff.value = diffData;
            versions.value = versionsData;
            loading.value = false;
          });
          const initial = pickInitialPath(diffData.diff, ecosystem);
          if (initial) void this.selectPath(initial);
        } else {
          batch(() => {
            versions.value = versionsData;
            error.value = errorMessage(diffResult.reason);
            loading.value = false;
          });
        }
      },
      async selectPath(path: string) {
        selectedPath.value = path;
        const cached = fileCache.get(path);
        if (cached) {
          batch(() => {
            file.value = cached;
            fileError.value = null;
            fileLoading.value = false;
          });
          return;
        }
        batch(() => {
          file.value = null;
          fileError.value = null;
          fileLoading.value = true;
        });
        try {
          const data = await getPublicDiffFile(
            ecosystem,
            packageName,
            fromVersion,
            toVersion,
            path,
          );
          fileCache.set(path, data);
          // A slow response for a file the user already navigated away from
          // must not clobber the selection they moved to.
          if (selectedPath.peek() !== path) return;
          batch(() => {
            file.value = data;
            fileLoading.value = false;
          });
        } catch (err) {
          if (selectedPath.peek() !== path) return;
          batch(() => {
            fileError.value = errorMessage(err);
            fileLoading.value = false;
          });
        }
      },
    };
  },
);

const INITIAL_STATUS_RANK: Record<string, number> = {
  added: 0,
  modified: 1,
  removed: 2,
};

// Open the workbench on the most review-worthy file: the ecosystem's manifest
// when it changed, otherwise the first changed file in tree-sort order. The
// match is per-ecosystem — an npm package vendoring a PKG-INFO must not
// auto-open the vendored Python metadata instead of package.json.
function isManifestPath(path: string, ecosystem: DiffEcosystem): boolean {
  if (ecosystem === "pypi") {
    return /(^|\/)PKG-INFO$/.test(path) || path.endsWith(".dist-info/METADATA");
  }
  return path === "package.json";
}

function pickInitialPath(entries: DiffEntry[], ecosystem: DiffEcosystem): string | null {
  const changed = entries.filter((entry) => entry.status !== "unchanged");
  if (!changed.length) return null;
  const manifest = changed.find((entry) => isManifestPath(entry.path, ecosystem));
  if (manifest) return manifest.path;
  return changed.slice().sort((a, b) => {
    const rank = (INITIAL_STATUS_RANK[a.status] ?? 3) - (INITIAL_STATUS_RANK[b.status] ?? 3);
    return rank || a.path.localeCompare(b.path);
  })[0].path;
}
