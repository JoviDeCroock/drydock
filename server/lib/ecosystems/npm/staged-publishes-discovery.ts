import { type AppDb } from "../../../db/client";
import { mapWithConcurrency } from "../../platform/concurrency";
import { recordScanEvent } from "../../../db/events";
import { markNpmConnectionUsed, updateNpmConnectionValidation } from "../../../db/npm-connections";
import {
  type ScanSource,
  createScanJob,
  deletePendingScanJobs,
  listExistingScanStageIds,
} from "../../../db/scans";
import { decryptNpmToken, validateNpmCredential, type NpmCredentialValidation } from "./connection";
import { notifyNpmConnectionExpired } from "../../notify";
import { executeScanJob, type ScanQueueMessage } from "../../scan/job";
import { recordProductEvent } from "../../platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import {
  checkStagedPublishAccess,
  listStagedPublishes,
  StagedPublishesFetchError,
  type StagedPublishItem,
  type StartedStagedPublishScan,
} from "./staged-publishes";

export interface DiscoverStagedPublishesInput {
  db: AppDb;
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  organizationId: string;
  actorUserId: string;
  source: ScanSource;
  eventSource: string;
  allowInsecureLocalhost?: boolean;
  /** Resume after a stage examined by a previous discovery-queue invocation. */
  afterStageId?: string;
  /** Schedule the next bounded invocation when more new stages remain. */
  scheduleContinuation?: (afterStageId: string) => void;
}

export interface DiscoverStagedPublishesResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
  scans: StartedStagedPublishScan[];
  deferred: number;
}

const STAGED_PUBLISH_SCAN_START_CONCURRENCY = 5;

// Preparing a scan costs an access probe plus the D1 insert/detail reads. Keep
// each discovery-queue invocation comfortably below Workers' 1000-subrequest
// ceiling even when the staged listing itself spans its full 100-page guard.
const STAGED_PUBLISH_SCAN_PREPARE_BATCH_SIZE = 50;

// Cloudflare Queues caps sendBatch at 100 messages. A sweep that discovers more
// new stages than that sends several batches rather than one send per scan.
const SCAN_QUEUE_SEND_BATCH_SIZE = 100;

export class InvalidNpmConnectionError extends Error {
  constructor(
    public organizationId: string,
    public validation?: NpmCredentialValidation,
  ) {
    super(`npm connection is not valid for org ${organizationId}`);
    this.name = "InvalidNpmConnectionError";
  }
}

export interface TokenForDiscovery {
  token: string;
  registryUrl: string;
}

/**
 * A scan row that exists in D1 but has not been handed to the scan queue yet.
 * Discovery creates the rows first (so `listExistingScanStageIds` suppresses
 * duplicates on the next sweep) and dispatches them in batches afterwards.
 */
interface PreparedScanStart {
  scanId: string;
  message: ScanQueueMessage;
  startedScan: StartedStagedPublishScan;
}

/**
 * Whether a cron sweep error means the org's npm token can no longer authenticate
 * against the staging registry (expired, revoked, or scope-stripped) rather than
 * a transient registry/network problem. An unvalidated token is only treated as
 * expired when credential validation saw a 401/403; a token that was last seen
 * valid surfaces as a 401/403 on the staged-list fetch. Both mean the maintainer
 * must re-add a token.
 */
export function isNpmConnectionAuthFailure(err: unknown): boolean {
  if (err instanceof InvalidNpmConnectionError) {
    return err.validation ? credentialValidationAuthFailed(err.validation) : false;
  }
  if (err instanceof StagedPublishesFetchError) return err.status === 401 || err.status === 403;
  return false;
}

/**
 * Whether a cron sweep error is upstream infrastructure trouble rather than
 * something an operator can act on. `reliableFetch` has already retried GETs
 * three times by the time these surface, so this is not "might still succeed" —
 * it is "the registry, not us". Status 0 is a transport failure (timeout, DNS,
 * TLS); 408/429/5xx are the registry saying it could not serve the request.
 *
 * These are logged at warn so the error channel stays actionable: discovery is
 * idempotent and the next 15-minute tick re-sweeps the org, so a single one
 * costs at most one cycle of detection latency. A registry that stays
 * unreachable for an org is invisible here by design — that needs failure
 * counting across ticks, not a louder single-tick log.
 */
