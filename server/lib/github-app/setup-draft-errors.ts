import { isRecord } from "../platform/guards";

type DraftFailureCategory =
  | "timeout"
  | "invalid_response"
  | "rate_limited"
  | "capacity"
  | "provider_unavailable"
  | "provider_rejected"
  | "unknown";

const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);
const INVALID_RESPONSE_NAMES = new Set([
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "ZodError",
]);
const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError", "ResponseAborted"]);

function numericField(value: unknown, minimum: number, maximum: number): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3,4}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

/** Error messages and SDK response/text fields can contain private workflow source. */
export function describeSetupDraftFailure(error: unknown): {
  category: DraftFailureCategory;
  statusCode?: number;
  providerCode?: number;
  finishReason?: string;
} {
  const fields = isRecord(error) ? error : {};
  const data = isRecord(fields.data) ? fields.data : {};
  const statusCode = numericField(fields.statusCode ?? fields.status, 100, 599);
  const providerCode = numericField(data.workersAIErrorCode ?? fields.code, 3000, 5999);
  const finishReason =
    typeof fields.finishReason === "string" && FINISH_REASONS.has(fields.finishReason)
      ? fields.finishReason
      : undefined;
  const cause = isRecord(fields.cause) ? fields.cause : {};
  let category: DraftFailureCategory = "unknown";
  if (
    (typeof fields.name === "string" && TIMEOUT_NAMES.has(fields.name)) ||
    (typeof cause.name === "string" && TIMEOUT_NAMES.has(cause.name)) ||
    statusCode === 408 ||
    statusCode === 504 ||
    providerCode === 3007 ||
    providerCode === 3008
  )
    category = "timeout";
  else if (typeof fields.name === "string" && INVALID_RESPONSE_NAMES.has(fields.name))
    category = "invalid_response";
  else if (providerCode === 3040) category = "capacity";
  else if (statusCode === 429 || providerCode === 3036) category = "rate_limited";
  else if (statusCode === 502 || statusCode === 503) category = "capacity";
  else if ((statusCode !== undefined && statusCode >= 500) || fields.isRetryable === true)
    category = "provider_unavailable";
  else if ((statusCode !== undefined && statusCode >= 400) || providerCode !== undefined)
    category = "provider_rejected";
  return {
    category,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

export function setupDraftFailureResponse(category: DraftFailureCategory): {
  code: string;
  error: string;
  status: 502 | 503 | 504;
} {
  switch (category) {
    case "timeout":
      return {
        code: "setup_ai_timeout",
        error:
          "Workflow drafting timed out. Retry or choose a smaller release workflow; your repository has not been changed.",
        status: 504,
      };
    case "invalid_response":
      return {
        code: "setup_ai_invalid_response",
        error:
          "The model did not return a valid workflow draft. Retry; your repository has not been changed.",
        status: 502,
      };
    case "rate_limited":
    case "capacity":
    case "provider_unavailable":
      return {
        code: "setup_ai_temporarily_unavailable",
        error:
          "Workflow drafting is temporarily unavailable. Wait a moment and retry; your repository has not been changed.",
        status: 503,
      };
    case "provider_rejected":
      return {
        code: "setup_ai_provider_rejected",
        error:
          "The model provider rejected workflow drafting. Ask the Drydock operator to check model access and configuration.",
        status: 503,
      };
    default:
      return {
        code: "setup_ai_unavailable",
        error:
          "The workflow draft could not be completed. Retry or use the release workflow guide; your repository has not been changed.",
        status: 503,
      };
  }
}
