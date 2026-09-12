import { createDb, type AppDb } from "../../db/client";
import { getNpmConnection, listAutoDiscoveryNpmConnectionRefs } from "../../db/npm-connections";
import { getOrganizationOwnerUserId } from "../../db/organizations";
import type { ScanSource } from "../../db/scans";
import { allowInsecureLocalRegistry } from "../ecosystems/npm/connection";
import {
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
  isNpmConnectionAuthFailure,
  isTransientSweepFailure,
  queueStagedPublishCandidates,
  recordExpiredNpmConnection,
  StagedPublishesFetchError,
} from "../ecosystems/npm/staged-publishes-discovery";
import { isValidStageId } from "../ecosystems/npm/stage-id";
import type { StagedPublishItem } from "../ecosystems/npm/staged-publishes";
import { isRecord } from "../platform/guards";
import { errorMessage } from "../platform/errors";
import { utf8Size } from "../platform/stable-json";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";

/**
 * One organization's staged-publish discovery sweep. The consumer re-reads
 * the npm connection from D1, so no token ciphertext or nonce is ever written
 * to a queue.
 */
interface DiscoverySweepQueueMessage {
  kind: "discovery_sweep";
  organizationId: string;
  /** @deprecated Accepted only to drain cursor messages from an older deploy. */
  afterStageId?: string;
  /** @deprecated Accepted only to drain cursor messages from an older deploy. */
  source?: Extract<ScanSource, "manual" | "auto_discovery">;
  /** @deprecated Accepted only to drain cursor messages from an older deploy. */
  actorUserId?: string;
}

interface DiscoveryScanCandidate {
  stageId: string;
  packageName: string | null;
  version: string | null;
}

/** One independent bounded slice produced by the initial registry listing. */
interface DiscoveryScanBatchQueueMessage {
  kind: "discovery_scan_batch";
  organizationId: string;
  /** Immutable generation of the connection that produced these candidates. */
  connectionId: string;
  source: Extract<ScanSource, "manual" | "auto_discovery">;
  actorUserId: string;
  candidates: DiscoveryScanCandidate[];
}

export type DiscoveryQueueMessage = DiscoverySweepQueueMessage | DiscoveryScanBatchQueueMessage;

/**
 * The queue discovery sweeps are delivered on. The Worker refuses to run a
 * sweep body that arrives on any other queue (and refuses non-sweep bodies on
 * this one), so a message published to the wrong queue is logged and dropped
 * instead of fanning out scan work from the wrong consumer.
 *
 * Keep this in sync with `queues.consumers[].queue` in `wrangler.jsonc` and in
 * `docs/examples/wrangler.self-host.jsonc`. Renaming the queue without renaming
 * this constant shows up as error-level `queue.message.unknown_kind` logs
 * naming both.
 */
export const DISCOVERY_SWEEP_QUEUE_NAME = "staged-publish-review-discovery";

const DISCOVERY_CANDIDATE_BATCH_SIZE = 50;
const DISCOVERY_CANDIDATE_HINT_MAX_JSON_BYTES = 512;
const DISCOVERY_QUEUE_IDENTIFIER_MAX_LENGTH = 256;
// A candidate message stays below 128 KiB when every encoded hint reaches its
// byte cap. Two such messages also stay below sendBatch's 256 KiB cap.
const DISCOVERY_QUEUE_SEND_BATCH_SIZE = 2;

export function isDiscoveryQueueMessage(message: unknown): message is DiscoveryQueueMessage {
  if (!isRecord(message) || !isBoundedIdentifier(message.organizationId)) return false;
  if (message.kind === "discovery_sweep") return isDiscoverySweepBody(message);
  if (message.kind !== "discovery_scan_batch") return false;
  return (
    hasOnlyKeys(message, [
      "kind",
      "organizationId",
      "connectionId",
      "source",
      "actorUserId",
      "candidates",
    ]) &&
    isBoundedIdentifier(message.connectionId) &&
    isDiscoverySource(message.source) &&
    isBoundedIdentifier(message.actorUserId) &&
    Array.isArray(message.candidates) &&
    message.candidates.length > 0 &&
    message.candidates.length <= DISCOVERY_CANDIDATE_BATCH_SIZE &&
    message.candidates.every(isDiscoveryScanCandidate)
  );
}

