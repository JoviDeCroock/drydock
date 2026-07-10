import { batch, computed, createModel, effect, signal } from "@preact/signals";
import type {
  FileRecord,
  FindingDiffAnnotation,
  FindingDiffStatus,
  PackageJsonSummary,
} from "../../server/lib/review";
import { apiFetch, apiJson, errorMessage } from "./api";
import {
  decideWorkflowGate,
  getWorkflowGateByScan,
  retryWorkflowGate,
  type PublicWorkflowGate,
  type WorkflowGateDecision,
} from "./github-app";

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

export interface ScanStatusResponse {
  scan: PersistedScanDetail["scan"];
}

export interface ScanFileResponse {
  file: PersistedScanDetail["files"][number];
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
  source?: string | null;
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
  return apiJson<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}/decision`, {
    decision,
    reason,
  });
}

export function deleteScan(id: string): Promise<{ ok: true; id: string }> {
  return apiFetch<{ ok: true; id: string }>(`/api/v1/scans/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getScan(
  id: string,
  options: { poll?: boolean } = {},
): Promise<PersistedScanDetail> {
  const suffix = options.poll ? "?poll=1" : "";
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}${suffix}`);
}

export function getScanStatus(id: string): Promise<ScanStatusResponse> {
  return apiFetch<ScanStatusResponse>(`/api/v1/scans/${encodeURIComponent(id)}/status`);
}

export function getScanFile(id: string, path: string): Promise<ScanFileResponse> {
  const query = `?path=${encodeURIComponent(path)}`;
  return apiFetch<ScanFileResponse>(`/api/v1/scans/${encodeURIComponent(id)}/file${query}`);
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

export type DecisionStatus = "idle" | "saving" | "error";
export type DeleteStatus = "idle" | "deleting" | "error";

export function scanMatchesDecisionFilter(
  scan: Pick<ScanListItem, "decision">,
  filter: ScanDecisionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "undecided") return !scan.decision;
  return scan.decision === filter;
}

export const ScanListModel = createModel(() => {
  const scans = signal<ScanListItem[]>([]);
  const loaded = signal(false);
  const refreshing = signal(false);
  const loadingMore = signal(false);
  const filter = signal<ScanDecisionFilter>("undecided");
  const nextCursor = signal<string | null>(null);
  const error = signal<string | null>(null);
  const decisionStatus = signal<DecisionStatus>("idle");
  const decisionError = signal<string | null>(null);
  const deleteStatus = signal<DeleteStatus>("idle");
  const deleteError = signal<string | null>(null);

  async function refresh(): Promise<void> {
    const currentFilter = filter.peek();
    refreshing.value = true;
    try {
      const data = await listScans({ filter: currentFilter });
      scans.value = data.scans;
      nextCursor.value = data.nextCursor;
      error.value = null;
    } catch (err) {
      error.value = errorMessage(err);
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
    decisionStatus,
    decisionError,
    deleteStatus,
    deleteError,
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
        this.error.value = errorMessage(err);
      } finally {
        this.loadingMore.value = false;
      }
    },

    async setDecision(id: string, decision: ScanDecision, reason: string | null): Promise<void> {
      this.decisionStatus.value = "saving";
      this.decisionError.value = null;
      try {
        const updated = await setScanDecision(id, decision, reason);
        const activeFilter = this.filter.peek();
        this.scans.value = this.scans.value
          .map((scan) =>
            scan.id === id
              ? {
                  ...scan,
                  ...updated.scan,
                  riskSummary: updated.riskSummary ?? updated.scan.riskSummary ?? scan.riskSummary,
                }
              : scan,
          )
          .filter((scan) => scanMatchesDecisionFilter(scan, activeFilter));
        this.decisionStatus.value = "idle";
      } catch (err) {
        this.decisionError.value = errorMessage(err);
        this.decisionStatus.value = "error";
      }
    },

    async deleteFailed(id: string): Promise<boolean> {
      this.deleteStatus.value = "deleting";
      this.deleteError.value = null;
      try {
        await deleteScan(id);
        this.scans.value = this.scans.value.filter((scan) => scan.id !== id);
        this.deleteStatus.value = "idle";
        return true;
      } catch (err) {
        this.deleteError.value = errorMessage(err);
        this.deleteStatus.value = "error";
        return false;
      }
    },
  };
});

// Polling cadence for scans still in pending/running. The base delay doubles
// per consecutive poll failure (so an unreachable API isn't hammered at a
// fixed rate) up to the max, and resets on success. A scan that never reaches
// a terminal status stops polling entirely after the stall window; the UI
// offers a manual resume via `resumePolling()`.
export const SCAN_POLL_BASE_DELAY_MS = 10_000;
export const SCAN_POLL_MAX_DELAY_MS = 30_000;
export const SCAN_POLL_STALL_AFTER_MS = 10 * 60_000;

export const ScanDetailModel = createModel((id: string) => {
  const scanId = signal(id);
  const detail = signal<PersistedScanDetail | null>(null);
  const selectedPath = signal<string | null>(null);
  const error = signal<string | null>(null);
  const pollingStalled = signal(false);
  const versions = signal<ScanVersionsResponse | null>(null);
  const selectedVersion = signal<string | null>(null);
  const compareCache = signal<Record<string, ScanCompareResponse>>({});
  const stagedFileContentCache = signal<Record<string, PersistedScanDetail["files"][number]>>({});
  const fileContentCache = signal<Record<string, FileRecord>>({});
  const compareLoading = signal(false);
  const fileLoading = signal(false);
  const compareError = signal<string | null>(null);
  const decisionStatus = signal<DecisionStatus>("idle");
  const decisionError = signal<string | null>(null);
  const deleteStatus = signal<DeleteStatus>("idle");
  const deleteError = signal<string | null>(null);
  const gate = signal<PublicWorkflowGate | null>(null);
  const gateLoaded = signal(false);
  const gateDecisionStatus = signal<DecisionStatus>("idle");
  const gateDecisionError = signal<string | null>(null);
  const gateRetryStatus = signal<DecisionStatus>("idle");
  const gateRetryError = signal<string | null>(null);

  const isWorkflowGate = computed(() => detail.value?.scan.source === "workflow_gate");
  const status = computed(() => detail.value?.scan.status ?? null);
  const isPolling = computed(() => status.value === "pending" || status.value === "running");
  const isDefaultComparison = computed(() => {
    const selected = selectedVersion.value;
    const v = versions.value;
    // Until versions metadata arrives we can't tell what the default is.
    // Treat the current selection as default so the persisted risk summary
    // stays in view instead of flickering to computed-from-empty-compare values.
    if (!v) return true;
    return selected === (v.defaultPreviousVersion ?? null);
  });
  const compare = computed(() => {
    const cache = compareCache.value;
    const v = selectedVersion.value;
    return v ? (cache[v] ?? null) : null;
  });

  // Background polling while the scan is still running. A self-scheduling
  // timeout chain (not setInterval) lets the cadence adapt: consecutive
  // failures back off exponentially, and a scan stuck non-terminal past the
  // stall window latches `pollingStalled` instead of polling forever. Both
  // signals are read unconditionally so the effect tracks them on every run.
  effect(() => {
    const polling = isPolling.value;
    const stalled = pollingStalled.value;
    if (!polling || stalled) return;

    let disposed = false;
    let delay = SCAN_POLL_BASE_DELAY_MS;
    const startedAt = Date.now();

    const tick = async () => {
      if (Date.now() - startedAt >= SCAN_POLL_STALL_AFTER_MS) {
        pollingStalled.value = true;
        return;
      }
      const ok = await pollDetail();
      // The poll itself can flip isPolling (terminal status) and re-run the
      // effect; the disposed flag keeps the stale chain from rescheduling.
      if (disposed) return;
      delay = ok ? SCAN_POLL_BASE_DELAY_MS : Math.min(delay * 2, SCAN_POLL_MAX_DELAY_MS);
      timer = setTimeout(() => void tick(), delay);
    };

    let timer = setTimeout(() => void tick(), delay);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });

  // Auto-load comparison data when the user picks a version.
  effect(() => {
    const cache = compareCache.value;
    const version = selectedVersion.value;
    if (!version) return;
    if (cache[version]) return;
    void loadCompare(version);
  });

  async function pollDetail(): Promise<boolean> {
    const id = scanId.peek();
    try {
      const data = await getScanStatus(id);
      const current = detail.peek();
      if (data.scan.status === "pending" || data.scan.status === "running") {
        detail.value = current
          ? {
              ...current,
              scan: data.scan,
            }
          : {
              scan: data.scan,
              files: [],
              findings: [],
              events: [],
            };
      } else {
        detail.value = await getScan(id, { poll: true });
      }
      error.value = null;
      const updated = detail.peek();
      if (updated && selectedPath.peek() === null) {
        selectedPath.value = pickInitialPath(updated);
      }
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
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
      compareError.value = errorMessage(err);
    } finally {
      compareLoading.value = false;
    }
  }

  return {
    scanId,
    detail,
    selectedPath,
    error,
    pollingStalled,
    versions,
    selectedVersion,
    compareCache,
    fileContentCache,
    stagedFileContentCache,
    compareLoading,
    fileLoading,
    compareError,
    decisionStatus,
    decisionError,
    deleteStatus,
    deleteError,
    gate,
    gateLoaded,
    gateDecisionStatus,
    gateDecisionError,
    gateRetryStatus,
    gateRetryError,
    isWorkflowGate,
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
        this.error.value = errorMessage(err);
      }
    },

    async loadVersions(): Promise<void> {
      const current = this.detail.peek();
      if (!current?.scan.packageName) return;
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
        this.compareError.value = errorMessage(err);
      }
    },

    selectPath(path: string | null) {
      this.selectedPath.value = path;
    },

    // Manual recovery from the stalled state: refetch right away and clear
    // the latch so the polling effect restarts a fresh backoff chain.
    resumePolling(): void {
      this.pollingStalled.value = false;
      void pollDetail();
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
        this.decisionError.value = errorMessage(err);
        this.decisionStatus.value = "error";
      }
    },

    async deleteFailed(): Promise<boolean> {
      const id = this.scanId.peek();
      this.deleteStatus.value = "deleting";
      this.deleteError.value = null;
      try {
        await deleteScan(id);
        this.deleteStatus.value = "idle";
        return true;
      } catch (err) {
        this.deleteError.value = errorMessage(err);
        this.deleteStatus.value = "error";
        return false;
      }
    },

    async loadGate(): Promise<void> {
      const current = this.detail.peek();
      if (current && current.scan.source !== "workflow_gate") {
        this.gateLoaded.value = true;
        return;
      }
      const id = this.scanId.peek();
      try {
        const gate = await getWorkflowGateByScan(id);
        this.gate.value = gate;
        this.gateLoaded.value = gate !== null;
      } catch (err) {
        this.gateDecisionError.value = errorMessage(err);
        this.gateLoaded.value = false;
      }
    },

    // Decides the package this detail page is reviewing (its own scanId). The
    // gate only finalizes once every package is approved (or any is rejected);
    // until then the returned gate stays pending and other packages still need
    // a decision on their own detail pages.
    async decideGate(
      decision: WorkflowGateDecision,
      comment: string | null,
      totpCode: string | null = null,
    ): Promise<void> {
      const current = this.gate.peek();
      if (!current) return;
      const packageScanId = this.scanId.peek();
      this.gateDecisionStatus.value = "saving";
      this.gateDecisionError.value = null;
      try {
        const { gate: updated } = await decideWorkflowGate(
          current.id,
          packageScanId,
          decision,
          comment,
          totpCode,
        );
        this.gate.value = updated;
        this.gateDecisionStatus.value = "idle";
        // The decision also writes the scan's publish/no_publish decision and an
        // audit event server-side; refresh so the workbench reflects both.
        await this.load();
      } catch (err) {
        this.gateDecisionError.value = errorMessage(err);
        this.gateDecisionStatus.value = "error";
      }
    },

    async retryGate(): Promise<void> {
      const current = this.gate.peek();
      if (!current) return;
      this.gateRetryStatus.value = "saving";
      this.gateRetryError.value = null;
      try {
        const { gate: updated } = await retryWorkflowGate(current.id);
        this.gate.value = updated;
        this.gateLoaded.value = true;
        this.gateRetryStatus.value = "idle";
      } catch (err) {
        this.gateRetryError.value = errorMessage(err);
        this.gateRetryStatus.value = "error";
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
        this.compareError.value = errorMessage(err);
      } finally {
        this.fileLoading.value = false;
      }
    },

    async loadStagedFile(path: string): Promise<void> {
      if (this.stagedFileContentCache.peek()[path]) return;
      const id = this.scanId.peek();
      this.fileLoading.value = true;
      try {
        const data = await getScanFile(id, path);
        this.stagedFileContentCache.value = {
          ...this.stagedFileContentCache.peek(),
          [path]: data.file,
        };
      } catch (err) {
        this.compareError.value = errorMessage(err);
      } finally {
        this.fileLoading.value = false;
      }
    },
  };
});

export type ScanDetailModelInstance = InstanceType<typeof ScanDetailModel>;

function pickInitialPath(data: PersistedScanDetail): string | null {
  return (
    data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null
  );
}
