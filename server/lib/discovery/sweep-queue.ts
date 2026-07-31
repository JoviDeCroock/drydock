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

export function isDiscoverySweepMessage(message: unknown): message is DiscoverySweepQueueMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { kind?: unknown }).kind === "discovery_sweep"
  );
}

// Cloudflare Queues accepts at most 100 messages per sendBatch call, so the
// enumeration page size and the batch size are the same number: every page
// turns into exactly one send.
const DISCOVERY_SWEEP_BATCH_SIZE = 100;

// Hard stop on the producer loop so a pagination bug can never spin the
// scheduled invocation. 100k eligible organizations is far past the point where
// the 15-minute cadence itself needs rethinking.
const DISCOVERY_SWEEP_MAX_PAGES = 1000;

// Only used by the inline fallback below (no DISCOVERY_QUEUE binding, i.e.
// local dev and tests). The deployed path runs one org per queue message, so
// its parallelism is the queue consumer's `max_concurrency`, not this constant.
const INLINE_SWEEP_CONCURRENCY = 5;

/**
 * The cron tick: enumerate sweep-eligible organizations and hand each one to
 * the discovery queue. The tick stays O(1) in CPU per organization — a keyset
 * page read plus one `sendBatch` per 100 orgs — instead of running every sweep
 * inside the scheduled invocation's bounded CPU budget.
 *
 * Without a `DISCOVERY_QUEUE` binding (local dev, `pnpm run dev`, tests,
 * self-hosted deployments that skip the queue) it falls back to sweeping inline
 * with bounded concurrency, mirroring how the scan path falls back to
 * `waitUntil(executeScanJob)` when `SCAN_QUEUE` is absent. That fallback keeps
 * the old O(orgs) shape by definition; it is a dev convenience, not the
 * production path.
 */
export async function enqueueDiscoverySweeps(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
): Promise<void> {
  const startedAtMs = Date.now();
  const db = createDb(env.DB);
  const queue = env.DISCOVERY_QUEUE;
  if (!queue) {
    await runInlineDiscoverySweeps(env, executionCtx, db, startedAtMs);
    return;
  }

  emitOperationalEvent("info", "staged_publishes.cron.started", { mode: "queue" });

  let cursor: string | null = null;
  let organizations = 0;
  let batches = 0;
  let truncated = true;
  for (let page = 0; page < DISCOVERY_SWEEP_MAX_PAGES; page++) {
    const refs = await listAutoDiscoveryNpmConnectionRefs(db, {
      limit: DISCOVERY_SWEEP_BATCH_SIZE,
      afterId: cursor,
    });
    if (!refs.length) {
      truncated = false;
      break;
    }
    await queue.sendBatch(
      refs.map((ref) => ({
        body: { kind: "discovery_sweep", organizationId: ref.organizationId } as const,
      })),
    );
    organizations += refs.length;
    batches += 1;
    cursor = refs[refs.length - 1]!.id;
    if (refs.length < DISCOVERY_SWEEP_BATCH_SIZE) {
      truncated = false;
      break;
    }
  }

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
): Promise<void> {
  const organizationIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DISCOVERY_SWEEP_MAX_PAGES; page++) {
    const refs = await listAutoDiscoveryNpmConnectionRefs(db, {
      limit: DISCOVERY_SWEEP_BATCH_SIZE,
      afterId: cursor,
    });
    if (!refs.length) break;
    for (const ref of refs) organizationIds.push(ref.organizationId);
    cursor = refs[refs.length - 1]!.id;
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
