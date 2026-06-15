import { createModel, signal } from "@preact/signals";
import type { StagedPublishesScanResponse } from "../../server/lib/staged-publishes";
import { trackProductEvent } from "../lib/analytics";
import { apiFetch, errorMessage } from "./api";

export type { StagedPublishesScanResponse };

export function startStagedPublishScans(): Promise<StagedPublishesScanResponse> {
  return apiFetch<StagedPublishesScanResponse>("/api/v1/staged-publishes/scan", {
    method: "POST",
  });
}

export const StagedPublishesModel = createModel(() => {
  const lastResult = signal<StagedPublishesScanResponse | null>(null);
  const lastDiscoveryAt = signal<number | null>(null);
  const loaded = signal(false);
  const refreshing = signal(false);
  const error = signal<string | null>(null);

  return {
    lastResult,
    lastDiscoveryAt,
    loaded,
    refreshing,
    error,

    reset(): void {
      this.lastResult.value = null;
      this.lastDiscoveryAt.value = null;
      this.loaded.value = false;
      this.error.value = null;
    },

    async discover(): Promise<StagedPublishesScanResponse | null> {
      this.refreshing.value = true;
      trackProductEvent("staged_publish_discovery_started");
      try {
        const result = await startStagedPublishScans();
        this.lastResult.value = result;
        this.lastDiscoveryAt.value = Date.now();
        this.error.value = null;
        trackProductEvent("staged_publish_discovery_completed", {
          found: result.found,
          created: result.created,
          skipped: result.skipped,
          queued: result.queued,
        });
        return result;
      } catch (err) {
        this.error.value = errorMessage(err);
        trackProductEvent("staged_publish_discovery_failed");
        return null;
      } finally {
        this.loaded.value = true;
        this.refreshing.value = false;
      }
    },
  };
});
