import { batch, createModel, effect, signal } from "@preact/signals";
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
import { findingFirstPath } from "../features/review/initial-path";
import { apiFetch, errorMessage } from "./api";

export interface PublicDiffVersionsResponse {
  ecosystem: DiffEcosystem;
  packageName: string;
  // Set when an atpm package's canonical DID spelling differs from its readable
  // verified `@handle/name`. Null elsewhere.
  displayName: string | null;
  versions: Array<{ version: string; distTags: string[]; publishedAt?: string }>;
  suggested: { from: string; to: string } | null;
}

export interface PublicDiffAttestation {
  status: "verified" | "mismatch" | "invalid" | "absent" | "not-evaluated";
  build?: {
    repository: string;
    ref: string | null;
    commit: string | null;
    workflow: string | null;
    runUrl: string | null;
    runnerEnvironment: string | null;
    signedAt: string | null;
    logIndex: string | null;
    logBaseUrl: string;
  };
  reason?: string;
  declared?: { repository: string; workflow: string; allowPublish: boolean };
  match?:
    | "match"
    | "repository-mismatch"
    | "workflow-mismatch"
    | "workflow-unverified"
    | "unknown-provider";
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
  // How the reviewed bytes were located, when that is a chain of independent
  // authorities rather than a single registry (atpm). Empty elsewhere.
  provenance: Array<{ label: string; value: string; detail?: string }>;
  // Whether the target release proves where it was built, and whether that
  // matches the publisher's declared trusted-publishing workflow (atpm).
  attestation: PublicDiffAttestation | null;
  // Readable spelling of `packageName`; see PublicDiffVersionsResponse.
  displayName: string | null;
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
    { credentials: "omit" },
  );
  const entry: VersionsCacheEntry = { at: Date.now(), value };
  versionsCache.set(cacheKey, entry);
  // Evict by identity so a slow request that resolves after a newer fetch has
  // replaced this entry cannot delete the fresher one.
  const evictIfCurrent = () => {
    if (versionsCache.get(cacheKey) === entry) versionsCache.delete(cacheKey);
  };
  value.then((result) => {
    if (!result.suggested) return evictIfCurrent();
    // Also file the answer under the canonical name the response came back
    // with. The landing form asks by whatever was typed and then routes to the
    // canonical spelling — an atpm handle resolves to its DID form — so
    // without this the page it lands on always re-fetches what was just loaded.
    const canonicalKey = `${ecosystem}:${result.packageName}`;
    if (canonicalKey !== cacheKey && !versionsCache.has(canonicalKey)) {
      versionsCache.set(canonicalKey, { at: entry.at, value });
    }
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

export function getPublicDiff(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
  signal?: AbortSignal,
): Promise<PublicDiffResponse> {
  return apiFetch(
    `/api/public/v1/package-diff?${diffQuery(ecosystem, packageName, fromVersion, toVersion)}`,
    { credentials: "omit", ...(signal ? { signal } : {}) },
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
    { credentials: "omit" },
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
// cache entries stay valid; every other ecosystem names itself.
function ecosystemQuery(ecosystem: DiffEcosystem): string {
  return ecosystem === "npm" ? "" : `&ecosystem=${ecosystem}`;
}

// One model instance per (package, from, to) page view; the page remounts the
// model when the route changes, so all state here is for a single version pair.
export const PackageDiffModel = createModel(
  (
    ecosystem: DiffEcosystem,
    packageName: string,
    fromVersion: string,
    toVersion: string,
    initialDiff?: PublicDiffResponse,
  ) => {
    const loading = signal(!initialDiff);
    const error = signal<string | null>(null);
    const diff = signal<PublicDiffResponse | null>(initialDiff ?? null);
    const versions = signal<PublicDiffVersionsResponse | null>(null);
    const selectedPath = signal<string | null>(null);
    const fileLoading = signal(false);
    const fileError = signal<string | null>(null);
    const fileFailure = signal<unknown | null>(null);
    const file = signal<PublicDiffFileResponse | null>(null);
    const fileCache = new Map<string, PublicDiffFileResponse>();
    const pendingFiles = new Map<string, Promise<PublicDiffFileResponse>>();
    let pendingLoad: Promise<void> | null = null;
    let selection = 0;
    let disposed = false;
    const lifetime = new AbortController();
    effect(() => () => {
      disposed = true;
      lifetime.abort();
    });

    return {
      loading,
      error,
      diff,
      versions,
      selectedPath,
      fileLoading,
      fileError,
      fileFailure,
      file,
      load(): Promise<void> {
        if (disposed) return Promise.resolve();
        if (pendingLoad) return pendingLoad;
        loading.value = !diff.peek();
        error.value = null;
        const selectedAtStart = selection;
        pendingLoad = (async () => {
          const [diffResult, versionsResult] = await Promise.allSettled([
            diff.peek() ??
              getPublicDiff(ecosystem, packageName, fromVersion, toVersion, lifetime.signal),
            getPublicDiffVersions(ecosystem, packageName),
          ]);
          if (disposed) return;
          const versionsData = versionsResult.status === "fulfilled" ? versionsResult.value : null;
          if (diffResult.status === "fulfilled") {
            const diffData = diffResult.value;
            batch(() => {
              diff.value = diffData;
              versions.value = versionsData;
              loading.value = false;
            });
            const initial = pickInitialPath(diffData.diff, diffData.findings, ecosystem);
            if (initial && selection === selectedAtStart && selectedPath.peek() === null)
              void this.selectPath(initial);
          } else {
            batch(() => {
              versions.value = versionsData;
              error.value = errorMessage(diffResult.reason);
              loading.value = false;
            });
          }
        })().finally(() => {
          pendingLoad = null;
        });
        return pendingLoad;
      },
      async selectPath(path: string, signal?: AbortSignal): Promise<PublicDiffFileResponse | null> {
        if (disposed || signal?.aborted) return null;
        const requestSelection = ++selection;
        selectedPath.value = path;
        const cached = fileCache.get(path);
        if (cached) {
          batch(() => {
            file.value = cached;
            fileError.value = null;
            fileFailure.value = null;
            fileLoading.value = false;
          });
          return cached;
        }
        batch(() => {
          file.value = null;
          fileError.value = null;
          fileFailure.value = null;
          fileLoading.value = true;
        });
        let abort: (() => void) | undefined;
        try {
          let pending = pendingFiles.get(path);
          if (!pending) {
            pending = getPublicDiffFile(ecosystem, packageName, fromVersion, toVersion, path);
            pendingFiles.set(path, pending);
            const clearPending = () => {
              if (pendingFiles.get(path) === pending) pendingFiles.delete(path);
            };
            void pending.then(clearPending, clearPending);
          }
          const cancelled =
            signal &&
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          const data = await (cancelled ? Promise.race([pending, cancelled]) : pending);
          signal?.throwIfAborted();
          if (disposed) return null;
          fileCache.set(path, data);
          // A slow response for a file the user already navigated away from
          // must not clobber the selection they moved to.
          if (selection !== requestSelection) return data;
          batch(() => {
            file.value = data;
            fileLoading.value = false;
          });
          return data;
        } catch (err) {
          if (disposed || selection !== requestSelection) return null;
          batch(() => {
            fileError.value = signal?.aborted ? "File inspection cancelled." : errorMessage(err);
            fileFailure.value = err;
            fileLoading.value = false;
          });
          return null;
        } finally {
          if (signal && abort) signal.removeEventListener("abort", abort);
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

// The manifest match is per-ecosystem — an npm package vendoring a PKG-INFO
// must not auto-open the vendored Python metadata instead of package.json.
function isManifestPath(path: string, ecosystem: DiffEcosystem): boolean {
  if (ecosystem === "pypi") {
    return /(^|\/)PKG-INFO$/.test(path) || path.endsWith(".dist-info/METADATA");
  }
  return path === "package.json";
}

// Open the workbench on the most review-worthy file: the changed file carrying
// the most severe finding, else the ecosystem's manifest when it changed, else
// the first changed file by status rank and path.
export function pickInitialPath(
  entries: DiffEntry[],
  findings: ReadonlyArray<{ file?: string | null; severity?: string }>,
  ecosystem: DiffEcosystem,
): string | null {
  const changed = entries.filter((entry) => entry.status !== "unchanged");
  if (!changed.length) return null;
  const flagged = findingFirstPath(changed, findings);
  if (flagged) return flagged;
  const manifest = changed.find((entry) => isManifestPath(entry.path, ecosystem));
  if (manifest) return manifest.path;
  return changed.slice().sort((a, b) => {
    const rank = (INITIAL_STATUS_RANK[a.status] ?? 3) - (INITIAL_STATUS_RANK[b.status] ?? 3);
    return rank || a.path.localeCompare(b.path);
  })[0].path;
}
