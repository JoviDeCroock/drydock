/**
 * The dashboard overview strip's data: one aggregate read per organization.
 */
import { createModel, effect, signal } from "@preact/signals";
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

  // Figures belong to one organization. Switching drops them before the new
  // request answers, so the strip cannot show the previous organization's
  // queue under the new name; an in-flight answer is discarded on arrival.
  let organizationId = activeOrganizationId.peek();
  effect(() => {
    const next = activeOrganizationId.value;
    if (next === organizationId) return;
    organizationId = next;
    overview.value = null;
    loaded.value = false;
    error.value = null;
  });

  return {
    overview,
    loaded,
    refreshing,
    error,
    refresh(): Promise<void> {
      const organizationId = activeOrganizationId.peek();
      if (inflight && inflight.organizationId === organizationId) return inflight.promise;
      const promise = fetchOverview(organizationId);
      inflight = { organizationId, promise };
      return promise;
    },
  };
});