function isDiscoverySweepBody(message: Record<string, unknown>): boolean {
  const hasLegacyContinuation =
    message.afterStageId !== undefined ||
    message.source !== undefined ||
    message.actorUserId !== undefined;
  if (!hasLegacyContinuation) {
    return hasOnlyKeys(message, ["kind", "organizationId"]);
  }
  return (
    hasOnlyKeys(message, ["kind", "organizationId", "afterStageId", "source", "actorUserId"]) &&
    isValidStageId(message.afterStageId) &&
    isDiscoverySource(message.source) &&
    isBoundedIdentifier(message.actorUserId)
  );
}

function isDiscoveryScanCandidate(value: unknown): value is DiscoveryScanCandidate {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["stageId", "packageName", "version"]) &&
    isValidStageId(value.stageId) &&
    isBoundedHint(value.packageName) &&
    isBoundedHint(value.version)
  );
}

function isDiscoverySource(value: unknown): value is "manual" | "auto_discovery" {
  return value === "manual" || value === "auto_discovery";
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DISCOVERY_QUEUE_IDENTIFIER_MAX_LENGTH
  );
}

function isBoundedHint(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      utf8Size(JSON.stringify(value)) <= DISCOVERY_CANDIDATE_HINT_MAX_JSON_BYTES)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Fan every remaining candidate into sibling queue messages. No candidate
 * message sends another candidate message, so queue delivery depth stays one.
 */
export function scheduleDiscoveryScanBatches(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  input: {
    organizationId: string;
    connectionId: string;
    source: Extract<ScanSource, "manual" | "auto_discovery">;
    actorUserId: string;
    candidates: readonly StagedPublishItem[];
  },
): void {
  if (!env.DISCOVERY_QUEUE) return;
  const messages: DiscoveryScanBatchQueueMessage[] = [];
  for (let offset = 0; offset < input.candidates.length; offset += DISCOVERY_CANDIDATE_BATCH_SIZE) {
    messages.push({
      kind: "discovery_scan_batch",
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      source: input.source,
      actorUserId: input.actorUserId,
      candidates: input.candidates
        .slice(offset, offset + DISCOVERY_CANDIDATE_BATCH_SIZE)
        .map(toDiscoveryScanCandidate),
    });
  }
  if (!messages.length) return;
  executionCtx.waitUntil(
    sendDiscoveryScanBatches(env.DISCOVERY_QUEUE, messages).catch((err) => {
      emitOperationalEvent("error", "staged_publishes.sweep.candidate_batches_enqueue_failed", {
        organizationId: input.organizationId,
        source: input.source,
        messages: messages.length,
        candidates: input.candidates.length,
        error: describeOperationalError(err),
      });
    }),
  );
}

async function sendDiscoveryScanBatches(
  queue: Queue<DiscoveryQueueMessage>,
  messages: readonly DiscoveryScanBatchQueueMessage[],
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += DISCOVERY_QUEUE_SEND_BATCH_SIZE) {
    const batch = messages.slice(offset, offset + DISCOVERY_QUEUE_SEND_BATCH_SIZE);
    await sendDiscoveryQueueBatch(queue, batch, {
      operation: "candidate_batches",
      organizationId: batch[0]?.organizationId,
    });
  }
}

const DISCOVERY_QUEUE_SEND_MAX_ATTEMPTS = 5;
const DISCOVERY_QUEUE_SEND_RETRY_BASE_DELAY_MS = 100;
const DISCOVERY_QUEUE_SEND_RETRY_MAX_DELAY_MS = 1_000;
const DISCOVERY_QUEUE_THROTTLE_PATTERN = /\b429\b|too many requests|rate.?limit/i;
// Cloudflare's default queue ceiling is 5,000 messages/s. Keep the cron producer
// below it and reserve headroom for candidate batches sent by active consumers.
const DISCOVERY_SWEEP_TARGET_MESSAGES_PER_SECOND = 4_000;

/**
 * Retry only the Queue throughput rejection. At the default 5,000 messages/s
 * limit a 45k-org tick can outrun the producer binding; aborting at that point
 * would restart from the first cursor next tick and starve the tail forever.
 * Other failures still surface immediately because an ambiguous response can
 * already have delivered the batch.
 */
