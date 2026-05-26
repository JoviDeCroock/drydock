import {
  createScanJob,
  listExistingScanStageIds,
  markNpmConnectionUsed,
  recordScanEvent,
  updateNpmConnectionValidation,
  type AppDb,
  type ScanSource,
} from "../db";
import { decryptNpmToken, validateNpmCredential } from "./npm-connection";
import { executeScanJob, type ScanQueueMessage } from "./scan-job";
import {
  listStagedPublishes,
  StagedPublishesFetchError,
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
  await Promise.all([
    updateNpmConnectionValidation(db, {
      organizationId: connection.organizationId,
      validationStatus: validation.status,
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
  if (!validation.ok) throw new InvalidNpmConnectionError(connection.organizationId);
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

  const page = await listStagedPublishes(connection.registryUrl, connection.token, {
    perPage: 50,
    allowInsecureLocalhost,
  });
  await markNpmConnectionUsed(db, organizationId);
  const stagedItems = [...new Map(page.items.map((item) => [item.id, item])).values()];
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
    await recordScanEvent(db, {
      organizationId,
      actorUserId,
      scanId,
      type: env.SCAN_QUEUE ? "scan.queued" : "scan.backgrounded",
      metadata: { stageId, source: eventSource },
    });
    if (env.SCAN_QUEUE) {
      await env.SCAN_QUEUE.send(message);
    } else {
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

export { StagedPublishesFetchError };
