import { reliableFetch } from "../platform/reliable-fetch";

export const GITHUB_USER_AGENT = "drydock-app";

/**
 * Request headers for the GitHub REST API. The bearer is a GitHub App JWT, an
 * installation access token, or a user access token; the API does not care
 * which, so neither does this. Callers that also send a body add its
 * `Content-Type` through `extra`.
 */
export function githubHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

export function nextLink(linkHeader: string | null): string {
  if (!linkHeader) return "";
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return "";
}

export interface PaginateOptions {
  headers: Record<string, string>;
  /**
   * Hard cap on pages fetched. Every GitHub listing is bounded here because a
   * `Link` chain is upstream-controlled: it must never decide how long a
   * Worker invocation runs.
   */
  maxPages: number;
  /**
   * Veto a `rel="next"` URL before it is fetched with `headers`. Credentialed
   * listings use this to keep the token on the API host. A veto ends the walk
   * as incomplete, because the pages behind the rejected link were never read.
   */
  followNext?(next: string): boolean;
}

/**
 * Walk a GitHub `Link: rel="next"` chain, handing each page's response to
 * `readPage`, which owns status handling and throws its caller's typed error.
 * The walk ends at the last page, at `maxPages`, at a vetoed link, or on a
 * link already visited (a malformed chain is treated like the cap, not looped).
 * Only the first of those reports `complete`; every other exit left pages
 * unread.
 */
export async function paginate(
  firstUrl: string,
  options: PaginateOptions,
  readPage: (response: Response) => Promise<void>,
): Promise<{ complete: boolean }> {
  const seen = new Set<string>();
  let url = firstUrl;
  for (let page = 0; page < options.maxPages && url; page += 1) {
    if (seen.has(url)) return { complete: false };
    seen.add(url);
    const response = await reliableFetch(url, { headers: options.headers });
    await readPage(response);
    const next = nextLink(response.headers.get("link"));
    // A vetoed link is a chain we refused to walk, not the end of one. Reporting
    // it as complete would tell a caller that fails closed on truncation that it
    // saw the whole listing — in exactly the forged-`Link` case the veto exists
    // for.
    if (next && !(options.followNext?.(next) ?? true)) return { complete: false };
    url = next;
  }
  // A remaining `next` after the cap means the listing was cut short; callers
  // decide whether that is a log line (a picker) or a failure (a decision).
  return { complete: url === "" };
}
