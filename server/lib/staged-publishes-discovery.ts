import {
  createScanJob,
  deletePendingScanJob,
  listExistingScanStageIds,
  markNpmConnectionUsed,
  recordScanEvent,
  updateNpmConnectionValidation,
  type AppDb,
  type ScanSource,
} from "../db";
import {
  decryptNpmToken,
  validateNpmCredential,
  type NpmCredentialValidation,
} from "./npm-connection";
import { notifyNpmConnectionExpired } from "./notify";
import { executeScanJob, type ScanQueueMessage } from "./scan-job";
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
}

export interface DiscoverStagedPublishesResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
  scans: StartedStagedPublishScan[];
}

export class MissingNpmConnectionError extends Error {
  constructor(public organizationId: string) {
    super(`npm connection missing for org ${organizationId}`);
    this.name = "MissingNpmConnectionError";
  }
}

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
    eventSource,
    allowInsecureLocalhost,
  } = input;

  const stagedItems = await listAllStagedPublishes(connection, {
    perPage: 50,
    allowInsecureLocalhost,
  });
  await markNpmConnectionUsed(db, organizationId);
  const stageIds = stagedItems.map((item) => item.id);
  const existingStageIds = await listExistingScanStageIds(db, organizationId, stageIds);
  const startedScans: StartedStagedPublishScan[] = [];

  for (const item of stagedItems) {
    const stageId = item.id;
    if (existingStageIds.has(stageId)) continue;
    const access = await checkStagedPublishAccess(
      connection.registryUrl,
      connection.token,
      stageId,
      {
        allowInsecureLocalhost,
      },
    );
    if (!access.allowed) continue;
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
    if (!detail) continue;
    existingStageIds.add(stageId);
    startedScans.push({
      id: scanId,
      stageId,
      packageName: item.packageName,
      version: item.version,
      tag: item.tag,
      access: item.access,
      actor: item.actor,
      createdAt: item.createdAt,
    });

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
      await recordScanEvent(db, {
        organizationId,
        actorUserId,
        scanId,
        type: "scan.queued",
        metadata: { stageId, source: eventSource },
      });
    } else {
      await recordScanEvent(db, {
        organizationId,
        actorUserId,
        scanId,
        type: "scan.backgrounded",
        metadata: { stageId, source: eventSource },
      });
      executionCtx.waitUntil(
        executeScanJob(env, executionCtx, message, db, { finalAttempt: true }),
      );
    }
  }

  // Only audit sweeps that start scans: the */15min cron emits one event per
  // connected org per run, and no-op sweeps were ~97% of all scan_events rows.
  // Sweep observability itself lives in Workers Logs (staged_publishes.cron.*).
  if (startedScans.length > 0) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId,
      type: "staged_publishes.scans_started",
      metadata: {
        found: stageIds.length,
        created: startedScans.length,
        skipped: stageIds.length - startedScans.length,
        source: eventSource,
      },
    });
  }

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
