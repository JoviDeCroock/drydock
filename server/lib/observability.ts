export {
  emitOperationalEvent,
  projectOperationalEvent,
  sanitizeOperationalFields,
} from "./telemetry/emit";
export type {
  OperationalEventFields as OperationalFields,
  OperationalEventLevel,
} from "./telemetry/events";

export function durationMsSince(startedAtMs: number, nowMs = Date.now()) {
  return Math.max(0, nowMs - startedAtMs);
}

export function describeOperationalError(err: unknown) {
  const value = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const code = typeof value?.code === "string" ? value.code : "internal.unclassified";
  const retryable = typeof value?.retryable === "boolean" ? value.retryable : true;
  return { code, retryable, customerVisible: false };
}
