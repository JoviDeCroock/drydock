import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PublicAtpmPublisher {
  id: string;
  did: string;
  handle: string | null;
  pds: string;
  verificationMethod: string;
  verifiedAt: string;
  lastSweptAt: string | null;
  createdAt: string;
}

export interface AtpmDiscoveryResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
}

export type AtpmPublisherStatus = "idle" | "connecting" | "discovering" | "removing";

/**
 * Connected atpm publishing accounts.
 *
 * "Connect" here does not mean Drydock gains access to the account — every
 * record it reads afterwards is public, and it never writes. The sign-in proves
 * the account is yours, which is what makes it right to put its releases in
 * this organization's dashboard. No token from that sign-in is kept.
 */
export const AtpmPublishersModel = createModel(() => {
  const publishers = signal<PublicAtpmPublisher[]>([]);
  const loaded = signal(false);
  const status = signal<AtpmPublisherStatus>("idle");
  const error = signal<string | null>(null);
  const notice = signal<string | null>(null);
  const publisherInput = signal("");
  const lastDiscovery = signal<AtpmDiscoveryResult | null>(null);

  const busy = computed(() => status.value !== "idle");
  const canConnect = computed(() => publisherInput.value.trim().length > 0 && !busy.value);

  return {
    publishers,
    loaded,
    status,
    error,
    notice,
    publisherInput,
    lastDiscovery,
    busy,
    canConnect,

    async load(): Promise<void> {
      try {
        const data = await apiFetch<{ publishers: PublicAtpmPublisher[] }>(
          "/api/v1/atpm/publishers",
        );
        publishers.value = data.publishers;
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        loaded.value = true;
      }
    },

    /**
     * Start the sign-in. The server pushes the authorization request and hands
     * back a URL; the browser leaves for the account's own server and comes back
     * to the callback route, so there is nothing to poll here.
     */
    async connect(): Promise<void> {
      if (!canConnect.value) return;
      // Read before the await: a signal read afterwards is outside the tracked
      // scope, and the value could have changed while the request was in
      // flight.
      const publisher = publisherInput.peek().trim();
      status.value = "connecting";
      error.value = null;
      try {
        const data = await apiJson<{ authorizationUrl: string }>(
          "/api/v1/atpm/publishers/connect",
          { publisher },
        );
        window.location.assign(data.authorizationUrl);
      } catch (err) {
        error.value = errorMessage(err);
        status.value = "idle";
      }
    },

    /**
     * Surface the outcome of the sign-in redirect. The callback route cannot
     * return a body — it is a browser redirect — so it carries its result in
     * one-shot query params the settings page strips after reading.
     */
    noteCallback(connected: string | undefined, failure: string | undefined): void {
      if (connected) {
        notice.value = `Connected ${connected.startsWith("did:") ? connected : `@${connected}`}.`;
        error.value = null;
        loaded.value = false;
      } else if (failure) {
        error.value = failure;
        notice.value = null;
      }
    },

    async remove(id: string): Promise<void> {
      status.value = "removing";
      error.value = null;
      try {
        await apiFetch<{ ok: true }>(`/api/v1/atpm/publishers/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        publishers.value = publishers.peek().filter((row) => row.id !== id);
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        status.value = "idle";
      }
    },

    /**
     * Look now rather than waiting for the sweep. Worth having even with the
     * live subscription running: a candidate staged while Drydock was
     * reconnecting is otherwise only picked up on the next tick, and a staged
     * release can be approved and gone before then.
     */
    async discover(id: string): Promise<void> {
      status.value = "discovering";
      error.value = null;
      notice.value = null;
      try {
        const result = await apiJson<AtpmDiscoveryResult>(
          `/api/v1/atpm/publishers/${encodeURIComponent(id)}/discover`,
          {},
        );
        lastDiscovery.value = result;
        notice.value =
          result.created > 0
            ? `Queued ${result.created} staged release${result.created === 1 ? "" : "s"} for review.`
            : result.found > 0
              ? "Every staged release for this account has already been reviewed."
              : "No staged releases are waiting for this account.";
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        status.value = "idle";
      }
    },
  };
});
