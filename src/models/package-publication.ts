/**
 * One package's publication monitoring for the package page: whether the
 * active organization watches it (and if not, why), its observed releases,
 * and the watch lifecycle actions. The server decides who may stop a watch;
 * `canStop` only mirrors that so the page can explain a disabled control.
 */
import { computed, createModel, effect, signal } from "@preact/signals";
import { encodePackageName } from "../lib/package-diff-path";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";
import {
  publicationReviewApiPath,
  type PostReleaseResolution,
  type PublicationObservation,
  type PublicationWatch,
} from "./publication-watches";

export type PublicationEnrollment =
  | { state: "watched" }
  | { state: "stopped"; stoppedAt: string }
  | { state: "suggested" }
  | { state: "pending" }
  | { state: "deferred" }
  | { state: "not_enrolled" };

/** One entry of the organization's alert ledger for the package, across watches. */
export interface PublicationAlertRecord {
  version: string;
  status: Exclude<PublicationObservation["status"], "approved_match" | "unknown">;
  createdAt: string;
  acknowledgedAt: string | null;
  /** Raised in the current watch's observation window rather than an earlier one. */
  inCurrentWatch: boolean;
  /** The post-release review linked to the alert, and how it resolved it. */
  reviewScanId: string | null;
  resolution: PostReleaseResolution | null;
  resolvedAt: string | null;
}

export interface PackagePublication {
  packageName: string;
  watch: PublicationWatch | null;
  observations: PublicationObservation[];
  /** The latest alerts, newest first; `moreAlerts` says older ones exist. */
  alerts: PublicationAlertRecord[];
  moreAlerts: boolean;
  enrollment: PublicationEnrollment;
  viewer: { canStop: boolean };
}

const endpoint = "/api/v1/publication-watches";

export function packagePublicationApiPath(packageName: string): string {
  return `${endpoint}/packages/${encodePackageName(packageName)}`;
}

export const PackagePublicationModel = createModel((packageName: string) => {
  const publication = signal<PackagePublication | null>(null);
  const loaded = signal(false);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const canStop = computed(() => publication.value?.viewer.canStop ?? false);
  // An organization switch mid-request must not land the previous
  // organization's watch in the new one's view.
  let generation = 0;

  async function run(request: () => Promise<void>): Promise<void> {
    if (busy.peek()) return;
    const current = generation;
    busy.value = true;
    error.value = null;
    try {
      await request();
    } catch (err) {
      if (current === generation) error.value = errorMessage(err);
    } finally {
      if (current === generation) {
        busy.value = false;
        loaded.value = true;
      }
    }
  }

  async function read(current: number) {
    const data = await apiFetch<PackagePublication>(packagePublicationApiPath(packageName));
    if (current === generation) publication.value = data;
  }

  /** Apply a watch detail response from check or acknowledge in place. */
  function applyDetail(
    current: number,
    detail: { watch: PublicationWatch; observations: PublicationObservation[] },
  ) {
    const existing = publication.peek();
    if (current !== generation || !existing) return;
    publication.value = { ...existing, watch: detail.watch, observations: detail.observations };
  }

  function watchId(): string | null {
    return publication.peek()?.watch?.id ?? null;
  }

  effect(() => {
    void activeOrganizationId.value;
    generation++;
    publication.value = null;
    loaded.value = false;
    error.value = null;
    busy.value = false;
    const current = generation;
    void run(() => read(current));
    return () => {
      generation++;
    };
  });

  return {
    publication,
    loaded,
    busy,
    error,
    canStop,
    check() {
      const id = watchId();
      if (!id) return Promise.resolve();
      const current = generation;
      return run(async () =>
        applyDetail(
          current,
          await apiFetch(`${endpoint}/${encodeURIComponent(id)}/check`, { method: "POST" }),
        ),
      );
    },
    acknowledge(observationId: string) {
      const id = watchId();
      if (!id) return Promise.resolve();
      const current = generation;
      return run(async () =>
        applyDetail(
          current,
          await apiFetch(
            `${endpoint}/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/acknowledge`,
            { method: "POST" },
          ),
        ),
      );
    },
    /**
     * Start the alert's post-release review, or find the one already linked to
     * it. Resolves to the review's scan id, or null when it failed (the error
     * signal says why) or the organization changed meanwhile.
     */
    async review(observationId: string): Promise<string | null> {
      const id = watchId();
      if (!id) return null;
      const current = generation;
      let scanId: string | null = null;
      await run(async () => {
        const data = await apiFetch<{ scanId: string }>(
          publicationReviewApiPath(id, observationId),
          {
            method: "POST",
          },
        );
        if (current === generation) scanId = data.scanId;
      });
      return scanId;
    },
    start() {
      const current = generation;
      return run(async () => {
        await apiJson(endpoint, { packageName });
        await read(current);
      });
    },
    stop() {
      const id = watchId();
      if (!id) return Promise.resolve();
      const current = generation;
      return run(async () => {
        await apiFetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" });
        await read(current);
      });
    },
  };
});
