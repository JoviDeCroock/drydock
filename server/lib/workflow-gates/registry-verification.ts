import type { AppDb } from "../../db/client";
import { createDb } from "../../db/client";
import {
  getOrRecordRegistryMismatchObservedAt,
  listGateScansPendingRegistryVerification,
  listGatesPendingRegistryVerification,
  markGateRegistryVerificationAttempted,
  markScanRegistryVerified,
  recordRegistryDigestMismatch,
} from "../../db/scans";
import { getWorkflowGateAdapter } from "../ecosystems";
import { extractReleaseProvenance } from "../ecosystems/provenance";
import { getGateForOrganization } from "../github-app/webhook-gates";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { purgePublicFeedCache, scanDistTag } from "../public-feed";

export interface RegistryVerificationQueueMessage {
  kind: "registry_verification";
  organizationId: string;
  gateId: string;
}

export const REGISTRY_VERIFICATION_INITIAL_DELAY_SECONDS = 120;
export const REGISTRY_VERIFICATION_MISMATCH_GRACE_MS = 15 * 60 * 1000;

export interface RegistryVerificationJobResult {
  verified: number;
  pending: number;
  mismatched: number;
}

/** Compare every approved package in one gate with its published registry row. */
export async function executeRegistryVerificationJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: RegistryVerificationQueueMessage,
  db: AppDb = createDb(env.DB),
  now = new Date(),
): Promise<RegistryVerificationJobResult> {
  const result = { verified: 0, pending: 0, mismatched: 0 };
  const gate = await getGateForOrganization(db, message.organizationId, message.gateId);
  if (!gate || gate.status !== "approved" || !gate.decidedAt) return result;

  const scans = await listGateScansPendingRegistryVerification(
    db,
    message.organizationId,
    message.gateId,
  );
  for (const scan of scans) {
    const summary =
      scan.summaryJson && typeof scan.summaryJson === "object" && !Array.isArray(scan.summaryJson)
        ? (scan.summaryJson as { stagedPublish?: unknown })
        : null;
    const provenance = extractReleaseProvenance(summary?.stagedPublish);
    if (!provenance) {
      result.pending++;
      emitOperationalEvent("error", "workflow_gate.registry_verification.invalid_provenance", {
        organizationId: scan.organizationId,
        gateId: message.gateId,
        scanId: scan.scanId,
      });
      continue;
    }
    const adapter = getWorkflowGateAdapter(provenance.ecosystem);
    if (!adapter.verifyPublishedRelease) {
      result.pending++;
      emitOperationalEvent("error", "workflow_gate.registry_verification.unsupported", {
        organizationId: scan.organizationId,
        gateId: message.gateId,
        scanId: scan.scanId,
        ecosystem: provenance.ecosystem,
      });
      continue;
    }

    try {
      const verification = await adapter.verifyPublishedRelease(
        { env, executionCtx, db, organizationId: scan.organizationId },
        {
          packageName: scan.packageName,
          version: scan.stagedVersion,
          artifacts: provenance.artifacts,
        },
      );
      if (verification.status === "not_published") {
        result.pending++;
        continue;
      }
      if (verification.status === "mismatch") {
        const firstObservedAt = await getOrRecordRegistryMismatchObservedAt(db, {
          scanId: scan.scanId,
          organizationId: scan.organizationId,
          now,
        });
        const oldEnough =
          now.getTime() - firstObservedAt.getTime() >= REGISTRY_VERIFICATION_MISMATCH_GRACE_MS;
        if (!oldEnough) {
          result.pending++;
          continue;
        }
        const alarmed = await recordRegistryDigestMismatch(db, {
          scanId: scan.scanId,
          organizationId: scan.organizationId,
          ecosystem: provenance.ecosystem,
          packageName: scan.packageName,
          version: scan.stagedVersion,
          reviewedDigests: verification.reviewedDigests,
          publishedDigests: verification.publishedDigests,
          now,
        });
        result.mismatched++;
        if (alarmed) {
          emitOperationalEvent("error", "workflow_gate.registry_digest_mismatch", {
            organizationId: scan.organizationId,
            gateId: message.gateId,
            scanId: scan.scanId,
            ecosystem: provenance.ecosystem,
            packageName: scan.packageName,
            version: scan.stagedVersion,
            reviewedDigests: verification.reviewedDigests,
            publishedDigests: verification.publishedDigests,
          });
        }
        continue;
      }

      if (await markScanRegistryVerified(db, scan.scanId, scan.organizationId, now)) {
        result.verified++;
        purgeVerifiedPublicIdentity(env, executionCtx, scan);
        emitOperationalEvent("info", "workflow_gate.registry_digest_verified", {
          organizationId: scan.organizationId,
          gateId: message.gateId,
          scanId: scan.scanId,
          ecosystem: provenance.ecosystem,
          packageName: scan.packageName,
          version: scan.stagedVersion,
        });
      }
    } catch (err) {
      result.pending++;
      emitOperationalEvent("warn", "workflow_gate.registry_verification.deferred", {
        organizationId: scan.organizationId,
        gateId: message.gateId,
        scanId: scan.scanId,
        ecosystem: provenance.ecosystem,
        error: describeOperationalError(err),
      });
    }
  }
  return result;
}

