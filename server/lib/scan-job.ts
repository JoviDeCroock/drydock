import {
  createDb,
  getNpmConnection,
  markNpmConnectionUsed,
  markScanFailed,
  markScanRunning,
  recordScanEvent,
  type AppDb,
  type WorkspaceSession,
} from "../db";
import { decryptNpmToken } from "./npm-connection";
import { runScanPipeline } from "./scan-pipeline";
import { SandboxError } from "./sandbox";
import type { ScanInput } from "../types";

export interface ScanQueueMessage extends ScanInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
}

export async function executeScanJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: ScanQueueMessage,
  db: AppDb = createDb(env.DB),
) {
  const session: WorkspaceSession = { userId: message.actorUserId };
  await markScanRunning(db, message.scanId, message.organizationId);
  await recordScanEvent(db, {
    organizationId: message.organizationId,
    actorUserId: message.actorUserId,
    scanId: message.scanId,
    type: "scan.started",
    metadata: { stageId: message.stageId },
  });

  try {
    const npmConnection = await getNpmConnection(db, message.organizationId);
    if (!npmConnection) {
      throw new Error("Connect an organization npm token before scanning staged publishes.");
    }

    const orgNpmToken = await decryptNpmToken(env, npmConnection);
    await markNpmConnectionUsed(db, message.organizationId);
    await recordScanEvent(db, {
      organizationId: message.organizationId,
      actorUserId: message.actorUserId,
      scanId: message.scanId,
      type: "npm_connection.used",
      metadata: {
        stageId: message.stageId,
        registryUrl: npmConnection.registryUrl,
        tokenFingerprint: npmConnection.tokenFingerprint,
      },
    });

    return await runScanPipeline(
      { env, executionCtx, db, session },
      {
        scanId: message.scanId,
        stageId: message.stageId,
        maxFiles: message.maxFiles,
        maxBytesPerFile: message.maxBytesPerFile,
        organizationId: message.organizationId,
        npmToken: orgNpmToken,
        npmRegistry: npmConnection.registryUrl,
      },
    );
  } catch (err) {
    const safe = safeScanError(err);
    await markScanFailed(db, message.scanId, message.organizationId, safe);
    await recordScanEvent(db, {
      organizationId: message.organizationId,
      actorUserId: message.actorUserId,
      scanId: message.scanId,
      type: "scan.failed",
      metadata: { stageId: message.stageId, error: safe },
    });
    throw err;
  }
}

function safeScanError(err: unknown) {
  if (err instanceof SandboxError) {
    return {
      code: "sandbox_download_failed",
      message: "Could not download or inspect the staged tarball.",
      detail: err.detail,
    };
  }
  return {
    code: "scan_failed",
    message: err instanceof Error ? err.message : String(err),
  };
}
