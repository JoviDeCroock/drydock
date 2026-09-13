import { createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PublicationWatch {
  id: string;
  packageName: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface PublicationObservation {
  version: string;
  publishedAt: string | null;
  firstSeenAt: string;
  checkedAt: string;
  status:
    | "approved_match"
    | "published_without_approval"
    | "published_despite_rejection"
    | "artifact_mismatch"
    | "unknown";
  scanId: string | null;
}

interface WatchDetail {
  watch: PublicationWatch;
  observations: PublicationObservation[];
}

const endpoint = "/api/v1/publication-watches";

export const PublicationWatchesModel = createModel(() => {
  const watches = signal<PublicationWatch[]>([]);
  const detail = signal<WatchDetail | null>(null);
  const packageName = signal("");
  const busy = signal(false);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  let generation = 0;

  async function run<T>(request: () => Promise<T>, apply: (data: T) => void): Promise<void> {
    if (busy.peek()) return;
    const current = generation;
    busy.value = true;
    error.value = null;
    try {
      const data = await request();
      if (current === generation) apply(data);
    } catch (err) {
      if (current === generation) error.value = errorMessage(err);
    } finally {
      if (current === generation) {
        busy.value = false;
        loaded.value = true;
      }
    }
  }

  function refresh() {
    return run(
      () => apiFetch<{ watches: PublicationWatch[] }>(endpoint),
      (data) => {
        watches.value = data.watches;
        detail.value = null;
      },
    );
  }

  function show(id: string, check = false) {
    return run(
      () =>
        apiFetch<WatchDetail>(
          `${endpoint}/${encodeURIComponent(id)}${check ? "/check" : ""}`,
          check ? { method: "POST" } : undefined,
        ),
      (data) => {
        watches.value = watches
          .peek()
          .map((watch) => (watch.id === data.watch.id ? data.watch : watch));
        detail.value = data;
      },
    );
  }

  effect(() => {
    void activeOrganizationId.value;
    watches.value = [];
    detail.value = null;
    packageName.value = "";
    error.value = null;
    busy.value = false;
    loaded.value = false;
    void refresh();
    // Invalidate even A → B → A requests and responses arriving after disposal.
    return () => {
      generation++;
    };
  });

  return {
    watches,
    detail,
    packageName,
    busy,
    loaded,
    error,
    refresh,
    show,
    enroll() {
      const name = packageName.peek().trim();
      if (!name) return Promise.resolve();
      return run(
        () => apiJson<{ watch: PublicationWatch }>(endpoint, { packageName: name }),
        ({ watch }) => {
          watches.value = [watch, ...watches.peek().filter((existing) => existing.id !== watch.id)];
          packageName.value = "";
          detail.value = null;
        },
      );
    },
    remove(id: string) {
      return run(
        () => apiFetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" }),
        () => {
          watches.value = watches.peek().filter((watch) => watch.id !== id);
          if (detail.peek()?.watch.id === id) detail.value = null;
        },
      );
    },
  };
});
