const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface ReliableFetchOptions extends RequestInit {
  attempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryMethods?: readonly string[];
  retryStatuses?: readonly number[];
}

export async function reliableFetch(
  input: RequestInfo | URL,
  options: ReliableFetchOptions = {},
): Promise<Response> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    retryMethods,
    retryStatuses,
    ...init
  } = options;
  const method = requestMethod(input, init);
  const allowedMethods = retryMethods
    ? new Set(retryMethods.map((entry) => entry.toUpperCase()))
    : DEFAULT_RETRY_METHODS;
  const retryableStatuses = retryStatuses ? new Set(retryStatuses) : DEFAULT_RETRY_STATUSES;
  const maxAttempts = allowedMethods.has(method) ? Math.max(1, Math.floor(attempts)) : 1;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = fetchTimeout(init, timeoutMs);
    try {
      const response = await fetch(input, timeout.init);
      timeout.clear();
      if (!retryableStatuses.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      await response.body?.cancel();
      await delay(retryDelayMs(response, attempt, baseDelayMs, maxDelayMs));
    } catch (err) {
      timeout.clear();
      lastError = err;
      if (attempt === maxAttempts) break;
      await delay(retryDelayMs(null, attempt, baseDelayMs, maxDelayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  if (init.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function fetchTimeout(
  init: RequestInit,
  timeoutMs: number,
): { init: RequestInit; clear: () => void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { init, clear: () => undefined };
  }

  const controller = new AbortController();
  const originalSignal = init.signal;
  const abortFromCaller = () => controller.abort(originalSignal?.reason);
  if (originalSignal?.aborted) {
    abortFromCaller();
  } else {
    originalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("fetch timeout")), timeoutMs);

  return {
    init: { ...init, signal: controller.signal },
    clear: () => {
      clearTimeout(timer);
      originalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function retryDelayMs(
  response: Response | null,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const retryAfter = parseRetryAfterMs(response?.headers.get("retry-after") ?? null);
  if (retryAfter !== null) return Math.min(retryAfter, maxDelayMs);
  return Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
