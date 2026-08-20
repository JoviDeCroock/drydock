import { DurableObject } from "cloudflare:workers";
import { createDb } from "../../../db/client";
import { listAtpmPublishersForDid } from "../../../db/atpm-publishers";
import { getOrganizationOwnerUserId } from "../../../db/organizations";
import { ATPM_STAGE_COLLECTION } from "./stage-record";
import type { AtpmDiscoveryQueueMessage } from "../../scan/job";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";

/**
 * A live subscription to atpm staging, so a release candidate is reviewed while
 * it still exists.
 *
 * Polling alone cannot do this job. atpm deletes a `dev.atpm.alpha.stage`
 * record the moment it is approved, so a candidate staged and approved in the
 * same sitting — the ordinary shape of `npm stage publish && npm stage
 * approve` — is not something a fifteen-minute sweep reviews late. It is
 * something the sweep never sees at all, and nothing afterwards records that a
 * release went unreviewed. The gated path is immune because the deployment
 * blocks; every other path was not.
 *
 * AT Protocol broadcasts every repository commit on the network, and Jetstream
 * filters that stream to one collection server-side, so the whole of atpm
 * staging arrives as a trickle of small JSON events.
 *
 * ## What the firehose is and is not trusted for
 *
 * It is a doorbell. An event supplies one thing — a DID that just wrote a
 * staged record — and that is used only to decide *when to look*. Nothing in
 * the event is read as evidence: the record it carries is ignored, and the
 * discovery path it triggers resolves the publisher's identity, fetches the
 * record from that publisher's own PDS, and verifies every claim exactly as it
 * would have on a cron sweep.
 *
 * That matters because Jetstream is operated by a third party, and this
 * codebase spent real effort avoiding a dependency on atpm.dev for exactly that
 * reason. The distinction is the same one already drawn for the DNS-over-HTTPS
 * resolver in `./identity.ts`: a hostile or broken instance here can make
 * Drydock miss a candidate or waste a lookup, and cannot make it review the
 * wrong bytes or attribute them to the wrong publisher. The cron sweep remains
 * as the backstop for anything a dropped connection missed, which is also what
 * makes it safe for an operator to turn this off entirely.
 */

/**
 * Default Jetstream instance. Overridable so a self-hosted deployment can point
 * at its own instance — or its own relay — rather than inheriting this one.
 */
const DEFAULT_JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";

/** Reconnect backoff, and the alarm cadence that supervises the connection. */
const SUPERVISOR_INTERVAL_MS = 30_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;

/**
 * How long a DID stays quiet after triggering a discovery dispatch.
 *
 * A single `npm stage publish` of a multi-package release writes several
 * records in quick succession, and each one is a separate event. Discovery
 * lists the whole repository anyway, so the second and third event would only
 * repeat work the first already covers. This also bounds what a publisher who
 * writes records in a loop can make Drydock do.
 */
const DID_DEBOUNCE_MS = 20_000;

/**
 * Cursor writes are throttled: it is a resume hint, so replaying a few seconds
 * of events after an eviction is cheaper than a storage write per event.
 */
const CURSOR_WRITE_INTERVAL_MS = 10_000;

/**
 * Cloudflare Queues accepts at most 100 messages per batch. One event fans out
 * to every organization watching that account, which is normally one or two —
 * but the bound belongs here rather than in an assumption about how many
 * organizations might share an interest in a popular publisher.
 */
const MAX_DISPATCH_BATCH = 100;

/** A Jetstream cursor is microseconds since the epoch. */
const CURSOR_KEY = "jetstream-cursor";

interface JetstreamCommitEvent {
  did?: unknown;
  time_us?: unknown;
  kind?: unknown;
  commit?: {
    operation?: unknown;
    collection?: unknown;
    rkey?: unknown;
  };
}

export interface AtpmFirehoseStatus {
  connected: boolean;
  cursor: number | null;
  lastEventAt: string | null;
  dispatched: number;
  reconnects: number;
}

