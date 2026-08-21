import { type AppDb, type WorkspaceSession, createDb } from "../../db/client";
import { getNpmConnection, markNpmConnectionUsed } from "../../db/npm-connections";
import {
  type ScanSource,
  getScanReleaseIdentity,
  claimScanForRun,
  discardScanAttempt,
  markScanFailed,
  recordRegistryVersionStatus,
} from "../../db/scans";
import { lookupStagedReleaseFate } from "../ecosystems/npm/release-outcome";
import {
  isTerminalNpmVersionStatus,
  type NpmVersionStatus,
} from "../ecosystems/npm/version-status";
import { getStagedAdapter } from "../ecosystems";
import { errorMessage } from "../platform/errors";
import { notifyScanCompletion } from "../notify";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { runScanPipeline } from "./pipeline";
import { sandboxErrorDetail } from "../sandbox";
import type { ScanInput } from "../../types";
import { recordProductEvent } from "../platform/analytics";

export interface ScanQueueMessage extends ScanInput {
  scanId: string;
  organizationId: string;
  actorUserId: string;
  source?: ScanSource;
}

/**
 * A resolved PyPI workflow gate to review. The gate row already holds the
 * installation, release target, run, and callback URL, so the message only
 * needs to point at it. `kind` discriminates this from the npm scan messages
 * that flow over the same queue.
 */
export interface WorkflowGateQueueMessage {
  kind: "workflow_gate";
  organizationId: string;
  gateId: string;
}

export type QueueMessage = ScanQueueMessage | WorkflowGateQueueMessage;

