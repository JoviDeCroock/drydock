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
   * listings use this to keep the token on the API host.
   */
  followNext?(next: string): boolean;
}

/**
 * Walk a GitHub `Link: rel="next"` chain, handing each page's response to
 * `readPage`, which owns status handling and throws its caller's typed error.
 * The walk ends at the last page, at `maxPages`, at a vetoed link, or on a
 * link already visited (a malformed chain is treated like the cap, not looped).
 */
export async function paginate(
  firstUrl: string,
  options: PaginateOptions,
  readPage: (response: Response) => Promise<void>,
): Promise<void> {
  const seen = new Set<string>();
  let url = firstUrl;
  for (let page = 0; page < options.maxPages && url; page += 1) {
    if (seen.has(url)) return;
    seen.add(url);
    const response = await reliableFetch(url, { headers: options.headers });
    await readPage(response);
    const next = nextLink(response.headers.get("link"));
    url = next && (options.followNext?.(next) ?? true) ? next : "";
  }
}
