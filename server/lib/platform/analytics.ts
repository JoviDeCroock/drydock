import { emitOperationalEvent } from "./observability";

// Bump when positional mappings change. Never add PII or package evidence.
export const ANALYTICS_SCHEMA_VERSION = "1";

export type AnalyticsEvent =
  | {
      name: "scan.queued";
      organizationId: string;
      ecosystem: string;
      source: string;
    }
  | {
      name: "scan.completed";
      organizationId: string;
      ecosystem: string;
      source: string;
      releaseRisk: string;
      artifactRisk: string;
      contextRisk: string;
      durationMs: number;
      ruleFindingCount: number;
      aiFindingCount: number;
    }
  | {
      name: "scan.failed";
      organizationId: string;
      ecosystem: string;
      source: string;
      code: string;
      durationMs: number;
    }
  | {
      name: "scan.discarded";
      organizationId: string;
      ecosystem: string;
      source: string;
      reason: string;
      durationMs: number;
    }
  | {
      name: "scan.decided";
      organizationId: string;
      ecosystem: string;
      decision: string;
      releaseRisk: string;
      artifactRisk: string;
      timeToDecisionMs: number;
      /** Distinct members who approved, against the bar the org set. */
      approvalCount: number;
      requiredApprovals: number;
    }
  | {
      name: "ai_review.finished";
      organizationId: string;
      ecosystem: string;
      status: string;
      model: string;
      reviewerVersion: string;
      durationMs: number;
      findingCount: number;
      steps: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | {
      name: "ai_review.attempted";
      ecosystem: string;
      model: string;
      reviewerVersion: string;
      outcome: string;
      action: string;
      durationMs: number;
      attempt: number;
      steps: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | {
      name: "ai_review.decided";
      organizationId: string;
      ecosystem: string;
      decision: string;
      status: string;
      releaseAssessment: string;
      model: string;
      reviewerVersion: string;
    }
  | {
      name: "npm_connection.validated";
      organizationId: string;
      outcome: string;
    }
  | {
      name: "user.signed_up";
      method: string;
      outcome: string;
    }
  | {
      name: "organization.created";
      organizationId: string;
    }
  | {
      name: "integration.connected";
      organizationId: string;
      kind: string;
      outcome: string;
    }
  | {
      name: "workflow_gate.opened";
      organizationId: string;
    }
  | {
      name: "workflow_gate.reviewed";
      organizationId: string;
      recommendation: string;
      timeoutState: string;
      durationMs: number;
      packageCount: number;
    }
  | {
      name: "workflow_gate.decided";
      organizationId: string;
      surface: string;
      decision: string;
      packageCount: number;
    }
  | {
      name: "public_diff.viewed";
      ecosystem: string;
      packageName: string;
      cache: string;
      risk: string;
      durationMs: number;
    };

export const ANALYTICS_EVENT_NAMES = [
  "scan.queued",
  "scan.completed",
  "scan.failed",
  "scan.discarded",
  "scan.decided",
  "ai_review.finished",
  "ai_review.attempted",
  "ai_review.decided",
  "npm_connection.validated",
  "public_diff.viewed",
  "user.signed_up",
  "organization.created",
  "integration.connected",
  "workflow_gate.opened",
  "workflow_gate.reviewed",
  "workflow_gate.decided",
] as const;

type AssertExtends<A extends B, B> = A;
type _EveryEventIsListed = AssertExtends<
  AnalyticsEvent["name"],
  (typeof ANALYTICS_EVENT_NAMES)[number]
>;
type _EveryListedNameExists = AssertExtends<
  (typeof ANALYTICS_EVENT_NAMES)[number],
  AnalyticsEvent["name"]
>;

export function recordProductEvent(
  env: Pick<Cloudflare.Env, "PRODUCT_ANALYTICS"> | undefined,
  event: AnalyticsEvent,
): void {
  const dataset = env?.PRODUCT_ANALYTICS;
  if (!dataset) return;
  try {
    dataset.writeDataPoint(toDataPoint(event));
  } catch (err) {
    emitOperationalEvent("warn", "analytics.write_failed", {
      event: event.name,
      error: err instanceof Error ? err.name : typeof err,
    });
  }
}

// Analytics Engine columns are positional; changing this mapping requires a schema bump.
function toDataPoint(event: AnalyticsEvent): AnalyticsEngineDataPoint {
  const base = (
    organizationId: string,
    ecosystem: string,
    blobs: string[],
    doubles: number[],
  ): AnalyticsEngineDataPoint => ({
    indexes: [event.name],
    blobs: [ANALYTICS_SCHEMA_VERSION, event.name, organizationId, ecosystem, ...blobs],
    doubles,
  });

  switch (event.name) {
    case "scan.queued":
      return base(event.organizationId, event.ecosystem, [event.source], [0]);
    case "scan.completed":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.releaseRisk, event.artifactRisk, event.contextRisk],
        [event.durationMs, event.ruleFindingCount, event.aiFindingCount],
      );
    case "scan.failed":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.code],
        [event.durationMs],
      );
    case "scan.discarded":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.reason],
        [event.durationMs],
      );
    case "scan.decided":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.decision, event.releaseRisk, event.artifactRisk],
        [event.timeToDecisionMs, event.approvalCount, event.requiredApprovals],
      );
    case "ai_review.finished":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.status, event.model, event.reviewerVersion],
        [
          event.durationMs,
          event.findingCount,
          event.steps,
          event.inputTokens,
          event.cachedInputTokens,
          event.outputTokens,
          event.totalTokens,
        ],
      );
    case "ai_review.attempted":
      return base(
        "",
        event.ecosystem,
        [event.outcome, event.action, event.model, event.reviewerVersion],
        [
          event.durationMs,
          event.attempt,
          event.steps,
          event.inputTokens,
          event.cachedInputTokens,
          event.outputTokens,
          event.totalTokens,
        ],
      );
    case "ai_review.decided":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.decision, event.status, event.releaseAssessment, event.model, event.reviewerVersion],
        [0],
      );
    case "npm_connection.validated":
      return base(event.organizationId, "npm", [event.outcome], [0]);
    case "user.signed_up":
      return base("", "", [event.method, event.outcome], [0]);
    case "organization.created":
      return base(event.organizationId, "", [], [0]);
    case "integration.connected":
      return base(event.organizationId, event.kind, [event.outcome], [0]);
    case "workflow_gate.opened":
      return base(event.organizationId, "", [], [0]);
    case "workflow_gate.reviewed":
      return base(
        event.organizationId,
        "",
        [event.recommendation, event.timeoutState],
        [event.durationMs, event.packageCount],
      );
    case "workflow_gate.decided":
      return base(
        event.organizationId,
        "",
        [event.surface, event.decision],
        [0, event.packageCount],
      );
    case "public_diff.viewed":
      return base(
        "",
        event.ecosystem,
        [event.packageName, event.cache, event.risk],
        [event.durationMs],
      );
  }
}
