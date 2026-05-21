import { computed, createModel, effect, signal } from "@preact/signals";
import type { FileRecord, PackageJsonSummary } from "../../server/lib/review";
import type { ScanResult } from "../../server/types";
import { apiFetch } from "./api";

export interface ScanVersionsResponse {
  packageName: string | null;
  stagedVersion: string | null;
  defaultPreviousVersion: string | null;
  versions: Array<{ version: string; distTags: string[]; publishedAt?: string }>;
}

export interface ScanCompareResponse {
  version: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  cachedAt?: string;
}

export interface ScanCompareFileResponse {
  version: string;
  file: FileRecord;
}

export interface ScanListItem {
  id: string;
  stageId: string;
  organizationId?: string | null;
  ownerUserId?: string | null;
  packageName: string | null;
  stagedVersion: string | null;
  previousVersion: string | null;
  risk: string;
  status: string;
  reportVersion?: number | null;
  reportDigest?: string | null;
  startedAt?: string | number | Date | null;
  completedAt?: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface PersistedScanDetail {
  scan: ScanListItem & {
    summaryJson?: unknown;
    aiJson?: unknown;
    errorJson?: unknown;
    reportVersion?: number | null;
    reportDigest?: string | null;
    startedAt?: string | number | Date | null;
    completedAt?: string | number | Date | null;
  };
  files: Array<{
    id: string;
    scanId: string;
    path: string;
    status: string;
    size: number | null;
    sha256: string | null;
    flagsJson: unknown;
    textSample: string | null;
  }>;
  findings: Array<{
    id: string;
    scanId: string;
    severity: string;
    file: string;
    evidence: string;
    reason: string;
    source: string;
    ruleId?: string | null;
    ruleVersion?: string | null;
  }>;
}

export function runScan(stageId: string): Promise<ScanResult> {
  return apiFetch<ScanResult>("/api/v1/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
}

export function createScan(stageId: string): Promise<{ scan: ScanListItem; queued: boolean }> {
  return apiFetch<{ scan: ScanListItem; queued: boolean }>("/api/v1/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
}

export async function listScans(): Promise<ScanListItem[]> {
  const data = await apiFetch<{ scans: ScanListItem[] }>("/api/v1/scans");
  return data.scans;
}

export function getScan(
  id: string,
  options: { poll?: boolean } = {},
): Promise<PersistedScanDetail> {
  const suffix = options.poll ? "?poll=1" : "";
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}${suffix}`);
}

export function getScanVersions(id: string): Promise<ScanVersionsResponse> {
  return apiFetch<ScanVersionsResponse>(`/api/v1/scans/${encodeURIComponent(id)}/versions`);
}

export function getScanCompare(id: string, version: string): Promise<ScanCompareResponse> {
  const query = `?version=${encodeURIComponent(version)}`;
  return apiFetch<ScanCompareResponse>(`/api/v1/scans/${encodeURIComponent(id)}/compare${query}`);
}

export function getScanCompareFile(
  id: string,
  version: string,
  path: string,
): Promise<ScanCompareFileResponse> {
  const query = `?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`;
  return apiFetch<ScanCompareFileResponse>(
    `/api/v1/scans/${encodeURIComponent(id)}/compare/file${query}`,
  );
}

export const ScanListModel = createModel(() => {
  const scans = signal<ScanListItem[]>([]);
  const loaded = signal(false);
  const refreshing = signal(false);
  const error = signal<string | null>(null);

  return {
    scans,
    loaded,
    refreshing,
    error,

    async refresh(): Promise<void> {
      this.refreshing.value = true;
      try {
        this.scans.value = await listScans();
        this.error.value = null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loaded.value = true;
        this.refreshing.value = false;
      }
    },
  };
});

export type ScanRequestStatus = "idle" | "scanning" | "done" | "error";

export const ScanRequestModel = createModel(() => {
  const stageId = signal("");
  const status = signal<ScanRequestStatus>("idle");
  const error = signal<string | null>(null);
  const lastResult = signal<{ scan: ScanListItem; queued: boolean } | null>(null);

  return {
    stageId,
    status,
    error,
    lastResult,

    async submit(): Promise<{ scan: ScanListItem; queued: boolean } | null> {
      const trimmed = this.stageId.value.trim();
      if (!trimmed) return null;
      this.status.value = "scanning";
      this.error.value = null;
      this.lastResult.value = null;
      try {
        const data = await createScan(trimmed);
        this.lastResult.value = data;
        this.status.value = "done";
        return data;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        this.status.value = "error";
        return null;
      }
    },
  };
});

export const ScanDetailModel = createModel((id: string) => {
  const scanId = signal(id);
  const detail = signal<PersistedScanDetail | null>(null);
  const selectedPath = signal<string | null>(null);
  const error = signal<string | null>(null);
  const versions = signal<ScanVersionsResponse | null>(null);
  const selectedVersion = signal<string | null>(null);
  const compareCache = signal<Record<string, ScanCompareResponse>>({});
  const fileContentCache = signal<Record<string, FileRecord>>({});
  const compareLoading = signal(false);
  const fileLoading = signal(false);
  const compareError = signal<string | null>(null);

  const status = computed(() => detail.value?.scan.status ?? null);
  const isPolling = computed(() => status.value === "pending" || status.value === "running");
  const isDefaultComparison = computed(
    () => selectedVersion.value === (versions.value?.defaultPreviousVersion ?? null),
  );
  const compare = computed(() => {
    const cache = compareCache.value;
    const v = selectedVersion.value;
    return v ? (cache[v] ?? null) : null;
  });

  // Background polling while the scan is still running.
  effect(() => {
    if (!isPolling.value) return;
    const timer = window.setInterval(() => {
      void pollDetail();
    }, 2500);
    return () => window.clearInterval(timer);
  });

  // Auto-load comparison data when the user picks a version.
  effect(() => {
    const cache = compareCache.value;
    const version = selectedVersion.value;
    if (!version) return;
    if (cache[version]) return;
    void loadCompare(version);
  });

  async function pollDetail() {
    const id = scanId.peek();
    try {
      const data = await getScan(id, { poll: true });
      detail.value = data;
      error.value = null;
      if (selectedPath.peek() === null) {
        selectedPath.value = pickInitialPath(data);
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function loadCompare(version: string) {
    const id = scanId.peek();
    compareLoading.value = true;
    compareError.value = null;
    try {
      const data = await getScanCompare(id, version);
      compareCache.value = { ...compareCache.peek(), [version]: data };
    } catch (err) {
      compareError.value = err instanceof Error ? err.message : String(err);
    } finally {
      compareLoading.value = false;
    }
  }

  return {
    scanId,
    detail,
    selectedPath,
    error,
    versions,
    selectedVersion,
    compareCache,
    fileContentCache,
    compareLoading,
    fileLoading,
    compareError,
    status,
    isPolling,
    isDefaultComparison,
    compare,

    async load(): Promise<void> {
      const id = this.scanId.peek();
      try {
        const data = await getScan(id);
        this.detail.value = data;
        if (this.selectedPath.peek() === null) {
          this.selectedPath.value = pickInitialPath(data);
        }
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      }
    },

    async loadVersions(): Promise<void> {
      const current = this.detail.peek();
      if (!current || current.scan.status !== "complete") return;
      if (!current.scan.packageName) return;
      const id = this.scanId.peek();
      try {
        const data = await getScanVersions(id);
        this.versions.value = data;
        if (this.selectedVersion.peek() === null) {
          this.selectedVersion.value = data.defaultPreviousVersion ?? null;
        }
      } catch (err) {
        this.compareError.value = err instanceof Error ? err.message : String(err);
      }
    },

    selectPath(path: string | null) {
      this.selectedPath.value = path;
    },

    selectVersion(version: string | null) {
      this.selectedVersion.value = version;
    },

    async loadPreviousFile(version: string, path: string): Promise<void> {
      const key = `${version}::${path}`;
      if (this.fileContentCache.peek()[key]) return;
      const id = this.scanId.peek();
      this.fileLoading.value = true;
      try {
        const data = await getScanCompareFile(id, version, path);
        this.fileContentCache.value = { ...this.fileContentCache.peek(), [key]: data.file };
      } catch (err) {
        this.compareError.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.fileLoading.value = false;
      }
    },
  };
});

function pickInitialPath(data: PersistedScanDetail): string | null {
  return (
    data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null
  );
}
