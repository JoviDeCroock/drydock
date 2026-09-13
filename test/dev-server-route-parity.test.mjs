import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SERVER_OWNED_PATH_PREFIXES, workerFirstRoutes } from "./e2e/worker-routes.mjs";

// Which paths the Worker owns is stated twice. `server/index.ts` states it for
// behavior: a request under one of these prefixes gets a JSON `404` instead of
// the SPA shell. `test/e2e/worker-routes.mjs` states it for routing: the local
// harness turns it into the generated Wrangler config's `run_worker_first`
// rules, which decide what reaches the Worker at all in development.
//
// Drift is silent and looks like success: a prefix the harness does not list is
// answered by Vite's SPA fallback with `200` and an HTML document, so the route
// appears to work locally while never running. That is how `/public/reports/:token`
// became unverifiable in local development (#666).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SERVER_INDEX = "server/index.ts";
const PRODUCTION = "wrangler.jsonc";
const SELF_HOST = "docs/examples/wrangler.self-host.jsonc";

function read(file) {
  return readFileSync(`${repoRoot}/${file}`, "utf8");
}

/** The `SERVER_OWNED_PATH_PREFIXES = ["…", …]` literal in server/index.ts. */
function serverOwnedPrefixes(source, file) {
  const literal = /\bSERVER_OWNED_PATH_PREFIXES\s*=\s*\[(?<body>[^\]]*)\]/.exec(source)?.groups
    ?.body;
  if (literal === undefined) {
    throw new Error(`${file}: could not find the SERVER_OWNED_PATH_PREFIXES literal`);
  }
  return [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const sorted = (values) => [...values].sort();

describe("worker-owned path parity", () => {
  const serverPrefixes = serverOwnedPrefixes(read(SERVER_INDEX), SERVER_INDEX);

  test("the parsed prefixes are not empty", () => {
    expect(serverPrefixes.length).toBeGreaterThan(2);
    expect(serverPrefixes.every((prefix) => prefix.startsWith("/"))).toBe(true);
  });

  test("the harness routes every server-owned prefix to the Worker", () => {
    expect(
      sorted(SERVER_OWNED_PATH_PREFIXES),
      "test/e2e/worker-routes.mjs must list the same prefixes server/index.ts owns. A prefix " +
        "missing there is served by Vite's SPA fallback as a 200 HTML document, so the route " +
        "silently never runs in local development.",
    ).toEqual(sorted(serverPrefixes));
  });

  test("each prefix routes its nested paths too, not just the bare path", () => {
    const rules = workerFirstRoutes();
    for (const prefix of SERVER_OWNED_PATH_PREFIXES) {
      // Without the wildcard, `/public` would reach the Worker while
      // `/public/reports/:token` — the path that actually carries the
      // capability — would not.
      expect(rules, prefix).toContain(prefix);
      expect(rules, prefix).toContain(`${prefix}/*`);
    }
  });

  test.each([PRODUCTION, SELF_HOST])("%s keeps the Worker in front of every path", (file) => {
    expect(
      /"run_worker_first":\s*true/.test(read(file)),
      `${file} must keep \`run_worker_first: true\`: the deployed Worker is the authority for ` +
        "these routes, and the local harness only approximates it.",
    ).toBe(true);
  });

  test("reads a prefix list across line breaks", () => {
    expect(
      serverOwnedPrefixes('const SERVER_OWNED_PATH_PREFIXES = [\n  "/api",\n  "/og",\n];', "x"),
    ).toEqual(["/api", "/og"]);
  });
});