export function isTransientSweepFailure(err: unknown): boolean {
  if (!(err instanceof StagedPublishesFetchError)) return false;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

function describeNpmAuthFailure(err: unknown): string {
  if (err instanceof StagedPublishesFetchError) return `staged_list_${err.status}`;
  if (err instanceof InvalidNpmConnectionError && err.validation) {
    const status = credentialValidationAuthStatus(err.validation);
    return status ? `validation_${status}` : "validation_failed";
  }
  return "unknown";
}

function credentialValidationAuthFailed(validation: NpmCredentialValidation): boolean {
  return credentialValidationAuthStatus(validation) !== null;
}

function credentialValidationAuthStatus(validation: NpmCredentialValidation): number | null {
  const { capabilities } = validation;
  const statuses = [
    capabilities.status,
    capabilities.stagedListStatus,
    capabilities.stagedViewStatus,
    capabilities.stagedTarballStatus,
  ];
  return statuses.find((status) => status === 401 || status === 403) ?? null;
}

/**
 * Record that an org's npm token stopped working during a cron sweep: mark the
 * connection `invalid` (which removes it from future sweeps and raises the
 * Settings banner), write the `npm_connection.token_expired` audit event, and
 * email the maintainer. Marking invalid first is what keeps this to one email
 * per expiry — the next sweep no longer sees the connection.
 */
export async function recordExpiredNpmConnection(input: {
  db: AppDb;
  env: Cloudflare.Env;
  connection: { organizationId: string; registryUrl: string };
  actorUserId: string;
  notificationOwnerUserId: string;
  error: unknown;
}): Promise<void> {
  const { db, env, connection, actorUserId, notificationOwnerUserId, error } = input;
  const reason = describeNpmAuthFailure(error);
  await updateNpmConnectionValidation(db, {
    organizationId: connection.organizationId,
    validationStatus: "invalid",
    validatedAt: null,
  });
  await recordScanEvent(db, {
    organizationId: connection.organizationId,
    actorUserId,
    type: "npm_connection.token_expired",
    metadata: { source: "cron", reason },
  });
  await notifyNpmConnectionExpired({
    env,
    db,
    organizationId: connection.organizationId,
    ownerUserId: notificationOwnerUserId,
    registryUrl: connection.registryUrl,
  });
}

export async function ensureUsableNpmConnection(input: {
  db: AppDb;
  env: Cloudflare.Env;
  connection: {
    organizationId: string;
    registryUrl: string;
    validationStatus: string;
    tokenCiphertext: string;
    tokenNonce: string;
  };
  actorUserId: string;
  allowInsecureLocalhost?: boolean;
}): Promise<TokenForDiscovery> {
  const { db, env, connection, actorUserId, allowInsecureLocalhost } = input;
  const token = await decryptNpmToken(env, connection);

  if (connection.validationStatus === "valid") {
    return { token, registryUrl: connection.registryUrl };
  }
  if (connection.validationStatus === "invalid") {
    throw new InvalidNpmConnectionError(connection.organizationId);
  }

  const validation = await validateNpmCredential(connection.registryUrl, token, {
    allowInsecureLocalhost,
  });
  const validationStatus = validation.ok
    ? "valid"
    : credentialValidationAuthFailed(validation)
      ? "invalid"
      : "unvalidated";
  await Promise.all([
    updateNpmConnectionValidation(db, {
      organizationId: connection.organizationId,
      validationStatus,
      capabilities: validation.capabilities,
      validatedAt: validation.ok ? new Date() : null,
    }),
    recordScanEvent(db, {
      organizationId: connection.organizationId,
      actorUserId,
      type: "npm_connection.validated",
      metadata: {
        ok: validation.ok,
        status: validation.status,
        capabilities: validation.capabilities,
        source: "auto_discovery",
      },
    }),
  ]);
  if (!validation.ok) throw new InvalidNpmConnectionError(connection.organizationId, validation);
  return { token, registryUrl: connection.registryUrl };
}

export async function discoverAndQueueStagedPublishes(
  input: DiscoverStagedPublishesInput,
  connection: TokenForDiscovery,
): Promise<DiscoverStagedPublishesResult> {
  const {
    db,
    env,
    executionCtx,
    organizationId,
    actorUserId,
    source,
    allowInsecureLocalhost,
    afterStageId,
    scheduleContinuation,
  } = input;

  const stagedItems = await listAllStagedPublishes(connection, {
    perPage: 50,
    allowInsecureLocalhost,
  });
  await markNpmConnectionUsed(db, organizationId);
  const remainingItems = stagedItemsAfterCursor(stagedItems, afterStageId);
  const stageIds = remainingItems.map((item) => item.id);
  const existingStageIds = await listExistingScanStageIds(db, organizationId, stageIds);
  const scanCandidates = filterNewStagedPublishesByStageId(remainingItems, existingStageIds);
  // Each org sweep runs in its own invocation (one discovery-queue message), so
  // there is no cross-org start coordination here — and none is needed.
  // `listExistingScanStageIds` above suppresses duplicates within the org, and
  // the same staged publish being reviewed by two organizations that can both
  // see it is intended: each gets its own scan row, and the AI gateway cache
  // absorbs the repeated analysis.
  // Scan rows are created before their bounded slice is dispatched, so every
  // row in that slice is tracked as it happens: if a later candidate throws (a D1
  // error, a registry probe failure), the rows already written would otherwise
  // stay `pending` forever with no queue message behind them — invisible work
  // that also suppresses itself from the next sweep's dedup.
  const invocationCandidates = scheduleContinuation
    ? scanCandidates.slice(0, STAGED_PUBLISH_SCAN_PREPARE_BATCH_SIZE)
    : scanCandidates;
  // A dedicated discovery queue resets the subrequest budget between slices.
  // Without it, preserve the old safe fallback: hand off each completed row
  // before preparing another, so termination cannot strand a whole slice.
  const preparationBatchSize = env.DISCOVERY_QUEUE ? STAGED_PUBLISH_SCAN_PREPARE_BATCH_SIZE : 1;
  const startedScans: StartedStagedPublishScan[] = [];
  for (let offset = 0; offset < invocationCandidates.length; offset += preparationBatchSize) {
    const candidates = invocationCandidates.slice(offset, offset + preparationBatchSize);
    const created: PreparedScanStart[] = [];
    let prepared: (PreparedScanStart | null)[];
    try {
      prepared = await mapWithConcurrency<StagedPublishItem, PreparedScanStart | null>(
        candidates,
        STAGED_PUBLISH_SCAN_START_CONCURRENCY,
        async (item) => {
          const stageId = item.id;
          const access = await checkStagedPublishAccess(
            connection.registryUrl,
            connection.token,
            stageId,
            { allowInsecureLocalhost },
          );
          if (!access.allowed) return null;
          const scanId = crypto.randomUUID();
          const detail = await createScanJob(db, {
            id: scanId,
            stageId,
            organizationId,
            ownerUserId: actorUserId,
            source,
            packageName: item.packageName,
            stagedVersion: item.version,
          });
          if (!detail) return null;
          const start: PreparedScanStart = {
            scanId,
            message: { stageId, scanId, organizationId, actorUserId, source },
            startedScan: {
              id: scanId,
              stageId,
              packageName: item.packageName,
              version: item.version,
              tag: item.tag,
              access: item.access,
              actor: item.actor,
              createdAt: item.createdAt,
            },
          };
          created.push(start);
          return start;
        },
      );
    } catch (err) {
      await deletePendingScans(db, organizationId, created);
      throw err;
    }
    const preparedStarts = prepared.filter(isPreparedScanStart);
    await dispatchPreparedScans({
      db,
      env,
      executionCtx,
      organizationId,
      source,
      prepared: preparedStarts,
    });
    startedScans.push(...preparedStarts.map((start) => start.startedScan));
  }

  const deferred = scanCandidates.length - invocationCandidates.length;
  if (deferred > 0) {
    const lastExamined = invocationCandidates[invocationCandidates.length - 1];
    if (lastExamined) scheduleContinuation?.(lastExamined.id);
  }

  return {
    found: stageIds.length,
    created: startedScans.length,
    skipped: stageIds.length - startedScans.length - deferred,
    queued: Boolean(env.SCAN_QUEUE),
    scans: startedScans,
    deferred,
  };
}

function stagedItemsAfterCursor(
  stagedItems: readonly StagedPublishItem[],
  afterStageId?: string,
): readonly StagedPublishItem[] {
  if (!afterStageId) return stagedItems;
  const cursorIndex = stagedItems.findIndex((item) => item.id === afterStageId);
  return cursorIndex < 0 ? stagedItems : stagedItems.slice(cursorIndex + 1);
}

async function listAllStagedPublishes(
  connection: TokenForDiscovery,
  options: { perPage: number; allowInsecureLocalhost?: boolean },
): Promise<StagedPublishItem[]> {
  const byId = new Map<string, StagedPublishItem>();
  let page = await listStagedPublishes(connection.registryUrl, connection.token, options);
  for (const item of page.items) byId.set(item.id, item);

  const perPage = page.perPage ?? options.perPage;
  let nextPage = typeof page.page === "number" ? page.page + 1 : 1;
  for (let pagesFetched = 1; pagesFetched < 100; pagesFetched++) {
    if (page.total !== null && byId.size >= page.total) break;
    if (page.items.length < perPage) break;

    page = await listStagedPublishes(connection.registryUrl, connection.token, {
      ...options,
      page: nextPage,
    });
    if (!page.items.length) break;
    for (const item of page.items) byId.set(item.id, item);
    nextPage = typeof page.page === "number" ? page.page + 1 : nextPage + 1;
  }

  return [...byId.values()];
}

export { StagedPublishesFetchError };

/**
 * Hand one prepared slice to the scan queue in batches of at most
 * `SCAN_QUEUE_SEND_BATCH_SIZE`. Production slices are capped at 50, so they cost
 * one queue round trip instead of 50; the no-discovery-queue fallback passes one
 * row at a time so every completed row is handed off immediately.
 *
 * The invariant is the same as the per-message version — never leave a scan row
 * pending with no queue message behind it, because that row is invisible work
 * that also suppresses itself from the next sweep's dedup — but batching changes
 * the semantics in two ways worth stating:
 *
 * 1. Failure is coarser within a production slice. A failure while preparing
 *    discards that unqueued slice; earlier slices are already on the queue.
 * 2. A rejected `sendBatch` does not prove nothing was delivered — the failure
 *    may be on the response path. Rolling the row back after the message was in
 *    fact delivered leaves a message pointing at a deleted scan, which the
 *    consumer reports as a `scan_row_missing` skip (see `executeScanJob`)
 *    rather than the misleading `already_terminal`. Benign, but it is a real
 *    at-least-once artifact, not an impossibility.
 */
async function dispatchPreparedScans(input: {
  db: AppDb;
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  organizationId: string;
  source: ScanSource;
  prepared: readonly PreparedScanStart[];
}): Promise<void> {
  const { db, env, executionCtx, organizationId, source, prepared } = input;
  if (!prepared.length) return;

  const queue = env.SCAN_QUEUE;
  if (!queue) {
    // Local/dev fallback: no queue binding, so run each scan on the invocation.
    for (const start of prepared) {
      recordScanQueuedEvent(env, organizationId, source);
      executionCtx.waitUntil(runScanInline(env, executionCtx, start.message, db));
    }
    return;
  }

  for (let offset = 0; offset < prepared.length; offset += SCAN_QUEUE_SEND_BATCH_SIZE) {
    const batch = prepared.slice(offset, offset + SCAN_QUEUE_SEND_BATCH_SIZE);
    try {
      await queue.sendBatch(batch.map((start) => ({ body: start.message })));
    } catch (err) {
      await deletePendingScans(db, organizationId, prepared.slice(offset));
      throw err;
    }
    batch.forEach(() => recordScanQueuedEvent(env, organizationId, source));
  }
}

/** Drop scan rows that were created but never handed to the scan queue. */
async function deletePendingScans(
  db: AppDb,
  organizationId: string,
  starts: readonly PreparedScanStart[],
): Promise<void> {
  await deletePendingScanJobs(
    db,
    starts.map((start) => start.scanId),
    organizationId,
  );
}

function recordScanQueuedEvent(
  env: Cloudflare.Env,
  organizationId: string,
  source: ScanSource,
): void {
  recordProductEvent(env, { name: "scan.queued", organizationId, ecosystem: "npm", source });
}

function filterNewStagedPublishesByStageId(
  stagedItems: readonly StagedPublishItem[],
  existingStageIds: ReadonlySet<string>,
) {
  const seenStageIds = new Set(existingStageIds);
  return stagedItems.filter((item) => {
    if (seenStageIds.has(item.id)) return false;
    seenStageIds.add(item.id);
    return true;
  });
}

function isPreparedScanStart(start: PreparedScanStart | null): start is PreparedScanStart {
  return start !== null;
}

/**
 * The no-queue fallback used by local dev and tests.
 *
 * `executeScanJob` records its own terminal state, so anything that escapes it
 * is unexpected — a D1 write failing after the request that scheduled this has
 * already returned, say. Left bare it becomes an unhandled rejection with no
 * scan and no log attached to it, which is the least useful shape a failure can
 * take.
 */
function runScanInline(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: ScanQueueMessage,
  db: AppDb,
): Promise<unknown> {
  return executeScanJob(env, executionCtx, message, db, { finalAttempt: true }).catch((err) => {
    emitOperationalEvent("error", "scan.job.unhandled", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      stageId: message.stageId,
      error: describeOperationalError(err),
    });
    return null;
  });
}
