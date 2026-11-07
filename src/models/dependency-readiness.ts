/**
 * One review's dependency-readiness check. Loads once the review reaches a
 * state where approving still lies ahead (`enabled`), and again on request:
 * the answer moves when a sibling stage is approved, so it is never cached
 * across a "Check again".
 */
import { createModel, effect, signal, type ReadonlySignal } from "@preact/signals";
import type { DependencyReadinessResponse } from "../../server/lib/ecosystems/npm/dependency-readiness";
import { apiFetch } from "./api";

export const DependencyReadinessModel = createModel(
  (scanId: string, enabled: ReadonlySignal<boolean>) => {
    const result = signal<DependencyReadinessResponse | null>(null);
    const loading = signal(false);
    // The request itself failed (network, 429, 5xx). Advisory, so the page
    // only says it could not check; it never blocks the decision.
    const failed = signal(false);
    let generation = 0;

    async function load(): Promise<void> {
      const current = ++generation;
      loading.value = true;
      // Resume where the last check stopped, so a release with more
      // dependencies than one check reads finishes across re-checks. Only a
      // hint: the server clamps it.
      const previous = result.peek();
      const offset =
        previous?.status === "checked" && typeof previous.nextOffset === "number"
          ? `?offset=${previous.nextOffset}`
          : "";
      try {
        const data = await apiFetch<DependencyReadinessResponse>(
          `/api/v1/scans/${encodeURIComponent(scanId)}/dependency-readiness${offset}`,
        );
        if (current !== generation) return;
        result.value = data;
        failed.value = false;
      } catch {
        if (current !== generation) return;
        failed.value = true;
      } finally {
        if (current === generation) loading.value = false;
      }
    }

    let requested = false;
    effect(() => {
      if (!enabled.value || requested) return;
      requested = true;
      void load();
    });

    return { result, loading, failed, refresh: load };
  },
);
