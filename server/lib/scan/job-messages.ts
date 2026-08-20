import type { ScanSource } from "../../db/scans";
import type { ScanInput } from "../../types";

/**
 * Queue message shapes for the shared scan queue.
 *
 * These live apart from `job.ts` because the pipeline produces the `ai_review`
 * follow-up while `job.ts` consumes it: keeping the shapes in a leaf module
 * lets both sides depend on the contract without depending on each other.
 */
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

/**
 * The advisory AI review for an already-completed scan. The scan's deterministic
 * report is persisted and readable before this message is sent; the follow-up
 * only patches the review, the findings it contributed, and the risk breakdown
 * back in. Carries identifiers only — the evidence lives in the scan's
 * content-addressed AI-input artifact.
 */
export interface AiReviewQueueMessage {
  kind: "ai_review";
  scanId: string;
  stageId: string;
  organizationId: string;
  ecosystem: string;
  source?: string;
}

export type QueueMessage = ScanQueueMessage | WorkflowGateQueueMessage | AiReviewQueueMessage;

export function isWorkflowGateMessage(message: QueueMessage): message is WorkflowGateQueueMessage {
  return "kind" in message && message.kind === "workflow_gate";
}

export function isAiReviewMessage(message: QueueMessage): message is AiReviewQueueMessage {
  return "kind" in message && message.kind === "ai_review";
}
