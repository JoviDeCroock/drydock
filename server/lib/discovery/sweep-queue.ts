import { createDb, type AppDb } from "../../db/client";
import { getNpmConnection, listAutoDiscoveryNpmConnectionRefs } from "../../db/npm-connections";
import { getOrganizationOwnerUserId } from "../../db/organizations";
import { allowInsecureLocalRegistry } from "../ecosystems/npm/connection";
import {
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
  isNpmConnectionAuthFailure,
  isTransientSweepFailure,
  recordExpiredNpmConnection,
  StagedPublishesFetchError,
} from "../ecosystems/npm/staged-publishes-discovery";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";

/**
 * One organization's staged-publish discovery sweep. Carries only the
 * organization id: the consumer re-reads the npm connection from D1, so no
 * token ciphertext or nonce is ever written to a queue.
 */
export interface DiscoverySweepQueueMessage {
  kind: "discovery_sweep";
  organizationId: string;
}

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

export function isDiscoverySweepMessage(message: unknown): message is DiscoverySweepQueueMessage {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { kind?: unknown; organizationId?: unknown };
  return (
    candidate.kind === "discovery_sweep" &&
    typeof candidate.organizationId === "string" &&
    candidate.organizationId.length > 0
  );
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
  options: { maxPages?: number } = {},
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
  for (let page = 0; page < maxPages; page++) {
    const refs = await listAutoDiscoveryNpmConnectionRefs(db, {
      limit: DISCOVERY_SWEEP_BATCH_SIZE,
      afterId: cursor,
    });
    if (!refs.length) {
      exhaustedPageBudget = false;
      break;
    }
    await queue.sendBatch(
      refs.map((ref) => ({
        body: { kind: "discovery_sweep", organizationId: ref.organizationId } as const,
      })),
    );
    organizations += refs.length;
    batches += 1;
    const last = refs[refs.length - 1]!;
    cursor = last.id;
    if (refs.length < DISCOVERY_SWEEP_BATCH_SIZE) {
      exhaustedPageBudget = false;
      break;
    }
  }

  // Running out of pages on an exact page boundary is not truncation: an org
  // count that happens to be a multiple of the page size would otherwise raise a
  // false alarm every tick. One extra bounded read settles it.
  const truncated = exhaustedPageBudget
    ? (await listAutoDiscoveryNpmConnectionRefs(db, { limit: 1, afterId: cursor })).length > 0
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
      afterId: cursor,
    });
    if (!refs.length) break;
    for (const ref of refs) organizationIds.push(ref.organizationId);
    const last = refs[refs.length - 1]!;
    cursor = last.id;
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
  message: DiscoverySweepQueueMessage,
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
    if (connection.validationStatus === "invalid") {
      emitOperationalEvent("info", "staged_publishes.cron.skipped", {
        organizationId,
        reason: "npm_connection_invalid",
      });
      return;
    }

    const notificationOwnerUserId = await getOrganizationOwnerUserId(db, organizationId);
    const actorUserId = connection.createdByUserId ?? notificationOwnerUserId;
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
      const result = await discoverAndQueueStagedPublishes(
        {
          db,
          env,
          executionCtx,
          organizationId,
          actorUserId,
          source: "auto_discovery",
          eventSource: "staged_publishes.cron",
          allowInsecureLocalhost,
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
