import { createModel, signal } from "@preact/signals";
import type { StagedPublishesScanResponse } from "../../server/lib/staged-publishes";
import { apiFetch } from "./api";
import { runAction } from "./async-action";

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
      try {
        return (
          (await runAction({
            status: this.refreshing,
            error: this.error,
            pending: true,
            idle: false,
            run: async () => {
              const result = await startStagedPublishScans();
              this.lastResult.value = result;
              this.lastDiscoveryAt.value = Date.now();
              this.error.value = null;
              return result;
            },
          })) ?? null
        );
      } finally {
        this.loaded.value = true;
      }
    },
  };
});
