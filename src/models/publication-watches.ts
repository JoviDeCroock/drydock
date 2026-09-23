import { createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PublicationWatch {
  id: string;
  organizationId: string;
  packageName: string;
  source: "manual" | "staged_discovery" | "published_history";
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  unresolvedAlertCount: number;
  /** A package-wide reason no release can be verified, and since when. */
  coverageGap: string | null;
  coverageGapSince: string | null;
  /** When the observations' dist-tags were last read from npm. */
  distTagsCheckedAt: string | null;
  /** Releases that have stayed unverifiable, with nothing vouching, past the gap threshold. */
  unverifiedReleaseCount: number;
}

/** How an organization resolved a publication alert by reviewing the release after it. */
export type PostReleaseResolution = "approved_after_release" | "declined_after_release";

/**
 * Whether a post-release decision counts on the public README badge, and if
 * not, why. Only `applied` moves the badge.
 */
export type PostReleaseBadgeEffect =
  | "applied"
  | "not_public_npm"
  | "not_a_verified_publisher"
  | "digests_unavailable"
  | "digests_differ";

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
  /**
   * The post-release review linked to this release's alert, if one was
   * started. Distinct from `scanId`, the staged review that matched the bytes.
   */
  reviewScanId: string | null;
  reviewStatus: "pending" | "running" | "complete" | "failed" | null;
  reviewDecision: "publish" | "no_publish" | null;
  /** Recorded alongside `status`, which stays the historical verdict. */
  resolution: PostReleaseResolution | null;
  resolvedAt: string | null;
  resolutionBadge: PostReleaseBadgeEffect | null;
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

/** Where an alert's post-release review is started, or found when it already exists. */
export function publicationReviewApiPath(watchId: string, observationId: string): string {
  return `${endpoint}/${encodeURIComponent(watchId)}/observations/${encodeURIComponent(observationId)}/review`;
}

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
    /**
     * Start the alert's post-release review, or find the one already linked to
     * it. Resolves to the review's scan id, or null when the request failed or
     * was superseded (the error signal says why).
     */
    async review(watchId: string, observationId: string): Promise<string | null> {
      let scanId: string | null = null;
      await run(
        () =>
          apiFetch<{ scanId: string }>(publicationReviewApiPath(watchId, observationId), {
            method: "POST",
          }),
        (data) => {
          scanId = data.scanId;
        },
      );
      return scanId;
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
