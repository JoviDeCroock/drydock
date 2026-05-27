import {
  claimScanForRun,
  createDb,
  discardScanAttempt,
  getNpmConnection,
  markNpmConnectionUsed,
  markScanFailed,
  recordScanEvent,
  type AppDb,
  type ScanSource,
  type WorkspaceSession,
} from "../db";
import { npmAdapter } from "./adapters/npm";
import { errorMessage } from "./errors";
import { notifyScanCompletion } from "./notify";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
import { runScanPipeline } from "./scan-pipeline";
import { sandboxErrorDetail } from "./sandbox";
import type { ScanInput } from "../types";

export interface ScanQueueMessage extends ScanInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
  source?: ScanSource;
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
  const startedAtMs = Date.now();
  const attempt = options.attempt ?? 1;
  const session: WorkspaceSession = { userId: message.actorUserId };
  const claimed = await claimScanForRun(db, message.scanId, message.organizationId);
  if (!claimed) {
    emitOperationalEvent("warn", "scan.job.skipped", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      stageId: message.stageId,
      source: message.source ?? "manual",
      attempt,
      reason: "already_terminal",
      durationMs: durationMsSince(startedAtMs),
    });
    return null;
  }
  await recordScanEvent(db, {
    organizationId: message.organizationId,
    actorUserId: message.actorUserId,
    scanId: message.scanId,
    type: "scan.started",
    metadata: { stageId: message.stageId, attempt },
  });

  try {
    const npmConnection = await getNpmConnection(db, message.organizationId);
    if (!npmConnection) {
      throw new Error("Connect an organization npm token before scanning staged publishes.");
    }
    if (npmConnection.validationStatus !== "valid") {
      throw new Error("Validate the organization npm token before scanning staged publishes.");
    }

    await Promise.all([
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

    const result = await runScanPipeline({ env, executionCtx, db, session }, npmAdapter, {
      scanId: message.scanId,
      stageId: message.stageId,
      maxFiles: message.maxFiles,
      maxBytesPerFile: message.maxBytesPerFile,
      organizationId: message.organizationId,
    });
    emitOperationalEvent("info", "scan.job.completed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      stageId: message.stageId,
      source: message.source ?? "manual",
      attempt,
      durationMs: durationMsSince(startedAtMs),
      packageName: result.package?.name ?? null,
      releaseRisk: result.risk,
    });
    if (message.source === "auto_discovery") {
      executionCtx.waitUntil(
        notifyScanCompletion({
          env,
          db,
          scanId: message.scanId,
          organizationId: message.organizationId,
          ownerUserId: message.actorUserId,
          outcome: "complete",
        }),
      );
    }
    return result;
  } catch (err) {
    const safe = classifyScanError(err);
    if (!safe.retryable || options.finalAttempt) {
      const skip =
        message.source === "auto_discovery" && safe.code === "staged_tarball_unavailable";
      if (skip) {
        await recordScanEvent(db, {
          organizationId: message.organizationId,
          actorUserId: message.actorUserId,
          type: "scan.skipped",
          metadata: {
            scanId: message.scanId,
            stageId: message.stageId,
            attempt,
            error: safe,
          },
        });
        await discardScanAttempt(db, message.scanId, message.organizationId);
        emitOperationalEvent("warn", "scan.job.skipped", {
          scanId: message.scanId,
          organizationId: message.organizationId,
          stageId: message.stageId,
          source: message.source,
          attempt,
          reason: "staged_tarball_unavailable",
          durationMs: durationMsSince(startedAtMs),
          error: safe,
        });
      } else {
        await Promise.all([
          markScanFailed(db, message.scanId, message.organizationId, safe),
          recordScanEvent(db, {
            organizationId: message.organizationId,
            actorUserId: message.actorUserId,
            scanId: message.scanId,
            type: "scan.failed",
            metadata: { stageId: message.stageId, attempt, error: safe },
          }),
        ]);
        emitOperationalEvent("error", "scan.job.failed", {
          scanId: message.scanId,
          organizationId: message.organizationId,
          stageId: message.stageId,
          source: message.source ?? "manual",
          attempt,
          finalAttempt: Boolean(options.finalAttempt),
          durationMs: durationMsSince(startedAtMs),
          error: safe,
        });
        if (message.source === "auto_discovery") {
          executionCtx.waitUntil(
            notifyScanCompletion({
              env,
              db,
              scanId: message.scanId,
              organizationId: message.organizationId,
              ownerUserId: message.actorUserId,
              outcome: "failed",
              error: safe,
            }),
          );
        }
      }
    } else {
      await recordScanEvent(db, {
        organizationId: message.organizationId,
        actorUserId: message.actorUserId,
        scanId: message.scanId,
        type: "scan.retryable_failed",
        metadata: { stageId: message.stageId, attempt, error: safe },
      });
      emitOperationalEvent("warn", "scan.job.retryable_failed", {
        scanId: message.scanId,
        organizationId: message.organizationId,
        stageId: message.stageId,
        source: message.source ?? "manual",
        attempt,
        durationMs: durationMsSince(startedAtMs),
        error: safe,
      });
    }
    throw err;
  }
}

export function classifyScanError(err: unknown): SafeScanError {
  const detail = sandboxErrorDetail(err);
  if (detail !== null) {
    const sandbox = parseSandboxDetail(detail);
    return {
      code: sandbox.code,
      message: sandbox.message,
      retryable: sandbox.retryable,
    };
  }
  const message = errorMessage(err);
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
  emitOperationalEvent("error", "scan.error.unclassified", {
    error: describeOperationalError(err),
  });
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
