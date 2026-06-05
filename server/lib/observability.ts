export type OperationalEventLevel = "info" | "warn" | "error";

export type OperationalFields = Record<string, unknown>;

const SENSITIVE_KEY_RE =
  /(authorization|cookie|credential|password|secret|token|ciphertext|nonce)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;

export function durationMsSince(startedAtMs: number, nowMs = Date.now()) {
  return Math.max(0, nowMs - startedAtMs);
}

export function emitOperationalEvent(
  level: OperationalEventLevel,
  event: string,
  fields: OperationalFields = {},
) {
  const payload = sanitizeOperationalFields({ event, ...fields });
  switch (level) {
    case "error":
      console.error(event, payload);
      break;
    case "warn":
      console.warn(event, payload);
      break;
    default:
      console.log(event, payload);
  }
}

export function describeOperationalError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  if (err && typeof err === "object") {
    const value = err as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : "UnknownError",
      message: typeof value.message === "string" ? value.message : undefined,
    };
  }
  return { name: typeof err };
}

export function sanitizeOperationalFields(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet(), 0, null);
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  key: string | null,
): unknown {
  if (key && SENSITIVE_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(BEARER_RE, "Bearer [redacted]");
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return describeOperationalError(value);
  if (depth > 5) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1, null));
  }

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitizeValue(entryValue, seen, depth + 1, entryKey);
  }
  return output;
}
