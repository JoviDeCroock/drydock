import { createScanJob, listExistingScanStageIds, recordScanEvent, type AppDb } from "../db";
import { getOrganizationNpmToken } from "./npm-connection";
import { executeScanJob, type ScanQueueMessage } from "./scan-job";
import { listStagedPublishes, type StartedStagedPublishScan } from "./staged-publishes";

export interface DiscoverStagedPublishesInput {
  db: AppDb;
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  organizationId: string;
  actorUserId: string;
  source: string;
}

export interface DiscoverStagedPublishesResult {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
  scans: StartedStagedPublishScan[];
}

export async function discoverAndQueueStagedPublishes(
  input: DiscoverStagedPublishesInput,
): Promise<DiscoverStagedPublishesResult> {
  const { db, env, executionCtx, organizationId, actorUserId, source } = input;

  const connection = await getOrganizationNpmToken(db, env, organizationId);
  if (!connection) {
    throw new MissingNpmConnectionError(organizationId);
  }

  const page = await listStagedPublishes(connection.registryUrl, connection.token, {
    perPage: 50,
  });
  const stagedItems = [...new Map(page.items.map((item) => [item.id, item])).values()];
  const stageIds = stagedItems.map((item) => item.id);
  const existingStageIds = await listExistingScanStageIds(db, organizationId, stageIds);
  const scans: StartedStagedPublishScan[] = [];

  for (const item of stagedItems) {
    const stageId = item.id;
    if (existingStageIds.has(stageId)) continue;
    const scanId = crypto.randomUUID();
    const detail = await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: actorUserId,
    });
    if (!detail) continue;
    existingStageIds.add(stageId);
    scans.push({
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
    };
    await recordScanEvent(db, {
      organizationId,
      actorUserId,
      scanId,
      type: env.SCAN_QUEUE ? "scan.queued" : "scan.backgrounded",
      metadata: { stageId, source },
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
      created: scans.length,
      skipped: stageIds.length - scans.length,
      source,
    },
  });

  return {
    found: stageIds.length,
    created: scans.length,
    skipped: stageIds.length - scans.length,
    queued: Boolean(env.SCAN_QUEUE),
    scans,
  };
}

export class MissingNpmConnectionError extends Error {
  constructor(readonly organizationId: string) {
    super("npm connection is not configured for this organization");
    this.name = "MissingNpmConnectionError";
  }
}
