import { createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PublicationWatch {
  id: string;
  packageName: string;
  source: "manual" | "staged_discovery" | "published_history";
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  unresolvedAlertCount: number;
}

export interface PublicationObservation {
  id: string;
  acknowledgedAt: string | null;
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

export interface AutoEnrollmentInfo {
  deferred: number;
  suggestions: Array<{ packageName: string }>;
}

interface WatchDetail {
  watch: PublicationWatch;
  observations: PublicationObservation[];
}

const endpoint = "/api/v1/publication-watches";

export const PublicationWatchesModel = createModel(() => {
  const watches = signal<PublicationWatch[]>([]);
  const autoEnrollment = signal<AutoEnrollmentInfo>({ deferred: 0, suggestions: [] });
  const detail = signal<WatchDetail | null>(null);
  const packageName = signal("");
  const busy = signal(false);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  let generation = 0;
  let refreshPending = false;

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
        if (refreshPending) {
          refreshPending = false;
          await refresh();
        }
      }
    }
  }

  function refresh(): Promise<void> {
    if (busy.peek()) {
      refreshPending = true;
      return Promise.resolve();
    }
    return run(
      () => apiFetch<{ watches: PublicationWatch[]; autoEnrollment: AutoEnrollmentInfo }>(endpoint),
      (data) => {
        watches.value = data.watches;
        autoEnrollment.value = data.autoEnrollment;
        const selected = detail.peek();
        const selectedWatch =
          selected && data.watches.find((watch) => watch.id === selected.watch.id);
        detail.value = selected && selectedWatch ? { ...selected, watch: selectedWatch } : null;
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
    refreshPending = false;
    watches.value = [];
    autoEnrollment.value = { deferred: 0, suggestions: [] };
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
    autoEnrollment,
    detail,
    packageName,
    busy,
    loaded,
    error,
    refresh,
    show,
    enroll(suggestedPackageName?: string) {
      const name = (suggestedPackageName ?? packageName.peek()).trim();
      if (!name) return Promise.resolve();
      return run(
        () => apiJson<{ watch: PublicationWatch }>(endpoint, { packageName: name }),
        ({ watch }) => {
          watches.value = [watch, ...watches.peek().filter((existing) => existing.id !== watch.id)];
          if (suggestedPackageName === undefined) packageName.value = "";
          autoEnrollment.value = {
            ...autoEnrollment.peek(),
            suggestions: autoEnrollment
              .peek()
              .suggestions.filter((suggestion) => suggestion.packageName !== watch.packageName),
          };
          detail.value = null;
          refreshPending = true;
        },
      );
    },
    acknowledge(watchId: string, observationId: string) {
      return run(
        () =>
          apiFetch<WatchDetail>(
            `${endpoint}/${encodeURIComponent(watchId)}/observations/${encodeURIComponent(observationId)}/acknowledge`,
            { method: "POST" },
          ),
        (data) => {
          watches.value = watches
            .peek()
            .map((watch) => (watch.id === data.watch.id ? data.watch : watch));
          if (detail.peek()?.watch.id === watchId) detail.value = data;
        },
      );
    },
    remove(id: string) {
      return run(
        () => apiFetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" }),
        () => {
          watches.value = watches.peek().filter((watch) => watch.id !== id);
          if (detail.peek()?.watch.id === id) detail.value = null;
          refreshPending = true;
        },
      );
    },
  };
});
