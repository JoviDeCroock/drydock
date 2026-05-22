import { createModel, signal } from "@preact/signals";
import type { StagedPublishItem, StagedPublishesPage } from "../../server/lib/staged-publishes";
import { apiFetch } from "./api";

export type { StagedPublishItem, StagedPublishesPage };

export function listStagedPublishes(): Promise<StagedPublishesPage> {
  return apiFetch<StagedPublishesPage>("/api/v1/staged-publishes");
}

export const StagedPublishesModel = createModel(() => {
  const items = signal<StagedPublishItem[]>([]);
  const loaded = signal(false);
  const refreshing = signal(false);
  const error = signal<string | null>(null);

  return {
    items,
    loaded,
    refreshing,
    error,

    async refresh(): Promise<void> {
      this.refreshing.value = true;
      try {
        const page = await listStagedPublishes();
        this.items.value = page.items;
        this.error.value = null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loaded.value = true;
        this.refreshing.value = false;
      }
    },
  };
});
