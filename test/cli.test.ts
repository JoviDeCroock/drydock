import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { main } from "../cli/src/main.mjs";
import { CLI_VERSION } from "../cli/src/version.mjs";

const KEY = `ddk_${"k".repeat(43)}`;
// ESC, BEL, and the right-to-left override: what a hostile package would use
// to rewrite or reorder a reviewer's terminal.
// eslint-disable-next-line no-control-regex -- matching terminal controls is the point
const TERMINAL_CONTROL = /[\u001b\u0007\u202e]/;

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Responder = (url: string) => Response | Promise<Response>;

function harness(responder: Responder, env: Record<string, string | undefined> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  let clock = 0;
  const io = {
    env: { DRYDOCK_API_KEY: KEY, DRYDOCK_URL: "https://drydock.test", ...env },
    fetch: (async (input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        redirect: init?.redirect,
      });
      return responder(String(input));
    }) as typeof fetch,
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
    writeFile: async (path: string, data: string) => void files.set(path, data),
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
  };
  return {
    io,
    calls,
    files,
    run: (...argv: string[]) => main(argv, io),
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("drydock CLI", () => {
  test("its version matches cli/package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
  });

  test("usage errors exit 2 before any request", async () => {
    const cli = harness(() => json({}));
    expect(await cli.run()).toBe(2);
    expect(await cli.run("scans")).toBe(2);
    expect(await cli.run("scans", "get")).toBe(2);
    expect(await cli.run("scans", "list", "--filter", "everything")).toBe(2);
    expect(await cli.run("--bogus")).toBe(2);
    expect(await cli.run("releases", "..")).toBe(2);
    expect(await cli.run("scans", "wait", "abc", "--fail-on", "severe")).toBe(2);
    expect(cli.calls).toEqual([]);
    expect(await cli.run("--help")).toBe(0);
  });

  test("requires a well-formed key from the environment for organization commands", async () => {
    const missing = harness(() => json({}), { DRYDOCK_API_KEY: undefined });
    expect(await missing.run("whoami")).toBe(2);
    expect(missing.stderr).toContain("DRYDOCK_API_KEY");
    const malformed = harness(() => json({}), { DRYDOCK_API_KEY: "npm_abc" });
    expect(await malformed.run("whoami")).toBe(2);
    expect(malformed.calls).toEqual([]);
  });

  test("sends a key only over https or to loopback, and never follows redirects", async () => {
    for (const url of ["http://drydock.example", "https://user:pw@drydock.test", "not a url"]) {
      const cli = harness(() => json({}), { DRYDOCK_URL: url });
      expect(await cli.run("whoami"), url).toBe(2);
      expect(cli.calls).toEqual([]);
    }
    const local = harness(() => json({ organization: {}, key: {}, access: "read" }), {
      DRYDOCK_URL: "http://localhost:5173",
    });
    expect(await local.run("whoami")).toBe(0);
    expect(local.calls[0].url).toBe("http://localhost:5173/api/v1/api-keys/current");
    expect(local.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(local.calls[0].redirect).toBe("manual");

    const redirected = harness(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    expect(await redirected.run("whoami")).toBe(1);
    expect(redirected.calls).toHaveLength(1);
  });

  test("never prints the key, even when the server rejects it", async () => {
    const cli = harness(() =>
      json({ error: "invalid API key", code: "invalid_api_key" }, { status: 401 }),
    );
    expect(await cli.run("scans", "list")).toBe(1);
    expect(cli.stderr).toContain("invalid_api_key");
    expect(cli.stderr + cli.stdout).not.toContain(KEY);
  });

  test("diff is anonymous and fails on the release risk threshold", async () => {
    const body = {
      ecosystem: "npm",
      packageName: "left-pad",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      diff: [{ path: "index.js", status: "modified" }],
      findings: [],
      risk: { artifactRisk: "medium", releaseRisk: "high" },
      notices: [],
      cachedAt: "2026-07-15T00:00:00.000Z",
    };
    const cli = harness(() => json(body), { DRYDOCK_API_KEY: undefined });
    expect(await cli.run("diff", "left-pad", "1.0.0", "1.0.1", "--fail-on", "high")).toBe(3);
    expect(cli.calls[0].headers.authorization).toBeUndefined();
    expect(cli.calls[0].url).toBe(
      "https://drydock.test/api/public/v1/package-diff?package=left-pad&from=1.0.0&to=1.0.1",
    );
    expect(await cli.run("diff", "left-pad", "1.0.0", "1.0.1", "--fail-on", "critical")).toBe(0);
    expect(cli.stdout).toContain("release risk high");
  });

  test("strips terminal control and bidi characters from package-controlled text", async () => {
    const hostile = "\u001b]0;owned\u0007\u001b[2Jsafe‮reversed\nnext";
    const cli = harness(() =>
      json({
        scan: { id: "scan_1", packageName: hostile, stagedVersion: "1.0.0", status: "complete" },
        findings: [{ severity: "high", file: hostile, reason: hostile, evidence: hostile }],
        riskSummary: null,
      }),
    );
    expect(await cli.run("scans", "get", "scan_1")).toBe(0);
    expect(cli.stdout).not.toMatch(TERMINAL_CONTROL);
    expect(cli.stdout).toContain("safe");

    const raw = harness(() => json({ scan: { packageName: hostile } }));
    await raw.run("scans", "get", "scan_1", "--json");
    expect(raw.stdout).not.toMatch(TERMINAL_CONTROL);
    expect(JSON.parse(raw.stdout).scan.packageName).toBe(hostile);
  });

  test("keeps a scoped package's slash and encodes each segment", async () => {
    const cli = harness(() =>
      json({ package: { name: "@acme/cli", ecosystem: "npm" }, summary: {}, releases: [] }),
    );
    expect(await cli.run("releases", "@acme/cli", "--ecosystem", "npm")).toBe(0);
    expect(cli.calls[0].url).toBe(
      "https://drydock.test/api/v1/packages/%40acme/cli/releases?ecosystem=npm",
    );
  });

  test("scans wait polls until the review completes and applies --fail-on", async () => {
    const statuses = ["pending", "running", "complete"];
    let index = 0;
    const responder = () =>
      json({
        scan: {
          id: "scan_1",
          packageName: "pkg",
          stagedVersion: "2.0.0",
          status: statuses[Math.min(index++, statuses.length - 1)],
          risk: "high",
        },
      });
    const cli = harness(responder);
    expect(await cli.run("scans", "wait", "scan_1", "--interval", "1", "--fail-on", "medium")).toBe(
      3,
    );
    expect(cli.calls).toHaveLength(3);
    expect(cli.stdout).toContain("complete");

    index = 0;
    const lenient = harness(responder);
    expect(await lenient.run("scans", "wait", "scan_1", "--interval", "1")).toBe(0);

    const failed = harness(() =>
      json({ scan: { id: "scan_1", status: "failed", risk: "pending" } }),
    );
    expect(await failed.run("scans", "wait", "scan_1")).toBe(1);

    const stuck = harness(() => json({ scan: { id: "scan_1", status: "running" } }));
    expect(await stuck.run("scans", "wait", "scan_1", "--timeout", "10", "--interval", "4")).toBe(
      1,
    );
    expect(stuck.stderr).toContain("still running");
  });

  test("a receipt must match the digest Drydock sent with it", async () => {
    const body = '{"schema":"drydock.release-receipt.v1"}';
    const good = harness(
      async () =>
        new Response(body, { headers: { "x-drydock-receipt-sha256": await sha256Hex(body) } }),
    );
    expect(await good.run("receipt", "scan_1", "--output", "receipt.json")).toBe(0);
    expect(good.files.get("receipt.json")).toBe(body);

    const tampered = harness(
      () => new Response(`${body} `, { headers: { "x-drydock-receipt-sha256": "0".repeat(64) } }),
    );
    expect(await tampered.run("receipt", "scan_1")).toBe(1);
    expect(tampered.stdout).toBe("");
  });
});
