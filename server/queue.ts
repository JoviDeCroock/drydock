import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "./lib/platform/observability";
import {
  classifyScanError,
  executeScanJob,
  isDependencyReviewMessage,
  isWorkflowGateMessage,
  MAX_SCAN_JOB_ATTEMPTS,
  retryDelaySeconds,
  type QueueMessage,
} from "./lib/scan/job";
import { executeWorkflowGateJob } from "./lib/workflow-gate-job";
import { executeDependencyReviewJob } from "./lib/dependency-review/job";

/**
 * The SCAN_QUEUE consumer `server/index.ts` exports. Scan, workflow-gate, and
 * dependency-review messages share the queue; each is retried with backoff up to
 * `MAX_SCAN_JOB_ATTEMPTS` and only a retryable exhaustion rethrows.
 */
export async function queue(
  batch: MessageBatch<QueueMessage>,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const messageStartedAtMs = Date.now();
    if (isDependencyReviewMessage(message.body)) {
      const reviewMessage = message.body;
      try {
        await executeDependencyReviewJob(env, ctx, reviewMessage, {
          finalAttempt: message.attempts >= MAX_SCAN_JOB_ATTEMPTS,
        });
        emitOperationalEvent("info", "dependency_review.queue.message.completed", {
          organizationId: reviewMessage.organizationId,
          reviewId: reviewMessage.reviewId,
          approval: Boolean(reviewMessage.approver),
          attempt: message.attempts,
          durationMs: durationMsSince(messageStartedAtMs),
        });
      } catch (err) {
        if (message.attempts < MAX_SCAN_JOB_ATTEMPTS) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          emitOperationalEvent("warn", "dependency_review.queue.retry_scheduled", {
            organizationId: reviewMessage.organizationId,
            reviewId: reviewMessage.reviewId,
            attempt: message.attempts,
            nextDelaySeconds: retryDelaySeconds(message.attempts),
            error: describeOperationalError(err),
          });
        } else {
          emitOperationalEvent("error", "dependency_review.queue.message_failed", {
            organizationId: reviewMessage.organizationId,
            reviewId: reviewMessage.reviewId,
            attempt: message.attempts,
            error: describeOperationalError(err),
          });
        }
      }
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
