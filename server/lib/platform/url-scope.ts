import { reliableFetch, type ReliableFetchOptions } from "./reliable-fetch";

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
// `..%2f`, `..%5c`, `..;` and double encoding in place, and proxies in front
// of a registry commonly decode those before routing. Any of them would walk
// out of the subtree after the prefix check, so none counts as inside it.
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
  return decoded.split(/[/\\;]/).some((segment) => segment === "." || segment === "..");
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

  for (let hop = 0; ; hop++) {
    const response = await reliableFetch(url, { ...options, headers, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("location")
      : null;
    if (!location) return response;
    await response.body?.cancel();
    if (hop === MAX_SCOPED_REDIRECTS) throw new Error("too many redirects");
    const next = new URL(location, url);
    if (pathWithinBaseUrl(next, scope) === null) headers = withoutAuthorization(headers);
    url = next.toString();
  }
}

function withoutAuthorization(headers: HeadersInit | undefined): Headers {
  const stripped = new Headers(headers);
  stripped.delete("authorization");
  return stripped;
}
