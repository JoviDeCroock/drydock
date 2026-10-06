import { computed, createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export interface PublicationWatch {
  id: string;
  organizationId: string;
  packageName: string;
  source: "manual" | "staged_discovery" | "published_history";
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  unresolvedAlertCount: number;
  ownershipConflict?: boolean;
  managementPending?: boolean;
  /** Releases observed since enrollment, alerts or not. */
  releaseCount: number;
  /** A package-wide reason no release can be verified, and since when. */
  coverageGap: string | null;
  coverageGapSince: string | null;
  /** When the observations' dist-tags were last read from npm. */
  distTagsCheckedAt: string | null;
  /** Releases that have stayed unverifiable, with nothing vouching, past the gap threshold. */
  unverifiedReleaseCount: number;
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
  /** Why an `unknown` observation is unknown, or what refines an alert. */
  reason: string | null;
  scanId: string | null;
  /** The published version this release follows, when it has one. */
  previousVersion: string | null;
  /**
   * Dist-tags pointing at this version as of the watch's `distTagsCheckedAt`;
   * null when unknown (not yet read, or npm listed more tags than are read).
   */
  distTags: string[] | null;
  /** Unverifiable with nothing vouching for longer than the gap threshold. */
  coverageGap: boolean;
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
/**
 * Watches revealed per step. The list is bounded by the watch limit, so it
 * arrives whole in the server's attention-first order and pages client-side.
 */
export const WATCH_PAGE_SIZE = 25;
/** The server's code for a personal claim still awaiting its Keep or Move choice. */
export const MANAGEMENT_REQUIRED = "package_management_required";
export type EnrollOutcome = "watched" | "management_required" | null;

export const PublicationWatchesModel = createModel(() => {
  const watches = signal<PublicationWatch[]>([]);
  const autoEnrollment = signal<AutoEnrollmentInfo>({ deferred: 0, suggestions: [] });
  const detail = signal<WatchDetail | null>(null);
  const packageName = signal("");
  const busy = signal(false);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const shownWatchCount = signal(WATCH_PAGE_SIZE);
  const visibleWatches = computed(() => watches.value.slice(0, shownWatchCount.value));
  const hiddenWatchCount = computed(() =>
    Math.max(0, watches.value.length - shownWatchCount.value),
  );
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

  /** Resolves once `busy` is false; a queued follow-up refresh may start right after. */
  function whenIdle(): Promise<void> {
    if (!busy.peek()) return Promise.resolve();
    return new Promise((resolve) => {
      // The first, synchronous call sees `busy` true, so `stop` is assigned
      // before the call that uses it.
      const stop = busy.subscribe((value) => {
        if (value) return;
        stop();
        resolve();
      });
    });
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
    shownWatchCount.value = WATCH_PAGE_SIZE;
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
    visibleWatches,
    hiddenWatchCount,
    autoEnrollment,
    detail,
    packageName,
    busy,
    loaded,
    error,
    refresh,
    show,
    showMoreWatches() {
      shownWatchCount.value += WATCH_PAGE_SIZE;
    },
    /**
     * Watches a package. In a personal workspace the explicit action is the
     * workspace choice the server asks for; a personal claim that still needs
     * its Keep or Move choice answers "management_required" instead of an error.
     */
    async enroll(
      suggestedPackageName?: string,
      options: {
        confirmPersonalOrganization?: boolean;
        /**
         * Wait behind in-flight work instead of being dropped as a duplicate:
         * for a programmatic retry no disabled button guards, such as the
         * watch that follows a management choice.
         */
        wait?: boolean;
      } = {},
    ): Promise<EnrollOutcome> {
      const name = (suggestedPackageName ?? packageName.peek()).trim();
      if (!name) return null;
      if (options.wait) {
        const current = generation;
        while (busy.peek()) {
          await whenIdle();
          // An organization switch clears `busy`; the retry belongs to the old one.
          if (current !== generation) return null;
        }
      }
      let outcome: EnrollOutcome = null;
      await run(
        async () => {
          try {
            return await apiJson<{ watch: PublicationWatch }>(
              endpoint,
              options.confirmPersonalOrganization
                ? { packageName: name, confirmPersonalOrganization: true }
                : { packageName: name },
            );
          } catch (err) {
            if (err instanceof ApiError && err.code === MANAGEMENT_REQUIRED) return null;
            throw err;
          }
        },
        (data) => {
          if (!data) {
            outcome = "management_required";
            return;
          }
          const { watch } = data;
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
          outcome = "watched";
        },
      );
      return outcome;
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