export function atpmFirehoseEnabled(env: Cloudflare.Env): boolean {
  return Boolean(env.ATPM_FIREHOSE) && env.ATPM_FIREHOSE_DISABLED !== "1";
}

/**
 * Ask the firehose to be running. Idempotent, and safe to call on every cron
 * tick: a Durable Object is not started by its own existence, so something has
 * to knock periodically, and the cron is already the thing that runs anyway.
 */
export async function ensureAtpmFirehose(env: Cloudflare.Env): Promise<void> {
  if (!atpmFirehoseEnabled(env)) return;
  const stub = env.ATPM_FIREHOSE!.get(env.ATPM_FIREHOSE!.idFromName("atpm-stage-firehose"));
  await stub.ensureRunning();
}

export class AtpmFirehose extends DurableObject<Cloudflare.Env> {
  private socket: WebSocket | null = null;
  private connecting = false;
  private reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  private cursor: number | null = null;
  private cursorWrittenAtMs = 0;
  private lastEventAtMs: number | null = null;
  private dispatched = 0;
  private reconnects = 0;
  private readonly recentDids = new Map<string, number>();

  /**
   * Start the subscription if it is not already live, and make sure the
   * supervising alarm is set. Called from the cron and from the DO's own alarm.
   */
  async ensureRunning(): Promise<AtpmFirehoseStatus> {
    if (this.cursor === null) {
      this.cursor = (await this.ctx.storage.get<number>(CURSOR_KEY)) ?? null;
    }
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + SUPERVISOR_INTERVAL_MS);
    }
    if (!this.socket && !this.connecting) await this.openSubscription();
    return this.status();
  }

  async status(): Promise<AtpmFirehoseStatus> {
    return {
      connected: this.socket !== null,
      cursor: this.cursor,
      lastEventAt: this.lastEventAtMs === null ? null : new Date(this.lastEventAtMs).toISOString(),
      dispatched: this.dispatched,
      reconnects: this.reconnects,
    };
  }

  /**
   * The supervisor. A Durable Object holding an outbound socket stays resident,
   * but eviction, a dropped connection, and a silently half-open socket all
   * look the same from outside — so the alarm re-arms itself and reconnects
   * whenever there is nothing live.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + SUPERVISOR_INTERVAL_MS);
    if (!this.socket && !this.connecting) await this.openSubscription();
  }

  private subscriptionUrl(): string {
    const base = this.env.ATPM_FIREHOSE_URL || DEFAULT_JETSTREAM_URL;
    const url = new URL(base);
    // Filtering server-side is what makes this cheap: the whole network's
    // firehose narrows to one alpha collection before it reaches the Worker.
    url.searchParams.set("wantedCollections", ATPM_STAGE_COLLECTION);
    if (this.cursor !== null) url.searchParams.set("cursor", String(this.cursor));
    return url.toString();
  }

  private async openSubscription(): Promise<void> {
    this.connecting = true;
    try {
      const response = await fetch(this.subscriptionUrl(), {
        headers: { Upgrade: "websocket" },
      });
      const socket = response.webSocket;
      if (!socket) {
        throw new Error(`firehose did not upgrade (status ${response.status})`);
      }
      socket.accept();
      this.socket = socket;
      this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;

      socket.addEventListener("message", (event) => {
        void this.onMessage(event.data).catch((err) => {
          emitOperationalEvent("warn", "atpm_firehose.event_failed", {
            error: describeOperationalError(err),
          });
        });
      });
      const drop = () => this.onDisconnected();
      socket.addEventListener("close", drop);
      socket.addEventListener("error", drop);

      emitOperationalEvent("info", "atpm_firehose.connected", { cursor: this.cursor });
    } catch (err) {
      this.socket = null;
      // Back off, but never past the supervisor's own cadence by so much that a
      // long outage leaves the subscription down indefinitely.
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
      emitOperationalEvent("warn", "atpm_firehose.connect_failed", {
        error: describeOperationalError(err),
        retryInMs: this.reconnectDelayMs,
      });
    } finally {
      this.connecting = false;
    }
  }

  private onDisconnected(): void {
    if (!this.socket) return;
    this.socket = null;
    this.reconnects++;
    emitOperationalEvent("info", "atpm_firehose.disconnected", { cursor: this.cursor });
    // The alarm is already armed; letting it do the reconnect keeps one path
    // responsible for reconnection instead of racing two.
  }

  private async onMessage(data: unknown): Promise<void> {
    if (typeof data !== "string") return;
    let event: JetstreamCommitEvent;
    try {
      event = JSON.parse(data) as JetstreamCommitEvent;
    } catch {
      return;
    }

    this.lastEventAtMs = Date.now();
    if (typeof event.time_us === "number" && Number.isSafeInteger(event.time_us)) {
      this.cursor = event.time_us;
      if (this.lastEventAtMs - this.cursorWrittenAtMs > CURSOR_WRITE_INTERVAL_MS) {
        this.cursorWrittenAtMs = this.lastEventAtMs;
        await this.ctx.storage.put(CURSOR_KEY, this.cursor);
      }
    }

    if (event.kind !== "commit") return;
    const commit = event.commit;
    if (!commit || commit.collection !== ATPM_STAGE_COLLECTION) return;
    // A delete is an approval or a withdrawal; either way the candidate is
    // gone and there is nothing left to review.
    if (commit.operation !== "create" && commit.operation !== "update") return;

    const did = typeof event.did === "string" ? event.did : null;
    if (!did) return;
    if (this.isDebounced(did)) return;

    await this.dispatchDiscovery(did);
  }

  private isDebounced(did: string): boolean {
    const now = Date.now();
    for (const [key, at] of this.recentDids) {
      if (now - at > DID_DEBOUNCE_MS) this.recentDids.delete(key);
    }
    if (this.recentDids.has(did)) return true;
    this.recentDids.set(did, now);
    return false;
  }

  /**
   * Turn "this account just staged something" into a discovery job for each
   * organization that enrolled it.
   *
   * The overwhelming majority of events resolve to nothing — Drydock watches a
   * handful of accounts and the stream carries every one on the network — so
   * this is an indexed lookup that usually returns an empty set and stops.
   */
  private async dispatchDiscovery(did: string): Promise<void> {
    const db = createDb(this.env.DB);
    const publishers = await listAtpmPublishersForDid(db, did);
    if (!publishers.length) return;

    const messages: AtpmDiscoveryQueueMessage[] = [];
    for (const publisher of publishers) {
      const actorUserId =
        publisher.createdByUserId ??
        (await getOrganizationOwnerUserId(db, publisher.organizationId).catch(() => null));
      if (!actorUserId) continue;
      messages.push({
        kind: "atpm_discovery",
        organizationId: publisher.organizationId,
        actorUserId,
        // The DID, never the handle: the event named a repository, and a handle
        // would reintroduce a resolution step that could point elsewhere.
        publisherRef: publisher.did,
        source: "auto_discovery",
      });
    }
    if (!messages.length) return;

    // Without a queue there is nothing to hand the work to, and the firehose
    // must not run scans itself: it is a long-lived object holding a socket,
    // and the pipeline is exactly the kind of work that would tie it up.
    if (!this.env.SCAN_QUEUE) {
      emitOperationalEvent("warn", "atpm_firehose.no_queue", { did, dropped: messages.length });
      return;
    }
    for (let start = 0; start < messages.length; start += MAX_DISPATCH_BATCH) {
      await this.env.SCAN_QUEUE.sendBatch(
        messages
          .slice(start, start + MAX_DISPATCH_BATCH)
          .map((body) => ({ body, contentType: "json" as const })),
      );
    }
    this.dispatched += messages.length;
    emitOperationalEvent("info", "atpm_firehose.dispatched", {
      did,
      organizations: messages.length,
    });
  }
}
