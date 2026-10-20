import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./lib/platform/observability";
import {
  classifyScanError,
  executeScanJob,
  isWorkflowGateMessage,
  MAX_SCAN_JOB_ATTEMPTS,
  retryDelaySeconds,
  type QueueMessage,
} from "./lib/scan/job";
import { executeWorkflowGateJob } from "./lib/workflow-gate-job";
import {
  executeDetonationJob,
  isDetonationMessage,
  MAX_DETONATION_JOB_ATTEMPTS,
  type DetonationQueueMessage,
} from "./lib/detonation/job";

/**
 * The queue consumer `server/index.ts` exports. Scan and workflow-gate
 * messages share SCAN_QUEUE and are retried with backoff up to
 * `MAX_SCAN_JOB_ATTEMPTS`; only a retryable exhaustion rethrows. Detonation
 * messages arrive on DETONATION_QUEUE.
 */
export async function queue(
  batch: MessageBatch<QueueMessage | DetonationQueueMessage>,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const messageStartedAtMs = Date.now();
    if (isDetonationMessage(message.body)) {
      const detonation = message.body;
      // The job records its own failures; only "no container could start" is
      // retried, after it has handed its claim back.
      const outcome = await executeDetonationJob(env, ctx, detonation, undefined, {
        finalAttempt: message.attempts >= MAX_DETONATION_JOB_ATTEMPTS,
      }).catch((err: unknown) => {
        emitOperationalEvent("error", "detonation.queue.message_failed", {
          organizationId: detonation.organizationId,
          scanId: detonation.scanId,
          error: describeOperationalError(err),
        });
        return "done" as const;
      });
      if (outcome === "retry") message.retry({ delaySeconds: 60 });
      continue;
    }
    if (isWorkflowGateMessage(message.body)) {
      const gateMessage = message.body;
      try {
        await executeWorkflowGateJob(env, ctx, gateMessage);
        emitOperationalEvent("info", "workflow_gate.queue.message.completed", {
          organizationId: gateMessage.organizationId,
          gateId: gateMessage.gateId,
          attempt: message.attempts,
          durationMs: durationMsSince(messageStartedAtMs),
        });
      } catch (err) {
        if (message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          emitOperationalEvent("warn", "workflow_gate.queue.retry_scheduled", {
            organizationId: gateMessage.organizationId,
            gateId: gateMessage.gateId,
            attempt: message.attempts,
            nextDelaySeconds: retryDelaySeconds(message.attempts),
            durationMs: durationMsSince(messageStartedAtMs),
            error: describeOperationalError(err),
          });
        } else {
          emitOperationalEvent("error", "workflow_gate.queue.message_failed", {
            organizationId: gateMessage.organizationId,
            gateId: gateMessage.gateId,
            attempt: message.attempts,
            durationMs: durationMsSince(messageStartedAtMs),
            error: describeOperationalError(err),
          });
          throw err;
        }
      }
      continue;
    }
    try {
      await executeScanJob(env, ctx, message.body, undefined, {
        attempt: message.attempts,
        finalAttempt: message.attempts >= MAX_SCAN_JOB_ATTEMPTS,
      });
      emitOperationalEvent("info", "scan.queue.message.completed", {
        scanId: message.body.scanId,
        organizationId: message.body.organizationId,
        stageId: message.body.stageId,
        source: message.body.source ?? "manual",
        attempt: message.attempts,
        durationMs: durationMsSince(messageStartedAtMs),
      });
    } catch (err) {
      const safe = classifyScanError(err);
      if (safe.retryable && message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        emitOperationalEvent("warn", "scan.queue.retry_scheduled", {
          scanId: message.body.scanId,
          organizationId: message.body.organizationId,
          stageId: message.body.stageId,
          source: message.body.source ?? "manual",
          attempt: message.attempts,
          nextDelaySeconds: retryDelaySeconds(message.attempts),
          durationMs: durationMsSince(messageStartedAtMs),
          error: safe,
        });
      } else {
        emitOperationalEvent("error", "scan.queue.message_failed", {
          scanId: message.body.scanId,
          organizationId: message.body.organizationId,
          stageId: message.body.stageId,
          source: message.body.source ?? "manual",
          attempt: message.attempts,
          exhausted: safe.retryable,
          durationMs: durationMsSince(messageStartedAtMs),
          error: safe,
        });
        if (safe.retryable) throw err;
      }
    }
  }
}