/** Best-effort delayed enqueue after GitHub accepts an approval callback. */
export async function enqueueRegistryVerification(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: RegistryVerificationQueueMessage,
  db?: AppDb,
  now = new Date(),
): Promise<void> {
  const registryDb = db ?? createDb(env.DB);
  await markGateRegistryVerificationAttempted(registryDb, {
    organizationId: message.organizationId,
    gateId: message.gateId,
    attemptedAt: now,
  });
  if (env.SCAN_QUEUE) {
    try {
      await env.SCAN_QUEUE.send(message, {
        delaySeconds: REGISTRY_VERIFICATION_INITIAL_DELAY_SECONDS,
      });
      return;
    } catch (err) {
      emitOperationalEvent("warn", "workflow_gate.registry_verification.enqueue_failed", {
        organizationId: message.organizationId,
        gateId: message.gateId,
        error: describeOperationalError(err),
      });
      return;
    }
  }
  await executeRegistryVerificationJob(env, executionCtx, message, registryDb, now);
}

/** Cron backstop for lost queue sends and releases that were not yet visible. */
export async function runRegistryVerificationCron(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb = createDb(env.DB),
  now = new Date(),
  limit = 100,
): Promise<{ gates: number; queued: number; inline: number }> {
  const gates = await listGatesPendingRegistryVerification(db, limit, now);
  let queued = 0;
  let inline = 0;
  for (const gate of gates) {
    const message: RegistryVerificationQueueMessage = {
      kind: "registry_verification",
      organizationId: gate.organizationId,
      gateId: gate.gateId,
    };
    await markGateRegistryVerificationAttempted(db, {
      organizationId: gate.organizationId,
      gateId: gate.gateId,
      attemptedAt: now,
    });
    if (env.SCAN_QUEUE) {
      try {
        await env.SCAN_QUEUE.send(message);
        queued++;
        continue;
      } catch (err) {
        emitOperationalEvent("warn", "workflow_gate.registry_verification.cron_enqueue_failed", {
          organizationId: gate.organizationId,
          gateId: gate.gateId,
          error: describeOperationalError(err),
        });
      }
    }
    await executeRegistryVerificationJob(env, executionCtx, message, db, now);
    inline++;
  }
  return { gates: gates.length, queued, inline };
}

function purgeVerifiedPublicIdentity(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  scan: {
    publicPackageKey: string | null;
    publicFeedListedAt: Date | null;
    summaryJson: unknown;
  },
): void {
  if (!scan.publicFeedListedAt || !scan.publicPackageKey || !env.BETTER_AUTH_URL) return;
  try {
    purgePublicFeedCache(
      executionCtx,
      new URL(env.BETTER_AUTH_URL).origin,
      scan.publicPackageKey,
      scanDistTag(scan.summaryJson),
    );
  } catch {
    // Cache invalidation is best-effort; the short public cache TTL still
    // converges on the durable registry_verified_at value.
  }
}
