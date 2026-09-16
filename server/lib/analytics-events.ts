// Product analytics event schema. `platform/analytics.ts` owns the positional
// encoding; this file is the only place the product vocabulary lives.
// Never add PII or package evidence.
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
