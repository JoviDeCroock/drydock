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

export interface OperationalErrorSummary {
  name: string;
  message?: string;
  cause?: OperationalErrorSummary;
}

// Drizzle wraps D1 failures in "Failed query: <sql>\nparams: <bound values>".
// The bound values can carry anything a query touches (tokens, emails), so
// they never reach the logs; the SQL text itself is static application code.
function redactFailedQueryParams(message: string): string {
  if (!message.startsWith("Failed query")) return message;
  return message.replace(/\bparams:[\s\S]*$/, "params: [redacted]");
}

const ERROR_CAUSE_MAX_DEPTH = 3;

export function describeOperationalError(err: unknown, depth = 0): OperationalErrorSummary {
  if (err instanceof Error) {
    const summary: OperationalErrorSummary = {
      name: err.name,
      message: redactFailedQueryParams(err.message),
    };
    // Drizzle (and undici) surface the real failure — e.g. the underlying
    // D1_ERROR — only on `cause`; without it the log says "Failed query" and
    // nothing else, which is undiagnosable after the fact.
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && depth < ERROR_CAUSE_MAX_DEPTH) {
      summary.cause = describeOperationalError(cause, depth + 1);
    }
    return summary;
  }
  if (err && typeof err === "object") {
    const value = err as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : "UnknownError",
      message:
        typeof value.message === "string" ? redactFailedQueryParams(value.message) : undefined,
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
  // Re-sanitize the described error so its message strings (and cause chain)
  // still get the Bearer-token redaction applied to every other string.
  if (value instanceof Error) {
    return sanitizeValue(describeOperationalError(value), seen, depth + 1, null);
  }
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
