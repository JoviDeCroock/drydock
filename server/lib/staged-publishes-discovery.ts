import {
  createScanJob,
  deletePendingScanJob,
  listExistingScanStageIds,
  markNpmConnectionInvalid,
  markNpmConnectionUsed,
  recordScanEvent,
  updateNpmConnectionValidation,
  type AppDb,
  type ScanSource,
} from "../db";
import { decryptNpmToken, validateNpmCredential } from "./npm-connection";
import { emitOperationalEvent } from "./observability";
import { executeScanJob, type ScanQueueMessage } from "./scan-job";
import {
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
  constructor(public organizationId: string) {
    super(`npm connection is not valid for org ${organizationId}`);
    this.name = "InvalidNpmConnectionError";
  }
}

export interface TokenForDiscovery {
  token: string;
  registryUrl: string;
  tokenFingerprint?: string | null;
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
    tokenFingerprint?: string | null;
  };
  actorUserId: string;
  allowInsecureLocalhost?: boolean;
}): Promise<TokenForDiscovery> {
  const { db, env, connection, actorUserId, allowInsecureLocalhost } = input;
  const token = await decryptNpmToken(env, connection);

  if (connection.validationStatus === "valid") {
    return {
      token,
      registryUrl: connection.registryUrl,
      tokenFingerprint: connection.tokenFingerprint,
    };
  }
  if (connection.validationStatus === "invalid") {
    throw new InvalidNpmConnectionError(connection.organizationId);
  }

  const validation = await validateNpmCredential(connection.registryUrl, token, {
    allowInsecureLocalhost,
  });
  await Promise.all([
    updateNpmConnectionValidation(db, {
      organizationId: connection.organizationId,
      validationStatus: validation.status,
      capabilities: validation.capabilities,
      validatedAt: validation.ok ? new Date() : null,
      failureReason: validation.ok
        ? null
        : "The organization's npm token failed validation against the registry.",
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
  if (!validation.ok) throw new InvalidNpmConnectionError(connection.organizationId);
  return {
    token,
    registryUrl: connection.registryUrl,
    tokenFingerprint: connection.tokenFingerprint,
  };
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
    const scanId = crypto.randomUUID();
    const detail = await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: actorUserId,
      source,
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

/**
 * When listing staged publishes fails because the registry rejected the token
 * (401/403), mark the org's npm connection invalid so the UI can prompt a
 * rotation. A 404 or 5xx is left alone — those are not credential problems.
 * Returns true when the connection was invalidated.
 */
export async function maybeInvalidateNpmConnectionOnFetchError(input: {
  db: AppDb;
  organizationId: string;
  actorUserId: string;
  eventSource: string;
  tokenFingerprint?: string | null;
  error: unknown;
}): Promise<boolean> {
  const { db, organizationId, actorUserId, eventSource, tokenFingerprint, error } = input;
  if (!(error instanceof StagedPublishesFetchError)) return false;
  if (error.status !== 401 && error.status !== 403) return false;
  const invalidated = await markNpmConnectionInvalid(db, {
    organizationId,
    tokenFingerprint,
    reason:
      "The organization's npm token was rejected by the registry while listing staged publishes.",
  });
  if (!invalidated) return false;
  await recordScanEvent(db, {
    organizationId,
    actorUserId,
    type: "npm_connection.invalidated",
    metadata: { reason: `staged_publishes_${error.status}`, source: eventSource },
  });
  emitOperationalEvent("warn", "npm_connection.invalidated", {
    organizationId,
    source: eventSource,
    reason: `staged_publishes_${error.status}`,
  });
  return true;
}

export { StagedPublishesFetchError };
