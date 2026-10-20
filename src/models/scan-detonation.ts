/**
 * The beta detonation sandbox for one scan: its latest run, the polling that
 * carries a queued run to a terminal status, and the rerun request.
 *
 * Outside the beta the endpoint answers `{ eligible: false, detonation: null }`,
 * which renders nothing. A 404 (an older server, or a scan gone mid-poll) is
 * treated the same way (`hidden`), not as an error.
 */
import { computed, createModel, effect, signal } from "@preact/signals";
import type {
  DetonationErrorCode,
  DetonationResult,
  DetonationStatus,
} from "../../server/lib/detonation/types";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export interface ScanDetonationRun {
  status: DetonationStatus;
  /** Still queued/running past the server's stale window; polling stops. */
  stale: boolean;
  result: DetonationResult | null;
  errorCode: DetonationErrorCode | null;
  artifactSha256: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ScanDetonationResponse {
  /** Whether this scan can be (re)run; a finished run may outlive eligibility. */
  eligible: boolean;
  detonation: ScanDetonationRun | null;
}

export const DETONATION_POLL_DELAY_MS = 5_000;
const DETONATION_POLL_MAX_DELAY_MS = 30_000;

function detonationUrl(scanId: string): string {
  return `/api/v1/scans/${encodeURIComponent(scanId)}/detonation`;
}

function isDetonationLive(run: ScanDetonationRun | null): boolean {
  return Boolean(run && !run.stale && (run.status === "queued" || run.status === "running"));
}

function rerunErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "A run is already in progress.";
    if (err.status === 429) return "This organization has hit the hourly run limit. Try later.";
    if (err.status === 404) return "This scan can no longer be detonated.";
  }
  return `Could not start the run: ${errorMessage(err)}`;
}

export const ScanDetonationModel = createModel((scanId: string) => {
  const data = signal<ScanDetonationResponse | null>(null);
  // Outside the beta, or no run and nothing eligible to run.
  const hidden = signal(false);
  const loadError = signal<string | null>(null);
  const requesting = signal(false);
  const requestError = signal<string | null>(null);
  let disposed = false;

  const run = computed(() => data.value?.detonation ?? null);
  const live = computed(() => isDetonationLive(run.value));

  async function load(): Promise<boolean> {
    try {
      const next = await apiFetch<ScanDetonationResponse>(detonationUrl(scanId));
      if (disposed) return true;
      data.value = next;
      loadError.value = null;
      return true;
    } catch (err) {
      if (disposed) return false;
      if (err instanceof ApiError && err.status === 404) {
        hidden.value = true;
        return true;
      }
      loadError.value = errorMessage(err);
      return false;
    }
  }

  effect(() => () => {
    disposed = true;
  });

  // Self-scheduling chain rather than setInterval so a failing endpoint backs
  // off; the effect re-runs (and the old chain stops) whenever liveness flips.
  effect(() => {
    if (!live.value) return;
    let stopped = false;
    let delay = DETONATION_POLL_DELAY_MS;
    const tick = async () => {
      const ok = await load();
      if (stopped) return;
      delay = ok ? DETONATION_POLL_DELAY_MS : Math.min(delay * 2, DETONATION_POLL_MAX_DELAY_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    let timer = setTimeout(() => void tick(), delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  void load();

  return {
    data,
    run,
    hidden,
    loadError,
    requesting,
    requestError,
    async requestRun() {
      if (requesting.peek()) return;
      requesting.value = true;
      requestError.value = null;
      try {
        await apiJson<{ ok: true }>(detonationUrl(scanId), {});
      } catch (err) {
        if (!disposed) requestError.value = rerunErrorMessage(err);
      } finally {
        // A 409 means a run exists; reloading shows it either way.
        if (!disposed) {
          await load();
          requesting.value = false;
        }
      }
    },
  };
});
