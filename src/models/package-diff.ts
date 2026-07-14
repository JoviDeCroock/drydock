import { batch, createModel, signal } from "@preact/signals";
import type {
  DiffEntry,
  FileRecord,
  Finding,
  FindingDiffAnnotation,
  PackageJsonDiff,
  PackageJsonSummary,
} from "../../server/lib/review";
import type { ScanRiskBreakdown } from "../../server/lib/risk";
import { apiFetch, errorMessage } from "./api";

export interface PublicDiffVersionsResponse {
  packageName: string;
  versions: Array<{ version: string; distTags: string[]; publishedAt?: string }>;
  suggested: { from: string; to: string } | null;
}

export interface PublicDiffResponse {
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
  cachedAt: string;
}

export interface PublicDiffFileResponse {
  path: string;
  before: FileRecord | null;
  after: FileRecord | null;
  textSamplesOmitted: boolean;
}

export function getPublicDiffVersions(packageName: string): Promise<PublicDiffVersionsResponse> {
  return apiFetch(
    `/api/public/v1/package-diff/versions?package=${encodeURIComponent(packageName)}`,
  );
}

export function getPublicDiff(
  packageName: string,
  fromVersion: string,
  toVersion: string,
): Promise<PublicDiffResponse> {
  return apiFetch(`/api/public/v1/package-diff?${diffQuery(packageName, fromVersion, toVersion)}`);
}

export function getPublicDiffFile(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  path: string,
): Promise<PublicDiffFileResponse> {
  return apiFetch(
    `/api/public/v1/package-diff/file?${diffQuery(packageName, fromVersion, toVersion)}&path=${encodeURIComponent(path)}`,
  );
}

function diffQuery(packageName: string, fromVersion: string, toVersion: string): string {
  return `package=${encodeURIComponent(packageName)}&from=${encodeURIComponent(fromVersion)}&to=${encodeURIComponent(toVersion)}`;
}

// One model instance per (package, from, to) page view; the page remounts the
// model when the route changes, so all state here is for a single version pair.
export const PackageDiffModel = createModel(
  (packageName: string, fromVersion: string, toVersion: string) => {
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
        try {
          const [diffData, versionsData] = await Promise.all([
            getPublicDiff(packageName, fromVersion, toVersion),
            getPublicDiffVersions(packageName).catch(() => null),
          ]);
          batch(() => {
            diff.value = diffData;
            versions.value = versionsData;
            loading.value = false;
          });
          const initial = pickInitialPath(diffData.diff);
          if (initial) void this.selectPath(initial);
        } catch (err) {
          batch(() => {
            error.value = errorMessage(err);
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
          const data = await getPublicDiffFile(packageName, fromVersion, toVersion, path);
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

// Open the workbench on the most review-worthy file: the manifest when it
// changed, otherwise the first changed file in tree-sort order.
function pickInitialPath(entries: DiffEntry[]): string | null {
  const changed = entries.filter((entry) => entry.status !== "unchanged");
  if (!changed.length) return null;
  const manifest = changed.find((entry) => entry.path === "package.json");
  if (manifest) return manifest.path;
  return changed.slice().sort((a, b) => {
    const rank = (INITIAL_STATUS_RANK[a.status] ?? 3) - (INITIAL_STATUS_RANK[b.status] ?? 3);
    return rank || a.path.localeCompare(b.path);
  })[0].path;
}