async function sendDiscoveryQueueBatch(
  queue: Queue<DiscoveryQueueMessage>,
  messages: readonly DiscoveryQueueMessage[],
  context: {
    operation: "sweep_enumeration" | "candidate_batches";
    organizationId?: string;
    retryBaseDelayMs?: number;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= DISCOVERY_QUEUE_SEND_MAX_ATTEMPTS; attempt++) {
    try {
      await queue.sendBatch(messages.map((body) => ({ body })));
      return;
    } catch (err) {
      if (
        !DISCOVERY_QUEUE_THROTTLE_PATTERN.test(errorMessage(err)) ||
        attempt === DISCOVERY_QUEUE_SEND_MAX_ATTEMPTS
      ) {
        throw err;
      }
      const delayMs = Math.min(
        Math.max(0, context.retryBaseDelayMs ?? DISCOVERY_QUEUE_SEND_RETRY_BASE_DELAY_MS) *
          2 ** (attempt - 1),
        DISCOVERY_QUEUE_SEND_RETRY_MAX_DELAY_MS,
      );
      emitOperationalEvent("warn", "staged_publishes.discovery_queue.rate_limited", {
        operation: context.operation,
        organizationId: context.organizationId ?? null,
        messages: messages.length,
        attempt,
        nextDelayMs: delayMs,
      });
      if (delayMs > 0) await scheduler.wait(delayMs);
    }
  }
}

function toDiscoveryScanCandidate(item: StagedPublishItem): DiscoveryScanCandidate {
  return {
    stageId: item.id,
    packageName: boundedHint(item.packageName),
    version: boundedHint(item.version),
  };
}

function boundedHint(value: string | null): string | null {
  return isBoundedHint(value) ? value : null;
}

// Cloudflare Queues accepts at most 100 messages per sendBatch call, so the
// enumeration page size and the batch size are the same number: every page
// turns into exactly one send.
const DISCOVERY_SWEEP_BATCH_SIZE = 100;

// Hard stop on the producer loop. The real ceiling is not CPU but the
// 1000-subrequest budget of a single invocation: each page costs two (one D1
// read, one sendBatch), and the same invocation still has to run the audit
// prune afterwards. 450 pages ≈ 900 subrequests ≈ 45k organizations, which is
// far past the point where the 15-minute cadence itself needs rethinking.
const DISCOVERY_SWEEP_MAX_PAGES = 450;

// Only used by the inline fallback below, i.e. when no DISCOVERY_QUEUE binding
// exists: the Vitest Workers pool, the e2e dev server, and self-hosted
// deployments that drop the queue block. `pnpm run dev` reads wrangler.jsonc and
// therefore *does* bind the queue, so local dev exercises the deployed producer
// path under miniflare. On that path per-org parallelism is the queue consumer's
// concurrency, not this constant.
const INLINE_SWEEP_CONCURRENCY = 5;

/**
 * The cron tick: enumerate sweep-eligible organizations and hand each one to
 * the discovery queue. The tick stays O(1) in CPU per organization — a keyset
 * page read plus one `sendBatch` per 100 orgs — instead of running every sweep
 * inside the scheduled invocation's bounded CPU budget.
 *
 * Without a `DISCOVERY_QUEUE` binding it falls back to sweeping inline with
 * bounded concurrency, mirroring how the scan path falls back to
 * `waitUntil(executeScanJob)` when `SCAN_QUEUE` is absent. That fallback keeps
 * the old O(orgs) shape by definition; it exists for configurations without the
 * queue (Worker tests, the e2e dev server, self-hosters who dropped the block),
 * not as the shape local dev runs.
 */
