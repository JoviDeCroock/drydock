import { batch, computed, createModel, effect, signal } from "@preact/signals";
import type {
  FileRecord,
  FindingDiffAnnotation,
  FindingDiffStatus,
  PackageJsonSummary,
} from "../../server/lib/review";
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
  findingAnnotations?: Array<{ id: string } & FindingDiffAnnotation>;
  cachedAt?: string;
}

export interface ScanCompareFileResponse {
  version: string;
  file: FileRecord;
}

export type ScanDecision = "publish" | "no_publish";
export type ScanDecisionFilter = "undecided" | "publish" | "no_publish" | "all";

export interface ScanRiskSummary {
  artifactRisk: string;
  releaseRisk: string;
  contextRisk: string;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
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
  decision?: ScanDecision | string | null;
  decisionReason?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: string | number | Date | null;
  changedFileCount?: number;
  findingCount?: number;
  riskSummary?: ScanRiskSummary | null;
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
  riskSummary?: ScanRiskSummary | null;
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
    line?: number | null;
    source: string;
    ruleId?: string | null;
    ruleVersion?: string | null;
    diffStatus?: FindingDiffStatus;
    releaseDelta?: boolean;
  }>;
  events: Array<{
    id: string;
    organizationId: string;
    actorUserId: string | null;
    scanId: string | null;
    type: string;
    metadataJson: unknown;
    createdAt: string | number | Date;
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

export interface ListScansResponse {
  scans: ScanListItem[];
  nextCursor: string | null;
  filter: ScanDecisionFilter;
  limit: number;
}

export function listScans(
  options: { cursor?: string | null; filter?: ScanDecisionFilter; limit?: number } = {},
): Promise<ListScansResponse> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.filter) params.set("filter", options.filter);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return apiFetch<ListScansResponse>(`/api/v1/scans${qs ? `?${qs}` : ""}`);
}

export function setScanDecision(
  id: string,
  decision: ScanDecision,
  reason: string | null,
): Promise<PersistedScanDetail> {
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  });
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
  const loadingMore = signal(false);
  const filter = signal<ScanDecisionFilter>("undecided");
  const nextCursor = signal<string | null>(null);
  const error = signal<string | null>(null);

  async function refresh(): Promise<void> {
    const currentFilter = filter.peek();
    refreshing.value = true;
    try {
      const data = await listScans({ filter: currentFilter });
      scans.value = data.scans;
      nextCursor.value = data.nextCursor;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loaded.value = true;
      refreshing.value = false;
    }
  }

  // Re-fetch when the filter changes. The first load is driven externally
  // (after auth) so callers can sequence it with other startup work; this
  // effect only kicks in for filter changes that happen after that.
  effect(() => {
    void filter.value;
    if (!loaded.peek()) return;
    void refresh();
  });

  return {
    scans,
    loaded,
    refreshing,
    loadingMore,
    filter,
    nextCursor,
    error,
    refresh,

    async loadMore(): Promise<void> {
      const cursor = this.nextCursor.value;
      if (!cursor || this.loadingMore.value) return;
      this.loadingMore.value = true;
      try {
        const data = await listScans({ cursor, filter: this.filter.value });
        this.scans.value = [...this.scans.value, ...data.scans];
        this.nextCursor.value = data.nextCursor;
        this.error.value = null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loadingMore.value = false;
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

export type DecisionStatus = "idle" | "saving" | "error";

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
  const decisionStatus = signal<DecisionStatus>("idle");
  const decisionError = signal<string | null>(null);

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
    decisionStatus,
    decisionError,
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
      this.compareError.value = null;
      try {
        const data = await getScanVersions(id);
        batch(() => {
          this.versions.value = data;
          if (this.selectedVersion.peek() === null) {
            this.selectedVersion.value = data.defaultPreviousVersion ?? null;
          }
        });
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

    async setDecision(decision: ScanDecision, reason: string | null): Promise<void> {
      const id = this.scanId.peek();
      this.decisionStatus.value = "saving";
      this.decisionError.value = null;
      try {
        const updated = await setScanDecision(id, decision, reason);
        this.detail.value = updated;
        this.decisionStatus.value = "idle";
      } catch (err) {
        this.decisionError.value = err instanceof Error ? err.message : String(err);
        this.decisionStatus.value = "error";
      }
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
