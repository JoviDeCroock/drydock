import { type AppDb } from "../../../db/client";
import { mapWithConcurrency } from "../../platform/concurrency";
import { recordScanEvent } from "../../../db/events";
import { markNpmConnectionUsed, updateNpmConnectionValidation } from "../../../db/npm-connections";
import {
  type ScanSource,
  createScanJob,
  deletePendingScanJob,
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
  stageStartCoordinator?: StageStartCoordinator;
}

export interface DiscoverStagedPublishesResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
  scans: StartedStagedPublishScan[];
}

const STAGED_PUBLISH_SCAN_START_CONCURRENCY = 5;

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

export interface StageStartCoordinator {
  run<T>(stageId: string, worker: () => Promise<T>): Promise<T>;
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
    stageStartCoordinator = createStageStartCoordinator(),
  } = input;

  const stagedItems = await listAllStagedPublishes(connection, {
    perPage: 50,
    allowInsecureLocalhost,
  });
  await markNpmConnectionUsed(db, organizationId);
  const stageIds = stagedItems.map((item) => item.id);
  const existingStageIds = await listExistingScanStageIds(db, organizationId, stageIds);
  const scanCandidates = filterNewStagedPublishesByStageId(stagedItems, existingStageIds);
  const scanStarts = await mapWithConcurrency(
    scanCandidates,
    STAGED_PUBLISH_SCAN_START_CONCURRENCY,
    (item) =>
      stageStartCoordinator.run(item.id, async () => {
        const stageId = item.id;
        const access = await checkStagedPublishAccess(
          connection.registryUrl,
          connection.token,
          stageId,
          {
            allowInsecureLocalhost,
          },
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
        recordProductEvent(env, {
          name: "scan.queued",
          organizationId,
          ecosystem: "npm",
          source,
        });
        const startedScan: StartedStagedPublishScan = {
          id: scanId,
          stageId,
          packageName: item.packageName,
          version: item.version,
          tag: item.tag,
          access: item.access,
          actor: item.actor,
          createdAt: item.createdAt,
        };

        const message: ScanQueueMessage = {
          stageId,
          scanId,
          organizationId,
          actorUserId,
          source,
        };
        if (env.SCAN_QUEUE) {
          try {
            await env.SCAN_QUEUE.send(message);
          } catch (err) {
            await deletePendingScanJob(db, scanId, organizationId);
            throw err;
          }
        } else {
          executionCtx.waitUntil(runScanInline(env, executionCtx, message, db));
        }
        return startedScan;
      }),
  );
  const startedScans = scanStarts.filter(isStartedStagedPublishScan);

  return {
    found: stageIds.length,
    created: startedScans.length,
    skipped: stageIds.length - startedScans.length,
    queued: Boolean(env.SCAN_QUEUE),
    scans: startedScans,
  };
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

export function createStageStartCoordinator(): StageStartCoordinator {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(stageId, worker) {
      const previous = tails.get(stageId) ?? Promise.resolve();
      let release: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => current);
      tails.set(stageId, tail);
      await previous.catch(() => undefined);
      try {
        return await worker();
      } finally {
        release!();
        if (tails.get(stageId) === tail) tails.delete(stageId);
      }
    },
  };
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

function isStartedStagedPublishScan(
  scan: StartedStagedPublishScan | null,
): scan is StartedStagedPublishScan {
  return scan !== null;
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
