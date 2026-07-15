import type { OperationalErrorInput, TelemetryError } from "./events";

const ERROR_CODE_RE = /^[a-z][a-z0-9_.-]{2,79}$/;

export function telemetryError(
  eventName: string,
  phase: string,
  input: object | string | null | undefined,
): TelemetryError {
  const supplied = typeof input === "object" && input ? (input as OperationalErrorInput) : null;
  const suppliedCode = typeof supplied?.code === "string" ? supplied.code : null;
  const code =
    suppliedCode && ERROR_CODE_RE.test(suppliedCode) ? suppliedCode : eventErrorCode(eventName);
  const errorClass = classifyErrorCode(code, eventName);
  const retryable =
    typeof supplied?.retryable === "boolean" ? supplied.retryable : defaultRetryable(errorClass);
  const customerVisibleValue = supplied?.customerVisible ?? supplied?.customer_visible;
  const customerVisible =
    typeof customerVisibleValue === "boolean"
      ? customerVisibleValue
      : errorClass === "customer_configuration" || errorClass === "policy_block";
  const owner = ownerFor(errorClass, phase);

  return {
    code,
    class: errorClass,
    phase,
    retryable,
    customer_visible: customerVisible,
    fingerprint: `v1:${fnv1a(`${code}|${phase}`)}`,
    owner,
    runbook: `/docs/runbooks/${owner}.md`,
  };
}

function eventErrorCode(eventName: string): string {
  if (eventName === "scan.error.unclassified" || eventName === "request.unhandled_error") {
    return "internal.unclassified";
  }
  return eventName.replaceAll("_", ".");
}

function classifyErrorCode(code: string, eventName: string): TelemetryError["class"] {
  if (/(archive|artifact|policy|unsupported|too.large|too.many)/.test(code)) {
    return "policy_block";
  }
  if (/(invalid|missing|config|auth|credential|token|connection)/.test(code)) {
    return "customer_configuration";
  }
  if (/(registry|github|slack|notification|timeout|transient|callback)/.test(code)) {
    return "external_dependency";
  }
  if (/(ignored|skipped|already|unavailable)/.test(code) || eventName.endsWith(".skipped")) {
    return "expected_control_flow";
  }
  return "product_bug";
}

function defaultRetryable(errorClass: TelemetryError["class"]): boolean {
  return errorClass === "product_bug" || errorClass === "external_dependency";
}

function ownerFor(errorClass: TelemetryError["class"], phase: string): string {
  if (errorClass === "external_dependency") return "integrations";
  if (phase.includes("artifact") || phase.includes("archive")) return "scanner";
  if (phase.includes("notification")) return "notifications";
  return "platform";
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
