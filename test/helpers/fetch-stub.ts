import { vi } from "vitest";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Routes global fetch by URL substring, first match wins; an unmatched URL is
// a test bug, not a 404. Returns the mock so callers can assert on calls.
// Pair with `vi.unstubAllGlobals()` in `afterEach`.
export function stubFetchRoutes(
  routes: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) return Promise.resolve(handler(url, init));
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
