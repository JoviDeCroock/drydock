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
import { activeOrganizationId } from "./active-organization";
import { errorMessage } from "./api";

interface ScanListRefreshOptions {
  /** Keep every page the user has already loaded instead of returning to page one. */
  preserveLoaded?: boolean;
}

const LIST_SCANS_REFRESH_LIMIT = 100;

export const ScanListModel = createModel(() => {
  const scans = signal<ScanListItem[]>([]);
  const loaded = signal(false);
  const refreshing = signal(false);
  const loadingMore = signal(false);
  const filter = signal<ScanDecisionFilter>("undecided");
  const nextCursor = signal<string | null>(null);
  const error = signal<string | null>(null);
  // The org's approval bar, echoed by the list endpoint. 1 means a single
  // approval decides — the queue then never mentions approvals at all.
  const requiredApprovals = signal(1);
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
  // Whether this organization has ever recorded a decision — the last step of
  // the getting-started funnel. `null` means not yet determined, and stays that
  // way until something asks: answering it costs requests the rest of the
  // dashboard has no use for, so an organization past onboarding never pays for
  // it. See `resolveHasAnyDecision`.
  const hasAnyDecision = signal<boolean | null>(null);
  let decisionProbe: Promise<void> | null = null;
  let decisionProbeGeneration = 0;
  let onboardingOrganizationId = activeOrganizationId.peek();
  // `Check npm` resolves registry outcomes under Worker `waitUntil`, after the
  // discovery response returns. Incrementing this signal starts a bounded
  // refresh sequence; a later request or model disposal cancels the old one.
  const registryStatusRefreshRequest = signal(0);
  let refreshRequestId = 0;
  // Refresh and pagination replace or extend the same cursor snapshot. The
  // operation that starts later owns the next list mutation.
  let listMutationId = 0;

  async function refresh(options: ScanListRefreshOptions = {}): Promise<void> {
    ++decisionProbeGeneration;
    decisionProbe = null;
    const requestId = ++refreshRequestId;
    const mutationId = ++listMutationId;
    const organizationId = activeOrganizationId.peek();
    const currentFilter = filter.peek();
    const loadedCount = options.preserveLoaded ? scans.peek().length : 0;
    refreshing.value = true;
    try {
      const firstLimit =
        loadedCount > 0 ? Math.min(LIST_SCANS_REFRESH_LIMIT, loadedCount) : undefined;
      const firstPage = await listScans({ filter: currentFilter, limit: firstLimit });
      if (!isCurrentRefresh(requestId, mutationId, organizationId)) return;
      const refreshed = [...firstPage.scans];
      let cursor = firstPage.nextCursor;
      while (options.preserveLoaded && refreshed.length < loadedCount && cursor) {
        const page = await listScans({
          cursor,
          filter: currentFilter,
          limit: Math.min(LIST_SCANS_REFRESH_LIMIT, loadedCount - refreshed.length),
        });
        if (!isCurrentRefresh(requestId, mutationId, organizationId)) return;
        refreshed.push(...page.scans);
        cursor = page.nextCursor;
      }
      // A concurrent Load more completed while these pages were in flight.
      if (options.preserveLoaded && scans.peek().length > loadedCount) return;
      const data = { ...firstPage, scans: refreshed, nextCursor: cursor };
      scans.value = data.scans;
      nextCursor.value = data.nextCursor;
      requiredApprovals.value = data.requiredApprovals ?? 1;
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
        await resolveHasAnyScan({ requestId, mutationId, organizationId });
      }
      // A decided row in the page just fetched settles the answer for free; an
      // organization with no scans at all cannot have decided one. Preserve a
      // known `true` across same-organization refreshes: decisions can change
      // but cannot be cleared, and completed scans cannot be deleted. The
      // organization effect below resets the answer when the scope changes.
      //
      // Guarded because the `hasAnyScan` probe above is awaited: a refresh
      // whose organization was switched away from resumes here, and would
      // otherwise reset the current organization's answer to null and drop its
      // in-flight probe.
      if (!isCurrentRefresh(requestId, mutationId, organizationId)) return;
      ++decisionProbeGeneration;
      decisionProbe = null;
      hasAnyDecision.value =
        hasAnyDecision.peek() === true || hasDecidedScan(data.scans)
          ? true
          : hasAnyScan.peek() === false
            ? false
            : null;
    } catch (err) {
      if (!isCurrentRefresh(requestId, mutationId, organizationId)) return;
      error.value = errorMessage(err);
    } finally {
      if (requestId === refreshRequestId) {
        if (activeOrganizationId.peek() === organizationId) loaded.value = true;
        refreshing.value = false;
      }
    }
  }

  function isCurrentRefresh(
    requestId: number,
    mutationId: number,
    organizationId: string | null,
  ): boolean {
    return (
      requestId === refreshRequestId &&
      mutationId === listMutationId &&
      activeOrganizationId.peek() === organizationId
    );
  }

  // One-row probe for the case the filtered list cannot answer: this filter is
  // empty, but the organization may still have decided reviews. Failure leaves
  // `hasAnyScan` null, which renders nothing — an onboarding panel is never
  // worth showing on a guess.
  async function resolveHasAnyScan(refreshContext?: {
    requestId: number;
    mutationId: number;
    organizationId: string | null;
  }): Promise<void> {
    if (hasAnyScan.peek() !== null) return;
    try {
      const data = await listScans({ filter: "all", limit: 1 });
      if (
        refreshContext &&
        !isCurrentRefresh(
          refreshContext.requestId,
          refreshContext.mutationId,
          refreshContext.organizationId,
        )
      ) {
        return;
      }
      hasAnyScan.value = data.scans.length > 0;
    } catch {
      // Leave unknown.
    }
  }

  function hasDecidedScan(list: ScanListItem[]): boolean {
    return list.some((scan) => Boolean(scan.decision));
  }

  // Two one-row probes for the question the list cannot answer: the dashboard
  // defaults to the "undecided" filter, so a page of undecided reviews says
  // nothing about whether anything was ever decided. Approvals are asked about
  // first and short-circuit, so the common case is a single request. Failure
  // leaves `hasAnyDecision` null, which renders nothing — the funnel is never
  // ticked, or shown, on a guess.
  async function probeHasAnyDecision(): Promise<void> {
    const organizationId = activeOrganizationId.peek();
    const generation = decisionProbeGeneration;
    try {
      for (const decisionFilter of ["publish", "no_publish"] as const) {
        const data = await listScans({ filter: decisionFilter, limit: 1 });
        if (
          activeOrganizationId.peek() !== organizationId ||
          generation !== decisionProbeGeneration
        ) {
          return;
        }
        if (data.scans.length > 0) {
          hasAnyDecision.value = true;
          return;
        }
      }
      hasAnyDecision.value = false;
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

  effect(() => {
    const organizationId = activeOrganizationId.value;
    if (organizationId === onboardingOrganizationId) return;
    onboardingOrganizationId = organizationId;
    ++decisionProbeGeneration;
    decisionProbe = null;
    hasAnyScan.value = null;
    hasAnyDecision.value = null;
  });

  effect(() => {
    const request = registryStatusRefreshRequest.value;
    if (request === 0) return;

    const organizationId = activeOrganizationId.peek();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const delays = [1_000, 4_000, 10_000, 25_000];
    const refreshNext = async (index: number) => {
      if (disposed || index >= delays.length) return;
      timer = setTimeout(async () => {
        if (disposed || activeOrganizationId.peek() !== organizationId) return;
        await refresh({ preserveLoaded: true });
        if (!disposed && activeOrganizationId.peek() === organizationId) {
          void refreshNext(index + 1);
        }
      }, delays[index]);
    };
    void refreshNext(0);

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  });

  return {
    scans,
    loaded,
    refreshing,
    loadingMore,
    filter,
    nextCursor,
    error,
    requiredApprovals,
    decisionStatus,
    decisionError,
    deleteStatus,
    deleteError,
    hasAnyScan,
    hasAnyDecision,
    refresh,

    /**
     * Settle the funnel's last step. Called by the getting-started panel only,
     * so an organization that is past onboarding never spends a request on it.
     * Concurrent callers share one probe.
     */
    async resolveHasAnyDecision(): Promise<void> {
      if (hasAnyDecision.peek() !== null) return;
      if (hasDecidedScan(scans.peek())) {
        hasAnyDecision.value = true;
        return;
      }
      if (!decisionProbe) {
        const probe = probeHasAnyDecision();
        const tracked = probe.finally(() => {
          if (decisionProbe === tracked) decisionProbe = null;
        });
        decisionProbe = tracked;
      }
      await decisionProbe;
    },

    scheduleRegistryStatusRefreshes(): void {
      registryStatusRefreshRequest.value += 1;
    },

    async loadMore(): Promise<void> {
      const cursor = this.nextCursor.value;
      if (!cursor || this.loadingMore.value || this.refreshing.value) return;
      const mutationId = ++listMutationId;
      const organizationId = activeOrganizationId.peek();
      const currentFilter = this.filter.peek();
      this.loadingMore.value = true;
      try {
        const data = await listScans({ cursor, filter: currentFilter });
        if (
          mutationId !== listMutationId ||
          activeOrganizationId.peek() !== organizationId ||
          this.filter.peek() !== currentFilter ||
          this.nextCursor.peek() !== cursor
        ) {
          return;
        }
        this.scans.value = [...this.scans.value, ...data.scans];
        this.nextCursor.value = data.nextCursor;
        this.error.value = null;
      } catch (err) {
        if (mutationId === listMutationId && activeOrganizationId.peek() === organizationId) {
          this.error.value = errorMessage(err);
        }
      } finally {
        this.loadingMore.value = false;
      }
    },

    async setDecision(
      id: string,
      decision: ScanDecision,
      reason: string | null,
    ): Promise<Awaited<ReturnType<typeof setScanDecision>> | null> {
      this.decisionStatus.value = "saving";
      this.decisionError.value = null;
      try {
        const updated = await setScanDecision(id, decision, reason);
        // Fence out a refresh that started before this authoritative write.
        ++listMutationId;
        ++decisionProbeGeneration;
        const activeFilter = this.filter.peek();
        this.scans.value = this.scans.value
          .map((scan) =>
            scan.id === id
              ? {
                  ...scan,
                  ...updated.scan,
                  approvalCount: updated.approvals?.approvedCount ?? scan.approvalCount,
                  legacyDecision: updated.approvals?.legacyDecision ?? scan.legacyDecision,
                  riskSummary: updated.riskSummary ?? updated.scan.riskSummary ?? scan.riskSummary,
                }
              : scan,
          )
          .filter((scan) => scanMatchesDecisionFilter(scan, activeFilter));
        // The funnel's last step, ticked by the write that completes it — the
        // row itself is usually filtered out of the list a line above.
        this.hasAnyDecision.value = true;
        this.decisionStatus.value = "idle";
        return updated;
      } catch (err) {
        this.decisionError.value = errorMessage(err);
        this.decisionStatus.value = "error";
        return null;
      }
    },

    async deleteFailed(id: string): Promise<boolean> {
      this.deleteStatus.value = "deleting";
      this.deleteError.value = null;
      try {
        await deleteScan(id);
        // Do not let an older list response resurrect the deleted row.
        ++listMutationId;
        ++decisionProbeGeneration;
        this.scans.value = this.scans.value.filter((scan) => scan.id !== id);
        // Deleting the organization's only scan puts it back in the
        // never-scanned state, so the getting-started panel has to come back.
        // An emptied list is not enough on its own — the active filter may just
        // have nothing in it — so re-probe instead of assuming. One row, and it
        // leaves the list alone.
        if (this.scans.value.length === 0) {
          this.hasAnyScan.value = null;
          await resolveHasAnyScan();
          // Same reasoning for the funnel's last step: with the list emptied,
          // what is known about decisions came from rows that may be gone.
          decisionProbe = null;
          this.hasAnyDecision.value = this.hasAnyScan.peek() === false ? false : null;
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