export function isWorkflowGateMessage(message: QueueMessage): message is WorkflowGateQueueMessage {
  return "kind" in message && message.kind === "workflow_gate";
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

  try {
    const npmConnection = await getNpmConnection(db, message.organizationId);
    if (!npmConnection) {
      throw new Error("Connect an organization npm token before scanning staged publishes.");
    }
    if (npmConnection.validationStatus !== "valid") {
      throw new Error("Validate the organization npm token before scanning staged publishes.");
    }
    const releaseIdentity = await getScanReleaseIdentity(
      db,
      message.scanId,
      message.organizationId,
    );
    if (!releaseIdentity?.registryUrl) {
      throw new Error("The queued scan is missing its captured npm registry.");
    }
    if (npmConnection.registryUrl !== releaseIdentity.registryUrl) {
      throw new Error("The organization npm registry changed after this scan was queued.");
    }

    await markNpmConnectionUsed(db, message.organizationId);

    // Staged-publish scans are npm-only; resolving through the registry keeps
    // the capability declaration authoritative rather than decorative.
    const result = await runScanPipeline(
      { env, executionCtx, db, session },
      getStagedAdapter("npm"),
      {
        scanId: message.scanId,
        stageId: message.stageId,
        maxFiles: message.maxFiles,
        organizationId: message.organizationId,
        source: message.source ?? "manual",
        registryUrl: releaseIdentity.registryUrl,
      },
    );
    emitOperationalEvent("info", "scan.job.completed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      stageId: message.stageId,
      source: message.source ?? "manual",
      attempt,
      durationMs: durationMsSince(startedAtMs),
      packageName: result.package?.name ?? null,
      releaseRisk: result.riskSummary.releaseRisk,
      artifactRisk: result.risk,
    });
    if (message.source !== "workflow_gate") {
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
    const classified = classifyScanError(err);
    // A staged tarball we cannot read is the one failure whose cause we can
    // actually go and ask about, and the default reading of it ("your token is
    // wrong") is the least likely one. Refine before deciding anything.
    const { error: safe, registryStatus } = await refineStagedFailure(env, db, message, classified);
    if (!safe.retryable || options.finalAttempt) {
      const skip =
        message.source === "auto_discovery" && AUTO_DISCOVERY_DISCARD_CODES.has(safe.code);
      if (skip) {
        await discardScanAttempt(db, message.scanId, message.organizationId);
        emitOperationalEvent("warn", "scan.job.skipped", {
          scanId: message.scanId,
          organizationId: message.organizationId,
          stageId: message.stageId,
          source: message.source,
          attempt,
          reason: safe.code,
          registryStatus,
          durationMs: durationMsSince(startedAtMs),
          error: safe,
        });
        // Terminal counterpart to this scan's `scan.queued`, so a discovered
        // candidate that npm removed before we could review it does not read
        // as a scan that queued and vanished.
        recordProductEvent(env, {
          name: "scan.discarded",
          organizationId: message.organizationId,
          ecosystem: "npm",
          source: message.source ?? "auto_discovery",
          reason: safe.code,
          durationMs: durationMsSince(startedAtMs),
        });
      } else {
        await markScanFailed(db, message.scanId, message.organizationId, safe);
        // Failed scans are not part of the background outcome sweep, so persist
        // only statuses that cannot subsequently change. The refined error
        // already explains a published release; storing that nonterminal
        // snapshot here would leave a green "published" badge after deletion.
        if (isTerminalNpmVersionStatus(registryStatus)) {
          await recordRegistryVersionStatus(db, {
            scanId: message.scanId,
            organizationId: message.organizationId,
            status: registryStatus,
          }).catch(() => undefined);
        }
        // Counted only on a terminal failure, so a scan that succeeds on retry
        // is not filed as a failure in the aggregate.
        recordProductEvent(env, {
          name: "scan.failed",
          organizationId: message.organizationId,
          ecosystem: "npm",
          source: message.source ?? "manual",
          code: safe.code,
          durationMs: durationMsSince(startedAtMs),
        });
        emitOperationalEvent("error", "scan.job.failed", {
          scanId: message.scanId,
          organizationId: message.organizationId,
          stageId: message.stageId,
          source: message.source ?? "manual",
          attempt,
          finalAttempt: Boolean(options.finalAttempt),
          durationMs: durationMsSince(startedAtMs),
          registryStatus,
          error: safe,
        });
        if (message.source !== "workflow_gate") {
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

/**
 * Terminal classifications that mean the staged release itself went away, as
 * opposed to the review failing. Auto-discovered candidates in this family are
 * discarded rather than shown as failures: nobody asked for the scan, and the
 * thing it was going to review no longer exists.
 */
const AUTO_DISCOVERY_DISCARD_CODES = new Set([
  "staged_tarball_unavailable",
  "staged_release_published",
  "staged_release_deleted",
  "staged_release_blocked",
]);

export interface RefinedScanFailure {
  error: SafeScanError;
  registryStatus: NpmVersionStatus | null;
}

/**
 * Narrow a staged-tarball failure using what npm says became of the release.
 *
 * The mapping from lifecycle status to failure lives in the npm adapter; this
 * only decides when it is safe to ask. Workflow-gate reviews are excluded
 * because they are not staged publishes and span three ecosystems — npm's stage
 * lifecycle has nothing to say about a PyPI or VS Code release. Strictly
 * advisory: an unanswerable lookup leaves the classification untouched.
 */
export async function refineStagedFailure(
  env: Cloudflare.Env,
  db: AppDb,
  message: ScanQueueMessage,
  error: SafeScanError,
): Promise<RefinedScanFailure> {
  if (error.code !== "staged_tarball_unavailable" || message.source === "workflow_gate") {
    return { error, registryStatus: null };
  }
  const fate = await lookupStagedReleaseFate(env, db, message.scanId, message.organizationId);
  if (!fate) return { error, registryStatus: null };
  return {
    // Every refined code is as terminal as the one it replaces: the staged
    // bytes are gone, and no retry brings them back.
    error: fate.failure ? { ...fate.failure, retryable: false } : error,
    registryStatus: fate.status,
  };
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
  if (message.includes("staged candidate changed after scan selection")) {
    return {
      code: "staged_candidate_changed",
      message: "The staged candidate changed before its review started.",
      retryable: false,
    };
  }
  if (message.includes("staged release not found")) {
    return {
      code: "staged_tarball_unavailable",
      message: "The staged candidate is no longer available for review.",
      retryable: false,
    };
  }
  if (message.includes("queued scan is missing its captured npm registry")) {
    return {
      code: "npm_registry_identity_missing",
      message:
        "This queued scan has no captured npm registry. Run a new scan against the current connection.",
      retryable: false,
    };
  }
  if (message.includes("npm registry changed after this scan was queued")) {
    return {
      code: "npm_connection_changed",
      message:
        "The organization npm registry changed after this scan was queued. Run a new scan against the current connection.",
      retryable: false,
    };
  }
  if (message.includes("staged release identity changed after this scan was queued")) {
    return {
      code: "staged_release_identity_changed",
      message:
        "The staged release identity changed after this scan was queued. Run a new scan from the current staged release.",
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
