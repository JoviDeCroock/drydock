/**
 * Undecided low-risk staged reviews the organization can approve in one action.
 * The server owns which reviews qualify and re-checks them when approving.
 */
import { createModel, effect, signal } from "@preact/signals";
import type { BatchApprovableScan } from "../../server/db/scans";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export type BatchApprovalCandidate = Omit<BatchApprovableScan, "createdAt"> & {
  createdAt: string;
};

interface BatchApprovalList {
  scans: BatchApprovalCandidate[];
  more: boolean;
}

export interface BatchApprovalResult {
  approved: Array<{ id: string; packageName: string | null; stagedVersion: string | null }>;
  skipped: string[];
}

const endpoint = "/api/v1/scans/batch-approval";

export const ScanBatchApprovalModel = createModel(() => {
  const candidates = signal<BatchApprovalCandidate[]>([]);
  const more = signal(false);
  const saving = signal(false);
  const error = signal<string | null>(null);
  let inflight: { organizationId: string | null; promise: Promise<void> } | null = null;
  // Bumped by every approval: a list read that started before one may still
  // hold the reviews it just approved, so its answer is dropped.
  let generation = 0;

  async function fetchCandidates(organizationId: string | null): Promise<void> {
    const startedAt = generation;
    try {
      const data = await apiFetch<BatchApprovalList>(endpoint);
      if (activeOrganizationId.peek() !== organizationId || startedAt !== generation) return;
      candidates.value = data.scans;
      more.value = data.more;
    } catch {
      // The action is optional: without a list it simply is not offered.
      if (activeOrganizationId.peek() !== organizationId || startedAt !== generation) return;
      candidates.value = [];
      more.value = false;
    } finally {
      if (inflight?.organizationId === organizationId) inflight = null;
    }
  }

  let organizationId = activeOrganizationId.peek();
  effect(() => {
    const next = activeOrganizationId.value;
    if (next === organizationId) return;
    organizationId = next;
    candidates.value = [];
    more.value = false;
    error.value = null;
  });

  return {
    candidates,
    more,
    saving,
    error,
    refresh(): Promise<void> {
      const organizationId = activeOrganizationId.peek();
      if (inflight && inflight.organizationId === organizationId) return inflight.promise;
      const promise = fetchCandidates(organizationId);
      inflight = { organizationId, promise };
      return promise;
    },
    async approve(
      scanIds: readonly string[],
      reason: string | null,
    ): Promise<BatchApprovalResult | null> {
      if (saving.peek()) return null;
      const organizationId = activeOrganizationId.peek();
      saving.value = true;
      error.value = null;
      try {
        const result = await apiJson<BatchApprovalResult>(endpoint, { scanIds, reason });
        if (activeOrganizationId.peek() !== organizationId) return null;
        generation += 1;
        inflight = null;
        const approved = new Set(result.approved.map((row) => row.id));
        candidates.value = candidates.peek().filter((scan) => !approved.has(scan.id));
        return result;
      } catch (err) {
        if (activeOrganizationId.peek() === organizationId) error.value = errorMessage(err);
        return null;
      } finally {
        saving.value = false;
      }
    },
  };
});
