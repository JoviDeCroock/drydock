const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 60_000;

function retryDelayMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()))
    : 1_000;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, { fetchImpl, sleep, attempts = 3 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "drydock-verify/0.1" },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) break;
      await sleep(retryDelayMs(response));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === attempts) break;
      await sleep(1_000);
    }
  }
  throw lastError ?? new Error("request failed");
}

function assertVerdict(value) {
  if (!value || typeof value !== "object" || value.schema !== "drydock.verdict.v1") {
    throw new Error("response is not a drydock.verdict.v1 verdict");
  }
  if (
    !["clear", "notable", "needs-review"].includes(value.grade) ||
    !value.to ||
    typeof value.to !== "object" ||
    !value.capabilities ||
    typeof value.capabilities !== "object" ||
    !Array.isArray(value.capabilities.escalations) ||
    value.capabilities.escalations.some((capability) => typeof capability !== "string") ||
    typeof value.capabilities.confident !== "boolean" ||
    (value.diffUrl !== null && typeof value.diffUrl !== "string")
  ) {
    throw new Error("verdict response is incomplete");
  }
  if (value.diffUrl !== null && !["http:", "https:"].includes(new URL(value.diffUrl).protocol)) {
    throw new Error("verdict diffUrl must use HTTP or HTTPS");
  }
  return value;
}

function assertListedReview(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schema !== "drydock.review-lookup.v1" ||
    typeof value.listed !== "boolean"
  ) {
    throw new Error("response is not a drydock.review-lookup.v1 result");
  }
  return value;
}

function packagePath(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

export function createDrydockClient({
  endpoint = "https://drydock.org",
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
} = {}) {
  if (typeof fetchImpl !== "function")
    throw new Error("fetch is unavailable; Node 20 or newer is required");
  const origin = new URL(endpoint);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("endpoint must use HTTP or HTTPS");
  }

  return {
    async verdict(pair) {
      const url = new URL("/api/public/v1/package-diff/verdict", origin);
      url.searchParams.set("ecosystem", pair.ecosystem);
      url.searchParams.set("package", pair.name);
      url.searchParams.set("from", pair.from);
      url.searchParams.set("to", pair.to);
      return assertVerdict(await fetchJson(url, { fetchImpl, sleep }));
    },

    async listedReview(pair) {
      const pathname = `/public/reviews/${encodeURIComponent(pair.ecosystem)}/${packagePath(pair.name)}/${encodeURIComponent(pair.to)}`;
      return assertListedReview(await fetchJson(new URL(pathname, origin), { fetchImpl, sleep }));
    },
  };
}