export async function enqueueDiscoverySweeps(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  // Lowering the page budget is how tests reach the guard without seeding 45k
  // organizations; production always uses DISCOVERY_SWEEP_MAX_PAGES.
  options: { maxPages?: number; queueRetryBaseDelayMs?: number } = {},
): Promise<void> {
  const startedAtMs = Date.now();
  const maxPages = options.maxPages ?? DISCOVERY_SWEEP_MAX_PAGES;
  const db = createDb(env.DB);
  const queue = env.DISCOVERY_QUEUE;
  if (!queue) {
    await runInlineDiscoverySweeps(env, executionCtx, db, startedAtMs, maxPages);
    return;
  }

  emitOperationalEvent("info", "staged_publishes.cron.started", { mode: "queue" });

  let cursor: string | null = null;
  let organizations = 0;
  let batches = 0;
  let exhaustedPageBudget = true;
  let nextSweepSendAtMs = Date.now();
  for (let page = 0; page < maxPages; page++) {
    const refs = await listAutoDiscoveryNpmConnectionRefs(db, {
      limit: DISCOVERY_SWEEP_BATCH_SIZE,
      afterOrganizationId: cursor,
    });
    if (!refs.length) {
      exhaustedPageBudget = false;
      break;
    }
    const pacingDelayMs = Math.max(0, nextSweepSendAtMs - Date.now());
    if (pacingDelayMs > 0) await scheduler.wait(pacingDelayMs);
    const sendStartedAtMs = Date.now();
    await sendDiscoveryQueueBatch(
      queue,
      refs.map(
        (ref) =>
          ({
            kind: "discovery_sweep",
            organizationId: ref.organizationId,
          }) satisfies DiscoveryQueueMessage,
      ),
      {
        operation: "sweep_enumeration",
        retryBaseDelayMs: options.queueRetryBaseDelayMs,
      },
    );
    nextSweepSendAtMs =
      sendStartedAtMs +
      Math.ceil((refs.length * 1_000) / DISCOVERY_SWEEP_TARGET_MESSAGES_PER_SECOND);
    organizations += refs.length;
    batches += 1;
    const last = refs[refs.length - 1]!;
    cursor = last.organizationId;
    if (refs.length < DISCOVERY_SWEEP_BATCH_SIZE) {
      exhaustedPageBudget = false;
      break;
    }
  }

  // Running out of pages on an exact page boundary is not truncation: an org
  // count that happens to be a multiple of the page size would otherwise raise a
  // false alarm every tick. One extra bounded read settles it.
  const truncated = exhaustedPageBudget
    ? (
        await listAutoDiscoveryNpmConnectionRefs(db, {
          limit: 1,
          afterOrganizationId: cursor,
        })
      ).length > 0
    : false;

  emitOperationalEvent(truncated ? "error" : "info", "staged_publishes.cron.enqueued", {
    organizations,
    batches,
    truncated,
    durationMs: durationMsSince(startedAtMs),
  });
}

async function runInlineDiscoverySweeps(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  startedAtMs: number,
  maxPages: number,
): Promise<void> {
  const organizationIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const refs = await listAutoDiscoveryNpmConnectionRefs(db, {
      limit: DISCOVERY_SWEEP_BATCH_SIZE,
      afterOrganizationId: cursor,
    });
    if (!refs.length) break;
    for (const ref of refs) organizationIds.push(ref.organizationId);
    const last = refs[refs.length - 1]!;
    cursor = last.organizationId;
    if (refs.length < DISCOVERY_SWEEP_BATCH_SIZE) break;
  }

  emitOperationalEvent("info", "staged_publishes.cron.started", {
    mode: "inline",
    organizations: organizationIds.length,
  });

  let orgsProcessed = 0;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(INLINE_SWEEP_CONCURRENCY, organizationIds.length) },
    async () => {
      for (;;) {
        const organizationId = organizationIds[next++];
        if (organizationId === undefined) return;
        await runDiscoverySweep(env, executionCtx, { kind: "discovery_sweep", organizationId }, db);
        orgsProcessed++;
      }
    },
  );
  await Promise.all(runners);

  emitOperationalEvent("info", "staged_publishes.cron.swept", {
    orgsProcessed,
    durationMs: durationMsSince(startedAtMs),
    concurrencyLimit: INLINE_SWEEP_CONCURRENCY,
  });
}

/**
 * Sweep one organization. This is the queue consumer's whole job, and it never
 * throws: every failure mode is classified and logged here so a bad token or a
 * flaky registry does not retry the message or poison a batch. Discovery is
 * idempotent and the next tick re-enqueues the org, so a dropped sweep costs at
 * most one cycle of detection latency.
 */
