import {
  type DecisionStatus,
  deleteScan,
  type DeleteStatus,
  listScans,
  type ScanDecision,
  type ScanDecisionFilter,
  type ScanListItem,
  scanMatchesDecisionFilter,
  setScanDecision,
} from "./scan-api";
/**
 * The dashboard scan list: fetching a page, filtering by decision, and the
 * per-row decide/delete actions.
 */
import { createModel, effect, signal } from "@preact/signals";
import { errorMessage } from "./api";

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
  // Whether this organization has ever had a scan, independent of the active
  // filter. `null` means not yet determined. The list alone cannot answer this:
  // the default filter is "undecided", so a maintainer who has decided every
  // review looks identical to one who has never run a scan — and only the
  // second should be shown the getting-started panel.
  const hasAnyScan = signal<boolean | null>(null);

  async function refresh(): Promise<void> {
    const currentFilter = filter.peek();
    refreshing.value = true;
    try {
      const data = await listScans({ filter: currentFilter });
      scans.value = data.scans;
      nextCursor.value = data.nextCursor;
      error.value = null;
      // Resolved on every refresh rather than latched once, because `refresh`
      // is also what runs on an organization switch: a stale `true` carried
      // over from the previous organization would hide the getting-started
      // panel from a brand-new one.
      if (data.scans.length > 0) {
        // Any non-empty page settles it without another request.
        hasAnyScan.value = true;
      } else if (currentFilter === "all") {
        // An empty "all" page is the direct answer.
        hasAnyScan.value = false;
      } else {
        hasAnyScan.value = null;
        await resolveHasAnyScan();
      }
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      loaded.value = true;
      refreshing.value = false;
    }
  }

  // One-row probe for the case the filtered list cannot answer: this filter is
  // empty, but the organization may still have decided reviews. Failure leaves
  // `hasAnyScan` null, which renders nothing — an onboarding panel is never
  // worth showing on a guess.
  async function resolveHasAnyScan(): Promise<void> {
    if (hasAnyScan.peek() !== null) return;
    try {
      const data = await listScans({ filter: "all", limit: 1 });
      hasAnyScan.value = data.scans.length > 0;
    } catch {
      // Leave unknown.
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
    hasAnyScan,
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
        // Deleting the organization's only scan puts it back in the
        // never-scanned state, so the getting-started panel has to come back.
        // An emptied list is not enough on its own — the active filter may just
        // have nothing in it — so re-probe instead of assuming. One row, and it
        // leaves the list alone.
        if (this.scans.value.length === 0) {
          this.hasAnyScan.value = null;
          await resolveHasAnyScan();
        }
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
