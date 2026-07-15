export const OPERATIONAL_EVENT_NAMES = [
  "audit_events.prune_failed",
  "audit_events.pruned",
  "auth.initialization_failed",
  "github_app.route_error",
  "github_webhook.apply_failed",
  "github_webhook.body_too_large",
  "github_webhook.config_error",
  "github_webhook.config_missing",
  "github_webhook.empty_body",
  "github_webhook.ignored",
  "github_webhook.invalid_content_length",
  "github_webhook.invalid_payload",
  "github_webhook.missing_headers",
  "github_webhook.signature_invalid",
  "github_workflow_gate.bundle_failed",
  "github_workflow_gate.config_error",
  "github_workflow_gate.decision_bookkeeping_failed",
  "github_workflow_gate.decision_callback_failed",
  "github_workflow_gate.decision_redelivered",
  "github_workflow_gate.job_skipped",
  "github_workflow_gate.mark_errored_failed",
  "github_workflow_gate.notification_error",
  "github_workflow_gate.redelivery_failed",
  "github_workflow_gate.rejected_artifact_error",
  "github_workflow_gate.review_failed",
  "github_workflow_gate.review_ready",
  "github_workflow_gate.timeout_imminent",
  "github_workflow_gate.timeout_missed",
  "github_workflow_gate.unsupported_ecosystem",
  "npm_connection.token_expired_alert_failed",
  "npm_connection.token_retrieval_failed",
  "npm_connection.upsert_failed",
  "npm_connection.validation_failed",
  "organization.create_failed",
  "organization.milestone.recorded",
  "organization.milestones.reconciled",
  "registry.metadata_fetch_failed",
  "request.unhandled_error",
  "scan.ai_review.completed",
  "scan.ai_review.failed",
  "scan.artifacts.backfill_digest_mismatch",
  "scan.artifacts.backfill_failed",
  "scan.artifacts.backfilled",
  "scan.artifacts.binding_missing",
  "scan.artifacts.delete_failed",
  "scan.artifacts.deleted",
  "scan.artifacts.fallback_read",
  "scan.artifacts.write_failed",
  "scan.artifacts.written",
  "scan.error.unclassified",
  "scan.job.completed",
  "scan.job.failed",
  "scan.job.retryable_failed",
  "scan.job.skipped",
  "scan.pipeline.completed",
  "scan.pipeline.failed",
  "scan.queue.message.completed",
  "scan.queue.message_failed",
  "scan.queue.retry_scheduled",
  "scan.release_memory.lookup_failed",
  "staged_publishes.cron.org_completed",
  "staged_publishes.cron.org_failed",
  "staged_publishes.cron.skipped",
  "staged_publishes.cron.started",
  "staged_publishes.cron.swept",
  "telemetry.analytics_write_failed",
  "workflow_gate.queue.message.completed",
  "workflow_gate.queue.message_failed",
  "workflow_gate.queue.retry_scheduled",
] as const;

export type OperationalEventName = (typeof OPERATIONAL_EVENT_NAMES)[number];
export type OperationalEventLevel = "info" | "warn" | "error";
export type TelemetryOutcomeStatus = "success" | "failure" | "skipped" | "retry";

export interface OperationalErrorInput {
  code?: string;
  message?: string;
  retryable?: boolean;
  customerVisible?: boolean;
  customer_visible?: boolean;
}

// Producers can supply only bounded scalar dimensions, measurements, and the
// safe error envelope. Free-form values are removed again by the sink projector.
export interface OperationalEventFields {
  adapterId?: string | null;
  artifactRisk?: string | null;
  attempt?: number;
  batchSize?: number;
  bytes?: number;
  changedFileCount?: number;
  concurrencyLimit?: number;
  contentLength?: number;
  contextRisk?: string | null;
  cutoff?: string;
  decision?: string | null;
  deliveryId?: string | null;
  detail?: string | null;
  diffCount?: number;
  durationMs?: number;
  ecosystem?: string | null;
  elapsedMs?: number;
  error?: object | string | null;
  eventName?: string | null;
  exhausted?: boolean;
  fileCount?: number;
  fileSampleCount?: number;
  finalAttempt?: boolean;
  findingCount?: number;
  gateId?: string | null;
  hasEvent?: boolean;
  hasDelivery?: boolean;
  hasSignature?: boolean;
  installationId?: string | null;
  limit?: number;
  message?: unknown;
  method?: string;
  milestone?: string;
  model?: string | null;
  nextDelaySeconds?: number;
  operation?: string;
  organizationId?: string | null;
  organizations?: number;
  orgsProcessed?: number;
  objectsDeleted?: number;
  packageCount?: number;
  packageName?: string | null;
  path?: string;
  persisted?: boolean;
  previousFileCount?: number;
  reason?: string | null;
  recommendation?: string | null;
  releaseRisk?: string | null;
  reportSize?: number;
  reportVersion?: number;
  repositoryFullName?: string | null;
  retentionDays?: number;
  rows?: number;
  runId?: number;
  scanId?: string | null;
  source?: string | null;
  stageId?: string | null;
  status?: number | string | null;
  storageVersion?: number;
  timeoutState?: string | null;
  usage?: unknown;
  windowMs?: number;
  written?: boolean;
}

export interface TelemetryError {
  code: string;
  class:
    | "product_bug"
    | "customer_configuration"
    | "external_dependency"
    | "policy_block"
    | "expected_control_flow";
  phase: string;
  retryable: boolean;
  customer_visible: boolean;
  fingerprint: string;
  owner: string;
  runbook: string;
}

export interface OperationalTelemetryEvent {
  event: {
    id: string;
    name: OperationalEventName;
    version: 1;
    occurred_at: string;
  };
  severity: OperationalEventLevel;
  service: {
    name: "drydock-worker";
    version: string;
    environment: string;
  };
  correlation: {
    request_id: string | null;
    journey_id: string | null;
    scan_id: string | null;
    gate_id: string | null;
    delivery_id: string | null;
  };
  tenant: { organization_id: string | null };
  product: {
    surface: string;
    ecosystem: string | null;
    phase: string;
  };
  outcome: {
    status: TelemetryOutcomeStatus;
    error: TelemetryError | null;
    reference_id: string | null;
  };
  measurements: Record<string, number>;
  dimensions: Record<string, string | number | boolean | null>;
}
