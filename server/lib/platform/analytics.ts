import { ANALYTICS_EVENT_NAMES, type AnalyticsEvent } from "../analytics-events";
import { emitOperationalEvent } from "./observability";

export { ANALYTICS_EVENT_NAMES, type AnalyticsEvent };

// Bump when positional mappings change. Never add PII or package evidence.
export const ANALYTICS_SCHEMA_VERSION = "1";

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
        [event.timeToDecisionMs],
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
