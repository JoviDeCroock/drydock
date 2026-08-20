import { type AppDb } from "../../../db/client";
import {
  ORGANIZATION_SCAN_LIMIT,
  ORGANIZATION_SCAN_WINDOW_MS,
  RateLimitError,
  enforceRateLimit,
} from "../../platform/rate-limit";
import { type ScanSource, createScanJob, listExistingScanStageIds } from "../../../db/scans";
import { resolveAtpmRepoIdentity } from "./identity";
import { listAtpmStagedVersions } from "./stage-record";
import { formatAtpmStageId, parseAtpmPublisherRef } from "./stage-ref";
import {
  executeScanJob,
  type AtpmDiscoveryQueueMessage,
  type ScanQueueMessage,
} from "../../scan/job";
import { recordProductEvent } from "../../platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";

/**
 * Finding atpm release candidates that nobody asked Drydock to look at yet.
 *
 * npm's equivalent sweeps stored credentials, because a staged npm publish is
 * private registry state and the token is both the address book and the key.
 * atpm has neither problem and neither affordance: candidates are public
 * records, so there is no credential to sweep — but for the same reason there
 * is nothing that says *which* publishers an organization cares about. The
 * release target answers that, since configuring an atpm gate already means
 * naming the publishing account.
 *
 * The effect is that an organization gets staged reviews for its own publisher
 * whether or not a workflow run ever reaches the gate: a release staged from a
 * laptop is reviewed on the next sweep, and one staged by CI is reviewed twice
 * — once here and once bound to its run — which costs a duplicate scan only
 * when the sweep wins the race, and is deduplicated by stage id when it does
 * not.
 */
export interface DiscoverAtpmStagedInput {
  db: AppDb;
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  organizationId: string;
  actorUserId: string;
  /** Publishing account as the release target spells it (`@handle` or a DID). */
  publisherRef: string;
  source: ScanSource;
}

export interface DiscoverAtpmStagedResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
}

/**
 * How many candidates one publisher may contribute to a single sweep.
 *
 * A staged record is not withdrawn by publishing — atpm deletes it on approval,
 * but a rejected or forgotten candidate lingers — so a repository can
 * legitimately accumulate them. Reviewing every one on the first sweep would
 * spend a scan quota on releases nobody is waiting for. Newest first, so the
 * candidates a maintainer is actually about to approve are the ones reviewed.
 */
const MAX_DISCOVERED_CANDIDATES_PER_SWEEP = 10;

/** Local/dev fallback when no Queue binding is configured. */
const ATPM_DISCOVERY_CONCURRENCY = 5;

/** Cloudflare Queues accepts at most 100 messages in one sendBatch call. */
const QUEUE_SEND_BATCH_SIZE = 100;

export async function discoverAtpmStagedCandidates(
  input: DiscoverAtpmStagedInput,
): Promise<DiscoverAtpmStagedResult> {
  const { db, env, executionCtx, organizationId, actorUserId, source } = input;

  const ref = parseAtpmPublisherRef(input.publisherRef);
  if (!ref) return { found: 0, created: 0, skipped: 0, queued: false };

  const identity = await resolveAtpmRepoIdentity(ref);
  const staged = (await listAtpmStagedVersions(identity)).slice(
    0,
    MAX_DISCOVERED_CANDIDATES_PER_SWEEP,
  );
  if (!staged.length) return { found: 0, created: 0, skipped: 0, queued: false };

  // The approval id folds in the record CID. A record rewritten under the same
  // TID therefore becomes a new review identity, while the workflow gate and
  // discovery still deduplicate when they selected the same immutable record.
  const stageIds = staged.map((candidate) =>
    formatAtpmStageId(identity.did, candidate.rkey, candidate.stageId),
  );
  const existing = await listExistingScanStageIds(db, organizationId, stageIds);

  let created = 0;
  let skipped = 0;
  let queued = false;
  for (const [index, candidate] of staged.entries()) {
    const stageId = stageIds[index];
    if (existing.has(stageId)) {
      skipped++;
      continue;
    }

    try {
      await enforceRateLimit(env, {
        key: `scan:${organizationId}`,
        limit: ORGANIZATION_SCAN_LIMIT,
        windowMs: ORGANIZATION_SCAN_WINDOW_MS,
      });
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;
      skipped += staged.length - index;
      break;
    }

    const scanId = crypto.randomUUID();
    const detail = await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: actorUserId,
      source,
      packageName: candidate.declaredName,
      stagedVersion: candidate.version,
    });
    if (!detail) {
      skipped++;
      continue;
    }
    created++;
    recordProductEvent(env, { name: "scan.queued", organizationId, ecosystem: "atpm", source });

    const message: ScanQueueMessage = {
      scanId,
      stageId,
      ecosystem: "atpm",
      organizationId,
      actorUserId,
      source,
    };
    if (env.SCAN_QUEUE) {
      await env.SCAN_QUEUE.send(message);
      queued = true;
    } else {
      executionCtx.waitUntil(
        executeScanJob(env, executionCtx, message, db, { finalAttempt: true }),
      );
    }
  }

  return { found: staged.length, created, skipped, queued };
}

