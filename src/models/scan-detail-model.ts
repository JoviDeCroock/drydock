import {
  type DecisionStatus,
  deleteScan,
  type DeleteStatus,
  enableScanShare,
  getScan,
  getScanCompare,
  getScanCompareFile,
  getScanFile,
  getScanStatus,
  getScanVersions,
  type PersistedScanDetail,
  publicAttestationAvailable,
  publicReportUrl,
  type PublicShareInfo,
  revokeScanShare,
  type ScanCompareResponse,
  type ScanDecision,
  type ScanVersionsResponse,
  setScanDecision,
} from "./scan-api";
/**
 * One scan's workbench state: the report, file selection, share links, gate
 * decisions, and the polling that carries a running scan to a terminal status.
 */
import { batch, computed, createModel, effect, signal } from "@preact/signals";
import type { FileRecord } from "../../server/lib/review";
import { ApiError, errorMessage } from "./api";
import {
  decideWorkflowGate,
  getWorkflowGateByScan,
  retryWorkflowGate,
  type PublicWorkflowGate,
  type WorkflowGateDecision,
} from "./github-app";

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
  // Public share link state lives in its own signal (not derived from `detail`)
  // so the share dialog's enable/revoke round-trip re-renders only the dialog
  // host — mutating `detail` re-renders the whole page, including the
  // per-finding risk list (see the dialog-host comment in ScanDetail).
  const share = signal<PublicShareInfo | null>(null);
  const shareStatus = signal<DecisionStatus>("idle");
  const shareError = signal<string | null>(null);
  const attestationAvailable = signal<boolean | null>(null);
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
    share,
    shareStatus,
    shareError,
    attestationAvailable,
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
        batch(() => {
          this.detail.value = data;
          this.share.value = data.scan.publicShareToken
            ? {
                token: data.scan.publicShareToken,
                url: data.scan.publicShareUrl ?? publicReportUrl(data.scan.publicShareToken),
                sharedAt: data.scan.publicSharedAt ?? data.scan.updatedAt,
                threatFeedListedAt: data.scan.publicFeedListedAt ?? null,
              }
            : null;
          if (this.selectedPath.peek() === null) {
            this.selectedPath.value = pickInitialPath(data);
          }
        });
      } catch (err) {
        this.error.value = errorMessage(err);
      }
    },

    async enableShare(): Promise<void> {
      const id = this.scanId.peek();
      this.shareStatus.value = "saving";
      this.shareError.value = null;
      try {
        const { share } = await enableScanShare(id);
        this.share.value = share;
        this.shareStatus.value = "idle";
      } catch (err) {
        this.shareError.value = shareErrorMessage(err);
        this.shareStatus.value = "error";
      }
    },

    async loadAttestationAvailability(): Promise<void> {
      this.attestationAvailable.value = null;
      this.attestationAvailable.value = await publicAttestationAvailable();
    },

    async setFeedListing(listed: boolean): Promise<void> {
      const id = this.scanId.peek();
      this.shareStatus.value = "saving";
      this.shareError.value = null;
      try {
        const { share } = await enableScanShare(id, { threatFeed: listed });
        this.share.value = share;
        this.shareStatus.value = "idle";
      } catch (err) {
        // 409 means the link was revoked while the toggle was in flight — drop
        // the dead share state so the dialog falls back to "create link".
        if (err instanceof ApiError && err.status === 409) this.share.value = null;
        this.shareError.value = shareErrorMessage(err);
        this.shareStatus.value = "error";
      }
    },

    async revokeShare(): Promise<void> {
      const id = this.scanId.peek();
      this.shareStatus.value = "saving";
      this.shareError.value = null;
      try {
        await revokeScanShare(id);
        this.share.value = null;
        this.shareStatus.value = "idle";
      } catch (err) {
        this.shareError.value = shareErrorMessage(err);
        this.shareStatus.value = "error";
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

// The server returns a bare 403 for non-owner/admin members; translate it into
// the actionable sentence before it reaches the dialog.
function shareErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) {
    return "Only organization owners and admins can manage public links.";
  }
  return errorMessage(err);
}

function pickInitialPath(data: PersistedScanDetail): string | null {
  return (
    data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null
  );
}
