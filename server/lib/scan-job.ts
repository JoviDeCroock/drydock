import {
  claimScanForRun,
  createDb,
  getNpmConnection,
  markNpmConnectionUsed,
  markScanFailed,
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

export const MAX_SCAN_JOB_ATTEMPTS = 3;

export interface SafeScanError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ExecuteScanJobOptions {
  attempt?: number;
  finalAttempt?: boolean;
}

export async function executeScanJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: ScanQueueMessage,
  db: AppDb = createDb(env.DB),
  options: ExecuteScanJobOptions = {},
) {
  const session: WorkspaceSession = { userId: message.actorUserId };
  const claimed = await claimScanForRun(db, message.scanId, message.organizationId);
  if (!claimed) {
    console.warn("scan queue job skipped: scan already terminal", {
      scanId: message.scanId,
      attempt: options.attempt ?? 1,
    });
    return null;
  }
  await recordScanEvent(db, {
    organizationId: message.organizationId,
    actorUserId: message.actorUserId,
    scanId: message.scanId,
    type: "scan.started",
    metadata: { stageId: message.stageId, attempt: options.attempt ?? 1 },
  });

  try {
    const npmConnection = await getNpmConnection(db, message.organizationId);
    if (!npmConnection) {
      throw new Error("Connect an organization npm token before scanning staged publishes.");
    }
    if (npmConnection.validationStatus !== "valid") {
      throw new Error("Validate the organization npm token before scanning staged publishes.");
    }

    const [orgNpmToken] = await Promise.all([
      decryptNpmToken(env, npmConnection),
      markNpmConnectionUsed(db, message.organizationId),
      recordScanEvent(db, {
        organizationId: message.organizationId,
        actorUserId: message.actorUserId,
        scanId: message.scanId,
        type: "npm_connection.used",
        metadata: {
          stageId: message.stageId,
          registryUrl: npmConnection.registryUrl,
          tokenFingerprint: npmConnection.tokenFingerprint,
        },
      }),
    ]);

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
    const safe = classifyScanError(err);
    if (!safe.retryable || options.finalAttempt) {
      await Promise.all([
        markScanFailed(db, message.scanId, message.organizationId, safe),
        recordScanEvent(db, {
          organizationId: message.organizationId,
          actorUserId: message.actorUserId,
          scanId: message.scanId,
          type: "scan.failed",
          metadata: { stageId: message.stageId, attempt: options.attempt ?? 1, error: safe },
        }),
      ]);
    } else {
      await recordScanEvent(db, {
        organizationId: message.organizationId,
        actorUserId: message.actorUserId,
        scanId: message.scanId,
        type: "scan.retryable_failed",
        metadata: { stageId: message.stageId, attempt: options.attempt ?? 1, error: safe },
      });
    }
    throw err;
  }
}

export function classifyScanError(err: unknown): SafeScanError {
  if (err instanceof SandboxError) {
    const sandbox = parseSandboxDetail(err.detail);
    return {
      code: sandbox.code,
      message: sandbox.message,
      retryable: sandbox.retryable,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Connect an organization npm token")) {
    return {
      code: "npm_connection_missing",
      message: "Connect an organization npm token before scanning staged publishes.",
      retryable: false,
    };
  }
  if (message.includes("Validate the organization npm token")) {
    return {
      code: "npm_connection_unvalidated",
      message: "Validate the organization npm token before scanning staged publishes.",
      retryable: false,
    };
  }
  console.error("scan job failed", err);
  return {
    code: "scan_failed",
    message: "The scan failed before a report could be generated.",
    retryable: true,
  };
}

function parseSandboxDetail(detail: string) {
  const parsed = parseJsonObject(detail);
  const error = typeof parsed?.error === "string" ? parsed.error : "sandbox download failed";
  const status = typeof parsed?.status === "number" ? parsed.status : undefined;
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) {
    return {
      code: "sandbox_download_transient",
      message: "The npm registry or sandbox temporarily failed while downloading release evidence.",
      retryable: true,
    };
  }
  if (status && [401, 403, 404].includes(status)) {
    return {
      code: "staged_tarball_unavailable",
      message: "The staged tarball could not be accessed with this organization's npm token.",
      retryable: false,
    };
  }
  if (error.includes("too large") || error.includes("safety limit")) {
    return {
      code: "archive_too_large",
      message: "The staged tarball exceeded the scanner's safety limits.",
      retryable: false,
    };
  }
  if (error.includes("too many files")) {
    return {
      code: "archive_too_many_files",
      message: "The staged tarball contains more files than the scanner can safely review.",
      retryable: false,
    };
  }
  if (error.includes("invalid") || error.includes("truncated")) {
    return {
      code: "archive_invalid",
      message: "The staged tarball could not be parsed safely.",
      retryable: false,
    };
  }
  return {
    code: "sandbox_download_failed",
    message: "Could not download or inspect the staged tarball.",
    retryable: false,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function retryDelaySeconds(attempt: number) {
  return Math.min(60, Math.max(5, attempt * attempt * 5));
}
