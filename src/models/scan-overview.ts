/**
 * The dashboard overview strip's data: one aggregate read per organization.
 */
import { createModel, signal } from "@preact/signals";
import type { ScanOverview } from "../../server/db/scans";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, errorMessage } from "./api";

export type { ScanOverview };

export const ScanOverviewModel = createModel(() => {
  const overview = signal<ScanOverview | null>(null);
  const loaded = signal(false);
  const refreshing = signal(false);
  const error = signal<string | null>(null);
  // The list refresh and the dashboard's own load both ask for the overview
  // at startup and on an organization switch; the second caller joins the
  // first request instead of paying for it twice.
  let inflight: { organizationId: string | null; promise: Promise<void> } | null = null;

  async function fetchOverview(organizationId: string | null): Promise<void> {
    refreshing.value = true;
    try {
      const data = await apiFetch<ScanOverview>("/api/v1/scans/overview");
      if (activeOrganizationId.peek() !== organizationId) return;
      overview.value = data;
      error.value = null;
    } catch (err) {
      if (activeOrganizationId.peek() !== organizationId) return;
      error.value = errorMessage(err);
    } finally {
      if (inflight?.organizationId === organizationId) inflight = null;
      if (activeOrganizationId.peek() === organizationId) {
        loaded.value = true;
        refreshing.value = false;
      }
    }
  }

  return {
    overview,
    loaded,
    refreshing,
    error,
    refresh(): Promise<void> {
      const organizationId = activeOrganizationId.peek();
      if (inflight && inflight.organizationId === organizationId) return inflight.promise;
      if (inflight) {
        // The organization changed under an in-flight request; its answer is
        // discarded on arrival, and the strip must not keep the old one.
        overview.value = null;
        loaded.value = false;
      }
      const promise = fetchOverview(organizationId);
      inflight = { organizationId, promise };
      return promise;
    },
  };
});
