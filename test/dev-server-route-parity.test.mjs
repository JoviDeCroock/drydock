import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Which paths the Worker owns is stated twice. `server/index.ts` states it for
// behavior: a request under one of these prefixes gets a JSON `404` instead of
// the SPA shell. The e2e dev server states it for routing: its generated
// Wrangler config's `run_worker_first` rules decide what reaches the Worker at
// all in local development, since production's blanket `run_worker_first: true`
// would hand the Worker Vite's module graph and HMR requests too.
//
// Drift is silent and looks like success: a prefix the harness does not list is
// answered by Vite's SPA fallback with `200` and an HTML document, so the route
// appears to work locally while never running. That is how `/public/reports/:token`
// and `/og/*` became unverifiable in local development (#666).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SERVER_INDEX = "server/index.ts";
const DEV_SERVER = "test/e2e/dev-server.mjs";
const PRODUCTION = "wrangler.jsonc";

function read(file) {
  return readFileSync(`${repoRoot}/${file}`, "utf8");
}

/** The `SERVER_OWNED_PATH_PREFIXES = ["…", …]` literal, from either file. */
function serverOwnedPrefixes(source, file) {
  const literal = /\bSERVER_OWNED_PATH_PREFIXES\s*=\s*\[(?<body>[^\]]*)\]/.exec(source)?.groups
    ?.body;
  if (literal === undefined) {
    throw new Error(`${file}: could not find the SERVER_OWNED_PATH_PREFIXES literal`);
  }
  return [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("worker-owned path parity", () => {
  const serverPrefixes = serverOwnedPrefixes(read(SERVER_INDEX), SERVER_INDEX);
  const devServerSource = read(DEV_SERVER);

  test("the parsed prefixes are not empty", () => {
    expect(serverPrefixes.length).toBeGreaterThan(2);
    expect(serverPrefixes.every((prefix) => prefix.startsWith("/"))).toBe(true);
  });

  test("the dev server routes every server-owned prefix to the Worker", () => {
    expect(
      serverOwnedPrefixes(devServerSource, DEV_SERVER),
      `${DEV_SERVER} must route the same prefixes ${SERVER_INDEX} owns. A prefix missing there ` +
        "is served by Vite's SPA fallback as a 200 HTML document, so the route silently never " +
        "runs in local development.",
    ).toEqual(serverPrefixes);
  });

  test("the dev server derives its run_worker_first rules from that list", () => {
    expect(devServerSource).toContain("run_worker_first: workerFirstRoutes()");
  });

  test("production keeps the Worker in front of every path", () => {
    expect(
      /"run_worker_first":\s*true/.test(read(PRODUCTION)),
      `${PRODUCTION} must keep \`run_worker_first: true\`: the deployed Worker is the authority ` +
        `for these routes, and ${DEV_SERVER} only approximates it for local development.`,
    ).toBe(true);
  });

  test("reads a prefix list across line breaks", () => {
    expect(
      serverOwnedPrefixes('const SERVER_OWNED_PATH_PREFIXES = [\n  "/api",\n  "/og",\n];', "x"),
    ).toEqual(["/api", "/og"]);
  });
});