export async function runDiscoverySweep(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: DiscoveryQueueMessage,
  existingDb?: AppDb,
): Promise<void> {
  const db = existingDb ?? createDb(env.DB);
  const { organizationId } = message;
  try {
    const connection = await getNpmConnection(db, organizationId);
    // The connection is re-read at consume time, so it can have been deleted or
    // invalidated between enumeration and this message. Both are ordinary, not
    // failures: skip instead of surfacing a sweep error.
    if (!connection) {
      emitOperationalEvent("info", "staged_publishes.cron.skipped", {
        organizationId,
        reason: "npm_connection_missing",
      });
      return;
    }
    if (message.kind === "discovery_scan_batch" && connection.id !== message.connectionId) {
      emitOperationalEvent("info", "staged_publishes.cron.skipped", {
        organizationId,
        reason: "npm_connection_replaced",
      });
      return;
    }
    if (connection.validationStatus === "invalid") {
      emitOperationalEvent("info", "staged_publishes.cron.skipped", {
        organizationId,
        reason: "npm_connection_invalid",
      });
      return;
    }

    const notificationOwnerUserId = await getOrganizationOwnerUserId(db, organizationId);
    const actorUserId =
      message.actorUserId ?? connection.createdByUserId ?? notificationOwnerUserId;
    if (!notificationOwnerUserId || !actorUserId) {
      emitOperationalEvent("error", "staged_publishes.cron.skipped", {
        organizationId,
        reason: "organization_owner_missing",
      });
      return;
    }
    const allowInsecureLocalhost = allowInsecureLocalRegistry(env);
    try {
      const usable = await ensureUsableNpmConnection({
        db,
        env,
        connection,
        actorUserId,
        allowInsecureLocalhost,
      });
      const source = message.source ?? "auto_discovery";
      const discoveryInput = {
        db,
        env,
        executionCtx,
        organizationId,
        actorUserId,
        source,
        eventSource: "staged_publishes.cron",
        allowInsecureLocalhost,
        awaitReleaseOutcomes: true,
      } as const;
      const result =
        message.kind === "discovery_scan_batch"
          ? await queueStagedPublishCandidates(
              discoveryInput,
              usable,
              message.candidates.map(fromDiscoveryScanCandidate),
            )
          : await discoverAndQueueStagedPublishes(
              {
                ...discoveryInput,
                scheduleCandidateBatches: env.DISCOVERY_QUEUE
                  ? (candidates: readonly StagedPublishItem[]) =>
                      scheduleDiscoveryScanBatches(env, executionCtx, {
                        organizationId,
                        connectionId: connection.id,
                        source,
                        actorUserId,
                        candidates,
                      })
                  : undefined,
              },
              usable,
            );
      emitOperationalEvent("info", "staged_publishes.cron.org_completed", {
        organizationId,
        ...result,
      });
    } catch (err) {
      if (isNpmConnectionAuthFailure(err)) {
        // The token can no longer reach the staging registry. Mark the
        // connection invalid, record it, and email the maintainer so reviews
        // don't silently stop. Never let the alerting itself break the sweep.
        try {
          await recordExpiredNpmConnection({
            db,
            env,
            connection,
            actorUserId,
            notificationOwnerUserId,
            error: err,
          });
        } catch (alertErr) {
          emitOperationalEvent("error", "npm_connection.token_expired_alert_failed", {
            organizationId,
            error: describeOperationalError(alertErr),
          });
        }
        return;
      }
      const detail =
        err instanceof StagedPublishesFetchError
          ? { status: err.status, detail: err.detail }
          : describeOperationalError(err);
      // Registry timeouts and 5xx are upstream weather, not a broken sweep;
      // logging them at error made every npm hiccup indistinguishable from a
      // real failure. `transient` is emitted either way so a query can select
      // on the field rather than on the level.
      const transient = isTransientSweepFailure(err);
      emitOperationalEvent(transient ? "warn" : "error", "staged_publishes.cron.org_failed", {
        organizationId,
        transient,
        error: detail,
      });
    }
  } catch (err) {
    // Reached only when the pre-sweep D1 reads fail. Same reasoning as above:
    // log it and let the next tick re-enqueue the org.
    emitOperationalEvent("error", "staged_publishes.cron.org_failed", {
      organizationId,
      transient: false,
      error: describeOperationalError(err),
    });
  }
}

function fromDiscoveryScanCandidate(candidate: DiscoveryScanCandidate): StagedPublishItem {
  return {
    id: candidate.stageId,
    packageName: candidate.packageName,
    version: candidate.version,
    tag: null,
    access: null,
    actor: null,
    actorType: null,
    createdAt: null,
    shasum: null,
  };
}
