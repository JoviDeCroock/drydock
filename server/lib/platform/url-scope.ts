import { reliableFetch, reliableFetchBudgetMs, type ReliableFetchOptions } from "./reliable-fetch";

/**
 * `url`'s path relative to `base`, or null when `url` is outside `base`: a
 * different origin, a same-origin path that is not `base`'s path or below it,
 * or a path hiding a dot segment. A service hosted under a path (a registry
 * behind a reverse proxy at `/npm`) owns only that subtree of its origin, so a
 * credential scoped to the service must not follow a URL into the rest of it.
 */
export function pathWithinBaseUrl(url: URL, base: URL): string | null {
  if (url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = !basePath
    ? url.pathname
    : url.pathname.startsWith(`${basePath}/`)
      ? url.pathname.slice(basePath.length)
      : null;
  return path !== null && !hidesDotSegment(path) ? path : null;
}

const MAX_DECODE_ROUNDS = 4;

// The WHATWG parser resolves literal and `%2e` dot segments, but leaves
// `..%2f`, `..%5c`, `..;`, `..%3f` and double encoding in place, and proxies
// in front of a registry commonly decode those before routing or truncate at
// a decoded `?`, `#`, or NUL. Any of them could walk out of the subtree after
// the prefix check, so none counts as inside it, and neither does a decoded
// control character, which no registry path needs.
function hidesDotSegment(path: string): boolean {
  let decoded = path;
  for (let round = 0; ; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    if (round === MAX_DECODE_ROUNDS) return true;
    decoded = next;
  }
  // oxlint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return true;
  return decoded.split(/[/\\;?#]/).some((segment) => segment === "." || segment === "..");
}

// The Fetch standard's own limit, so only the credential rule differs from the
// runtime's default redirect handling.
const MAX_SCOPED_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET with an `authorization` header that only travels inside `base`'s
 * subtree. The runtime drops the header on a cross-origin redirect but keeps
 * it on a same-origin one, which for a service under a path means the rest of
 * its origin. Redirects are followed here instead, and the header is dropped
 * for good once a hop leaves the subtree, so a hostile service can redirect a
 * request but not the credential.
 *
 * The whole chain shares the time budget of a single {@link reliableFetch}
 * call, so a service cannot multiply timeouts and retries by redirecting. The
 * budget covers reaching the final response's headers; its body is the
 * caller's to bound, as with a plain fetch.
 */
export async function fetchWithinBaseUrl(
  input: string,
  base: string,
  options: ReliableFetchOptions = {},
): Promise<Response> {
  const scope = new URL(base);
  let url = input;
  let headers = options.headers;
  if (pathWithinBaseUrl(new URL(url), scope) === null) headers = withoutAuthorization(headers);

  const chain = chainDeadline(options.signal, reliableFetchBudgetMs(options));
  try {
    for (let hop = 0; ; hop++) {
      chain.signal?.throwIfAborted();
      const response = await reliableFetch(url, {
        ...options,
        headers,
        redirect: "manual",
        signal: chain.signal,
      });
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      if (!location) return response;
      await response.body?.cancel();
      if (hop === MAX_SCOPED_REDIRECTS) throw new Error("too many redirects");
      const next = new URL(location, url);
      // The runtime would answer a `data:` or other non-network URL itself.
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        throw new Error("redirect to a non-http(s) URL");
      }
      if (pathWithinBaseUrl(next, scope) === null) headers = withoutAuthorization(headers);
      url = next.toString();
    }
  } finally {
    chain.clear();
  }
}

// Aborts at the deadline or when the caller's signal does, and is cleared once
// headers arrive so it never cuts off a body the caller is still reading.
function chainDeadline(
  callerSignal: AbortSignal | null | undefined,
  budgetMs: number,
): { signal: AbortSignal | undefined; clear: () => void } {
  if (!Number.isFinite(budgetMs)) return { signal: callerSignal ?? undefined, clear: () => {} };
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("fetch timeout")), budgetMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function withoutAuthorization(headers: HeadersInit | undefined): Headers {
  const stripped = new Headers(headers);
  stripped.delete("authorization");
  return stripped;
}
