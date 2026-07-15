import { writeAnalyticsEvent } from "./analytics";
import { currentTelemetryContext, newTelemetryId } from "./context";
import { telemetryError } from "./errors";
import type {
  OperationalEventFields,
  OperationalEventLevel,
  OperationalEventName,
  OperationalTelemetryEvent,
  TelemetryOutcomeStatus,
} from "./events";

const DENIED_KEY_RE =
  /(authorization|cookie|credential|password|secret|token|ciphertext|nonce|message|detail|reason|packageName|stageId|path|url|header|body|content|evidence|manifest|prompt|response|email|name|userAgent)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;
const MEASUREMENT_KEYS = new Set([
  "attempt",
  "batchSize",
  "bytes",
  "changedFileCount",
  "concurrencyLimit",
  "contentLength",
  "durationMs",
  "diffCount",
  "elapsedMs",
  "fileCount",
  "fileSampleCount",
  "findingCount",
  "limit",
  "nextDelaySeconds",
  "organizations",
  "orgsProcessed",
  "packageCount",
  "previousFileCount",
  "reportSize",
  "retentionDays",
  "rows",
  "windowMs",
]);
const CORRELATION_KEYS = new Set(["scanId", "gateId", "deliveryId", "organizationId"]);

export function emitOperationalEvent(
  level: OperationalEventLevel,
  eventName: OperationalEventName,
  fields: OperationalEventFields = {},
): OperationalTelemetryEvent {
  const telemetry = projectOperationalEvent(level, eventName, fields);
  if (level === "error") console.error(telemetry);
  else if (level === "warn") console.warn(telemetry);
  else console.log(telemetry);
  scheduleAnalyticsWrite(telemetry);
  return telemetry;
}

export function projectOperationalEvent(
  level: OperationalEventLevel,
  eventName: OperationalEventName,
  fields: OperationalEventFields = {},
): OperationalTelemetryEvent {
  const context = currentTelemetryContext();
  const phase = phaseFor(eventName, fields.error);
  const status = outcomeFor(level, eventName);
  const failed = status === "failure" || status === "retry";
  const error = failed ? telemetryError(eventName, phase, fields.error ?? fields.reason) : null;
  const eventId = newTelemetryId("evt");
  const measurements: Record<string, number> = {};
  const dimensions: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (CORRELATION_KEYS.has(key) || key === "error" || DENIED_KEY_RE.test(key)) continue;
    if (MEASUREMENT_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) {
      measurements[toSnakeCase(key)] = Math.max(0, value);
      continue;
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      dimensions[toSnakeCase(key)] = typeof value === "string" ? boundedString(value) : value;
    }
  }
  measurements.count = 1;

  return {
    event: {
      id: eventId,
      name: eventName,
      version: 1,
      occurred_at: new Date().toISOString(),
    },
    severity: level,
    service: {
      name: "drydock-worker",
      version: context.serviceVersion || "local",
      environment: context.environment || "development",
    },
    correlation: {
      request_id: context.requestId ?? null,
      journey_id: context.journeyId ?? null,
      scan_id: readString(fields.scanId),
      gate_id: readString(fields.gateId),
      delivery_id: readString(fields.deliveryId),
    },
    tenant: {
      organization_id: readString(fields.organizationId) ?? context.organizationId ?? null,
    },
    product: {
      surface: surfaceFor(eventName, fields.source),
      ecosystem: readString(fields.ecosystem) ?? readString(fields.adapterId),
      phase,
    },
    outcome: {
      status,
      error,
      reference_id: error?.customer_visible ? eventId.replace("evt_", "ref_") : null,
    },
    measurements,
    dimensions,
  };
}

export function sanitizeOperationalFields(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet(), 0, null);
}

function scheduleAnalyticsWrite(telemetry: OperationalTelemetryEvent) {
  const context = currentTelemetryContext();
  if (!context.analytics || !context.analyticsHashKey) return;
  const write = writeAnalyticsEvent(context.analytics, context.analyticsHashKey, telemetry).catch(
    () => {
      console.error(
        projectOperationalEvent("error", "telemetry.analytics_write_failed", {
          reason: "analytics_binding_write_failed",
        }),
      );
    },
  );
  context.executionCtx?.waitUntil(write);
}

function outcomeFor(level: OperationalEventLevel, eventName: string): TelemetryOutcomeStatus {
  if (eventName.includes("retry")) return "retry";
  if (eventName.endsWith(".skipped") || eventName.endsWith(".ignored")) return "skipped";
  if (
    level === "error" ||
    level === "warn" ||
    eventName.endsWith(".failed") ||
    eventName.endsWith(".error")
  ) {
    return "failure";
  }
  return "success";
}

function phaseFor(eventName: string, errorInput?: object | string | null): string {
  const errorCode =
    errorInput && typeof errorInput === "object" && "code" in errorInput
      ? String(errorInput.code)
      : "";
  if (
    errorCode.startsWith("sandbox_download") ||
    errorCode.startsWith("staged_tarball") ||
    errorCode.startsWith("registry.")
  ) {
    return "artifact_acquisition";
  }
  if (errorCode.startsWith("archive_")) return "archive_parse";
  if (errorCode.startsWith("npm_connection_")) return "integration_validation";
  if (eventName.includes("ai_review")) return "ai_review";
  if (eventName.includes("release_memory")) return "release_memory_lookup";
  if (eventName.includes("artifacts") || eventName.includes("bundle")) return "artifact_storage";
  if (eventName.includes("callback") || eventName.includes("redeliver")) return "decision_callback";
  if (eventName.includes("notification")) return "notification";
  if (eventName.includes("webhook")) return "webhook";
  if (eventName.includes("queue")) return "queue";
  if (eventName.includes("pipeline") || eventName.includes("review")) return "deterministic_review";
  if (eventName.includes("auth")) return "auth";
  if (eventName.includes("connection") || eventName.includes("registry")) {
    return "integration_validation";
  }
  if (eventName.includes("cron") || eventName.includes("prune")) return "scheduled_task";
  return "request";
}

function surfaceFor(eventName: string, source: unknown): string {
  if (eventName.startsWith("github_workflow_gate") || eventName.startsWith("workflow_gate")) {
    return "workflow_gate";
  }
  if (eventName.startsWith("staged_publishes.cron")) return "scheduled_discovery";
  if (typeof source === "string" && source) return boundedString(source);
  if (eventName.startsWith("scan")) return "scan";
  return "api";
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  key: string | null,
): unknown {
  if (key && DENIED_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string")
    return boundedString(value.replace(BEARER_RE, "Bearer [redacted]"));
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { code: "internal.unclassified" };
  if (depth > 5) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen, depth + 1, null));
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitizeValue(entryValue, seen, depth + 1, entryKey);
  }
  return output;
}

function boundedString(value: string): string {
  return value.slice(0, 120);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? boundedString(value) : null;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
