import { createDb } from "./db/client";
import { AUDIT_LOG_RETENTION_DAYS, pruneAuditEventsOlderThan } from "./db/audit-log";
import { pruneExpiredAuthRows } from "./db/auth-retention";
import { listAutoDiscoveryNpmConnections } from "./db/npm-connections";
import { getOrganizationOwnerUserId } from "./db/organizations";
import { pruneExpiredRateLimitBuckets } from "./db/rate-limits";
import { ECOSYSTEMS } from "./lib/ecosystems";
import { allowInsecureLocalRegistry } from "./lib/ecosystems/npm/connection";
import {
  createStageStartCoordinator,
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
  isNpmConnectionAuthFailure,
  isTransientSweepFailure,
  recordExpiredNpmConnection,
  StagedPublishesFetchError,
} from "./lib/ecosystems/npm/staged-publishes-discovery";
import { mapWithConcurrency } from "./lib/platform/concurrency";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./lib/platform/observability";

// A scheduled invocation gets a bounded CPU budget. Sweeping organizations
// sequentially is fine at ~10 orgs but approaches that budget around 50-100,
// after which the tick can be cut off and cycles drop silently. Five sweeps in
// flight keeps us comfortably under budget while still draining a large org
// count within a single 15-minute cycle. Raise only after measuring CPU time.
const DISCOVERY_CRON_CONCURRENCY = 5;

async function runStagedPublishesDiscoveryCron(env: Cloudflare.Env, ctx: ExecutionContext) {
  const startedAtMs = Date.now();
  const db = createDb(env.DB);
  const connections = await listAutoDiscoveryNpmConnections(db);
  const stageStartCoordinator = createStageStartCoordinator();
  emitOperationalEvent("info", "staged_publishes.cron.started", {
    organizations: connections.length,
  });
  const allowInsecureLocalhost = allowInsecureLocalRegistry(env);

  let orgsProcessed = 0;
  const sweepConnection = async (connection: (typeof connections)[number]) => {
    try {
      const notificationOwnerUserId = await getOrganizationOwnerUserId(
        db,
        connection.organizationId,
      );
      const actorUserId = connection.createdByUserId ?? notificationOwnerUserId;
      if (!notificationOwnerUserId || !actorUserId) {
        emitOperationalEvent("error", "staged_publishes.cron.skipped", {
          organizationId: connection.organizationId,
          reason: "organization_owner_missing",
        });
        return;
      }
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
            executionCtx: ctx,
            organizationId: connection.organizationId,
            actorUserId,
            source: "auto_discovery",
            eventSource: "staged_publishes.cron",
            allowInsecureLocalhost,
            stageStartCoordinator,
            awaitReleaseOutcomes: true,
          },
          usable,
        );
        emitOperationalEvent("info", "staged_publishes.cron.org_completed", {
          organizationId: connection.organizationId,
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
              organizationId: connection.organizationId,
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
          organizationId: connection.organizationId,
          transient,
          error: detail,
        });
      }
    } catch (err) {
      // The owner lookup runs before the per-org registry try/catch. Keep a D1
      // hiccup on one organization from rejecting mapWithConcurrency and
      // abandoning every organization still queued behind it.
      emitOperationalEvent("error", "staged_publishes.cron.org_failed", {
        organizationId: connection.organizationId,
        transient: false,
        error: describeOperationalError(err),
      });
    } finally {
      orgsProcessed++;
    }
  };

  await mapWithConcurrency(connections, DISCOVERY_CRON_CONCURRENCY, sweepConnection);

  emitOperationalEvent("info", "staged_publishes.cron.swept", {
    orgsProcessed,
    durationMs: durationMsSince(startedAtMs),
    concurrencyLimit: DISCOVERY_CRON_CONCURRENCY,
  });
}

// Public release monitoring also covers organizations with no registry
// credential or discovery connection, so it runs outside the discovery sweep. Each
// phase fails on its own: a broken backfill must not stop watches already
// enrolled from being checked, and neither may disable stage review.
async function runPublicationMonitorCron(env: Cloudflare.Env) {
  const db = createDb(env.DB);
  for (const ecosystem of ECOSYSTEMS) {
    const monitor = ecosystem.publicationMonitor;
    if (!monitor) continue;
    try {
      await monitor.backfillWatches(db, env);
    } catch (err) {
      emitOperationalEvent("error", "publication_monitor.backfill_failed", {
        ecosystem: ecosystem.id,
        error: describeOperationalError(err),
      });
    }
    try {
      await monitor.sweepWatches(db, env);
    } catch (err) {
      emitOperationalEvent("error", "publication_monitor.cron_failed", {
        ecosystem: ecosystem.id,
        error: describeOperationalError(err),
      });
    }
  }
}

// Flat-window retention for the organization audit log. Runs each tick; a
// bounded DELETE keeps the sweep cheap. Never let pruning failures abort the
// discovery cron.
async function pruneStaleAuditEvents(env: Cloudflare.Env) {
  const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await pruneAuditEventsOlderThan(createDb(env.DB), cutoff);
    emitOperationalEvent("info", "audit_events.pruned", {
      retentionDays: AUDIT_LOG_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    });
  } catch (err) {
    emitOperationalEvent("error", "audit_events.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

// Better Auth never removes its own expired rows, so `session` grows with every
// sign-in and holds each dead session's IP address and user agent forever. Sweep
// them on the same tick as the audit log, and on the same terms: a prune failure
// is logged, never thrown, so it can't take the cron down with it.
async function pruneStaleAuthRows(env: Cloudflare.Env) {
  try {
    const pruned = await pruneExpiredAuthRows(createDb(env.DB));
    if (pruned.sessions > 0 || pruned.verifications > 0) {
      emitOperationalEvent("info", "auth_rows.pruned", {
        sessions: pruned.sessions,
        verifications: pruned.verifications,
      });
    }
  } catch (err) {
    emitOperationalEvent("error", "auth_rows.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

// Only the windows the native Rate Limiting binding cannot express (the hourly
// and 15-minute budgets on human-initiated actions) still write D1 buckets, so
// this sweep is small. It used to run on whichever request happened to cross a
// per-isolate 5-minute timer, which put an unbounded DELETE on the hot path.
async function pruneStaleRateLimitBuckets(env: Cloudflare.Env) {
  try {
    await pruneExpiredRateLimitBuckets(createDb(env.DB), new Date());
  } catch (err) {
    emitOperationalEvent("error", "rate_limits.prune_failed", {
      error: describeOperationalError(err),
    });
  }
}

/**
 * The cron handler `server/index.ts` exports: the discovery sweep, public
 * publication monitoring, then retention.
 */
export async function scheduled(
  _event: ScheduledController,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<void> {
  // The discovery sweep's first D1 read runs before the per-organization
  // try/catch, so a transient D1 failure here used to surface as an uncaught
  // exception and skip audit pruning. The sweep is idempotent and the next
  // tick is 15 minutes away — log and move on instead of throwing.
  try {
    await runStagedPublishesDiscoveryCron(env, ctx);
  } catch (err) {
    emitOperationalEvent("error", "staged_publishes.cron.failed", {
      error: describeOperationalError(err),
    });
  }
  await runPublicationMonitorCron(env);
  await pruneStaleAuditEvents(env);
  await pruneStaleAuthRows(env);
  await pruneStaleRateLimitBuckets(env);
}