/**
 * Sweep every organization that has configured an atpm publisher.
 *
 * Failures are per publisher and never abort the sweep: a publisher's PDS being
 * unreachable is upstream weather, and it must not stop another organization's
 * releases from being discovered.
 */
export async function sweepAtpmPublishers(input: {
  db: AppDb;
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  targets: Array<{ organizationId: string; publisherRef: string | null; actorUserId: string }>;
  source: ScanSource;
}): Promise<{ publishers: number; created: number; dispatched: number }> {
  const targets = uniquePublisherTargets(input.targets);
  if (input.env.SCAN_QUEUE) {
    const messages: AtpmDiscoveryQueueMessage[] = targets.map((target) => ({
      kind: "atpm_discovery",
      organizationId: target.organizationId,
      actorUserId: target.actorUserId,
      publisherRef: target.publisherRef,
      source: input.source,
    }));
    for (let start = 0; start < messages.length; start += QUEUE_SEND_BATCH_SIZE) {
      await input.env.SCAN_QUEUE.sendBatch(
        messages.slice(start, start + QUEUE_SEND_BATCH_SIZE).map((body) => ({
          body,
          contentType: "json" as const,
        })),
      );
    }
    return { publishers: targets.length, created: 0, dispatched: messages.length };
  }

  let created = 0;
  let publishers = 0;
  await runWithConcurrency(targets, ATPM_DISCOVERY_CONCURRENCY, async (target) => {
    publishers++;
    try {
      const result = await discoverAtpmStagedCandidates({
        db: input.db,
        env: input.env,
        executionCtx: input.executionCtx,
        organizationId: target.organizationId,
        actorUserId: target.actorUserId,
        publisherRef: target.publisherRef,
        source: input.source,
      });
      created += result.created;
      emitOperationalEvent("info", "atpm_staged.cron.publisher_completed", {
        organizationId: target.organizationId,
        ...result,
      });
    } catch (err) {
      emitOperationalEvent("warn", "atpm_staged.cron.publisher_failed", {
        organizationId: target.organizationId,
        error: describeOperationalError(err),
      });
    }
  });
  return { publishers, created, dispatched: 0 };
}

function uniquePublisherTargets(
  targets: Array<{ organizationId: string; publisherRef: string | null; actorUserId: string }>,
): Array<{ organizationId: string; publisherRef: string; actorUserId: string }> {
  const unique = new Map<
    string,
    { organizationId: string; publisherRef: string; actorUserId: string }
  >();
  for (const target of targets) {
    if (!target.publisherRef) continue;
    const ref = parseAtpmPublisherRef(target.publisherRef);
    if (!ref) continue;
    const publisherRef =
      ref.authority.kind === "handle" ? `@${ref.authority.handle}` : ref.authority.did;
    const key = `${target.organizationId}\u0000${publisherRef}`;
    if (!unique.has(key)) unique.set(key, { ...target, publisherRef });
  }
  return [...unique.values()];
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}
