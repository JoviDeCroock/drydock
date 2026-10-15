import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { main } from "../cli/src/main.mjs";
import { CLI_VERSION } from "../cli/src/version.mjs";

const KEY = `ddk_${"k".repeat(43)}`;
// ESC, BEL, the right-to-left override, a soft hyphen, and a Unicode tag
// character: what a hostile package would use to rewrite, reorder, or smuggle
// text past a reviewer's terminal.
// eslint-disable-next-line no-control-regex -- matching terminal controls is the point
const TERMINAL_CONTROL = /[\u001b\u0007\u202e\u00ad\u{e0041}]/u;

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

  test("a flag a command does not take is a usage error, never silently ignored", async () => {
    const cli = harness(() => json({ scan: { id: "s1", status: "complete", risk: "critical" } }));
    expect(await cli.run("scans", "get", "s1", "--fail-on", "high")).toBe(2);
    expect(cli.stderr).toContain("--fail-on does not apply to scans get");
    expect(await cli.run("report", "s1", "--timeout", "5")).toBe(2);
    expect(await cli.run("diff", "a", "1", "2", "--output", "x.json")).toBe(2);
    expect(await cli.run("whoami", "--filter", "all")).toBe(2);
    expect(cli.calls).toEqual([]);
  });

  test("a risk the CLI does not recognize fails a --fail-on gate", async () => {
    const unknown = () => json({ scan: { id: "s1", status: "complete", risk: "severe" } });
    expect(await harness(unknown).run("scans", "wait", "s1", "--fail-on", "critical")).toBe(3);
    expect(await harness(unknown).run("scans", "wait", "s1")).toBe(0);
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

  test("public diff preserves review evidence and uses canonical identity for its link", async () => {
    const body = {
      ecosystem: "npm",
      packageName: "@canonical/name",
      fromVersion: "1.0.0+old",
      toVersion: "2.0.0+new",
      diff: [
        { path: "index.js", status: "modified", flags: ["truncated"] },
        { path: "new.js", status: "added", flags: [] },
        { path: "old.js", status: "removed", flags: [] },
        { path: "same.bin", status: "unchanged", flags: ["binary"] },
      ],
      packageJsonDiff: { scripts: [{ key: "install", status: "added", staged: "node new.js" }] },
      findings: [
        {
          severity: "high",
          ruleId: "new-rule",
          file: "new.js",
          line: 2,
          reason: "new behavior",
          releaseDelta: true,
          diffStatus: "added",
        },
        {
          severity: "medium",
          ruleId: "old-rule",
          file: "index.js",
          reason: "old behavior",
          releaseDelta: false,
          diffStatus: "modified",
        },
        {
          severity: "high",
          ruleId: "expanded-rule",
          file: "index.js",
          reason: "expanded behavior",
          releaseDelta: true,
          releaseDeltaKind: "expanded",
          diffStatus: "modified",
        },
        {
          severity: "low",
          file: "unknown.js",
          reason: "unknown origin",
          releaseDelta: false,
          diffStatus: "unknown",
        },
        {
          severity: "high",
          ruleId: "release-rule",
          file: "unchanged.py",
          reason: "release-scoped evidence",
          releaseDelta: true,
          diffStatus: "unchanged",
        },
      ],
      risk: { artifactRisk: "high", releaseRisk: "medium" },
      notices: ["Baseline coverage is limited"],
      textSamplesOmitted: true,
    };
    const cli = harness(() => json(body));
    expect(await cli.run("diff", "@input/name", "1", "2")).toBe(0);
    expect(cli.calls[0].headers.authorization).toBeUndefined();
    expect(cli.stdout).toContain("3 changed files · release risk medium · artifact risk high");
    for (const text of [
      "index.js",
      "new.js",
      "old.js",
      "modified",
      "added",
      "removed",
      "same.bin: binary",
      "index.js: truncated",
      "Baseline coverage is limited",
      "text samples omitted",
      "new in release",
      "existing context",
      "expanded in release",
      "unattributed context",
      "Manifest changes:",
      '"install"',
    ]) {
      expect(cli.stdout).toContain(text);
    }
    expect(cli.stdout).toContain(
      "https://drydock.test/diff/%40canonical/name/1.0.0%2Bold/2.0.0%2Bnew",
    );
    const releaseFinding = cli.stdout.split("\n").find((line) => line.includes("release-rule"));
    expect(releaseFinding).toContain("release finding");
    expect(releaseFinding).not.toContain("new in release");
    const raw = harness(() => json(body));
    expect(await raw.run("diff", "@input/name", "1", "2", "--json")).toBe(0);
    expect(JSON.parse(raw.stdout)).toEqual(body);
  });

  test("public review links use returned PyPI and atpm identities on the configured origin", async () => {
    for (const [ecosystem, packageName, path] of [
      ["pypi", "my-package", "/diff/pypi/my-package"],
      ["atpm", "did:plc:publisher/pkg", "/diff/atpm/did%3Aplc%3Apublisher/pkg"],
    ]) {
      const cli = harness(() => json({ ecosystem, packageName, fromVersion: "1", toVersion: "2" }));
      expect(
        await cli.run(
          "diff",
          "input-name",
          "1",
          "2",
          "--ecosystem",
          ecosystem,
          "--url",
          "https://self.example",
        ),
      ).toBe(0);
      expect(cli.stdout).toContain(`review: https://self.example${path}/1/2`);
    }
  });

  test("file is anonymous, encodes the exact path, and preserves raw sample evidence", async () => {
    const body = {
      path: "lib/a #?.js",
      before: null,
      after: {
        path: "lib/a #?.js",
        size: 35,
        sha256: "abc",
        flags: ["truncated"],
        textSample: "line one\n\u001b[2Jline two‮\n",
      },
      textSamplesOmitted: true,
    };
    const cli = harness(() => json(body));
    expect(
      await cli.run("file", "@scope/name", "1+old", "2", body.path, "--ecosystem", "npm"),
    ).toBe(0);
    const url = new URL(cli.calls[0].url);
    expect(url.pathname).toBe("/api/public/v1/package-diff/file");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      package: "@scope/name",
      from: "1+old",
      to: "2",
      path: body.path,
      ecosystem: "npm",
    });
    expect(cli.calls[0].headers.authorization).toBeUndefined();
    expect(cli.stdout).toContain("before:\n  absent");
    expect(cli.stdout).toContain("flags: truncated");
    expect(cli.stdout).toContain("text samples omitted");
    expect(cli.stdout).toContain("  | line one\n  |  [2Jline two");
    expect(cli.stdout).not.toMatch(TERMINAL_CONTROL);
    const raw = harness(() => json(body), { DRYDOCK_API_KEY: undefined });
    expect(await raw.run("file", "@scope/name", "1+old", "2", body.path, "--json")).toBe(0);
    expect(JSON.parse(raw.stdout)).toEqual(body);
  });

  test("file exposes binary, skipped, truncated and absent evidence without inventing text", async () => {
    for (const flags of [
      ["binary"],
      ["text-sample-skipped", "content-skipped"],
      ["baseline-truncated", "truncated"],
    ]) {
      const cli = harness(() =>
        json({
          path: "file.bin",
          before: { size: 42, sha256: "abc", flags },
          after: null,
          textSamplesOmitted: false,
        }),
      );
      expect(await cli.run("file", "pkg", "1", "2", "file.bin")).toBe(0);
      expect(cli.stdout).toContain(`flags: ${flags.join(", ")}`);
      expect(cli.stdout).toContain("text sample unavailable");
      expect(cli.stdout).toContain("after:\n  absent");
    }
  });

  test("file rejects incomplete arguments and unsupported ecosystems before requesting evidence", async () => {
    const cli = harness(() => json({}));
    expect(await cli.run("file", "pkg", "1", "2")).toBe(2);
    expect(await cli.run("file", "pkg", "1", "2", "index.js", "--ecosystem", "vscode")).toBe(2);
    expect(cli.calls).toEqual([]);
  });

  test("public pair and file failures remain failed reviews with rate-limit context", async () => {
    for (const command of [
      ["diff", "pkg", "1", "2"],
      ["file", "pkg", "1", "2", "index.js"],
    ]) {
      const limited = harness(() =>
        json({ error: "try later" }, { status: 429, headers: { "retry-after": "30" } }),
      );
      expect(await limited.run(...command)).toBe(1);
      expect(limited.stderr).toContain("retry after 30s");
      expect(limited.stdout).toBe("");
      const missing = harness(() => json({ error: "file or release not found" }, { status: 404 }));
      expect(await missing.run(...command)).toBe(1);
      expect(missing.stdout).toBe("");
    }
  });

  test("strips terminal control and bidi characters from package-controlled text", async () => {
    const hostile = "\u001b]0;owned\u0007\u001b[2Jsafe‮reversed\u00ad\u{e0041}\nnext";
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
      4,
    );
    expect(stuck.stderr).toContain("still running");
  });

  test("an unexpected response is a one-line error, not a stack trace", async () => {
    const cli = harness(() => json(null));
    expect(await cli.run("scans", "wait", "scan_1")).toBe(1);
    expect(cli.stderr).toMatch(/^drydock: unexpected error: [^\n]+\n$/);
  });

  test("strips terminal control characters from server error text", async () => {
    const hostile = "\u001b[2Jbad \u202epackage\u0085";
    const cli = harness(() => json({ error: hostile, code: hostile }, { status: 400 }));
    expect(await cli.run("scans", "get", "scan_1")).toBe(1);
    expect(cli.stderr).not.toMatch(TERMINAL_CONTROL);
    expect(cli.stderr).not.toContain("\u0085");
    expect(cli.stderr).toContain("bad");
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

  test("report and receipt escape hostile text on stdout and keep exact bytes in --output", async () => {
    const hostile =
      "\u001b]0;owned\u0007\u001b[2J\u0085safe\u202ereversed\u200b\u2028\u00ad\u{e0041}";
    // Compact like the server's canonical JSON; JSON.stringify leaves C1, bidi,
    // and line-separator characters raw.
    const body = JSON.stringify({ schema: "drydock.release-receipt.v1", reason: hostile });
    const digest = await sha256Hex(body);
    const responder = () => new Response(body, { headers: { "x-drydock-receipt-sha256": digest } });

    for (const command of ["report", "receipt"]) {
      const printed = harness(responder);
      expect(await printed.run(command, "scan_1")).toBe(0);
      expect(printed.stdout).not.toMatch(TERMINAL_CONTROL);
      expect(printed.stdout).not.toMatch(/[\u0085\u200b\u2028]/);
      expect(JSON.parse(printed.stdout)).toEqual(JSON.parse(body));

      const saved = harness(responder);
      expect(await saved.run(command, "scan_1", "--output", "out.json")).toBe(0);
      expect(saved.files.get("out.json")).toBe(body);
      expect(await sha256Hex(saved.files.get("out.json") ?? "")).toBe(digest);
    }
  });
});
