import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { main } from "../../cli/src/main.mjs";
import { type Jar, callWorker, signUpUserId } from "./helpers/auth-http";
import { seedCompletedScan } from "./helpers/seed";

// The CLI against the real Worker: its paths, headers, and response handling
// must match what the API-key surface actually serves.

const CLI_ORIGIN = "https://drydock.test";

async function workerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  expect(url.origin).toBe(CLI_ORIGIN);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://example.com${url.pathname}${url.search}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function cli(token: string) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
    files,
    out,
    err,
    run: (...argv: string[]) =>
      main(argv, {
        env: { DRYDOCK_API_KEY: token, DRYDOCK_URL: CLI_ORIGIN },
        fetch: workerFetch as typeof fetch,
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
        writeFile: async (path: string, data: string) => void files.set(path, data),
        sleep: async () => undefined,
        now: () => 0,
      }),
  };
}

describe("drydock CLI against the Worker", () => {
  test("reads reviews, exports, and receipts with an API key", async () => {
    const jar: Jar = new Map();
    const userId = await signUpUserId(jar);
    expect((await callWorker("GET", "/api/v1/organizations", { jar })).res.status).toBe(200);
    const organizationId = personalOrganizationId(userId);
    const scanId = await seedCompletedScan(
      { userId, organizationId },
      {
        packageJson: { name: "@acme/cli-e2e", version: "2.0.0" },
        risk: "high",
        findings: [
          {
            severity: "high",
            file: "install.js",
            evidence: "child_process.exec(cmd)",
            reason: "process execution in an install script",
            line: 4,
            ruleId: "code.process-execution",
            ruleVersion: "1.0.0",
          },
        ],
      },
    );
    const created = await callWorker("POST", "/api/v1/api-keys", { jar, body: { name: "cli" } });
    const token = created.json?.token as string;

    const whoami = cli(token);
    const code = await whoami.run("whoami");
    expect(code, whoami.err.join("")).toBe(0);
    expect(whoami.out.join("")).toContain(organizationId);

    const list = cli(token);
    expect(await list.run("scans", "list", "--filter", "all", "--json")).toBe(0);
    const listed = JSON.parse(list.out.join("")) as { scans: Array<{ id: string }> };
    expect(listed.scans.map((scan) => scan.id)).toContain(scanId);

    const detail = cli(token);
    expect(await detail.run("scans", "get", scanId)).toBe(0);
    expect(detail.out.join("")).toContain("code.process-execution");
    expect(detail.out.join("")).toContain("install.js:4");

    const waited = cli(token);
    expect(await waited.run("scans", "wait", scanId, "--fail-on", "high")).toBe(3);
    expect(await cli(token).run("scans", "wait", scanId, "--fail-on", "critical")).toBe(0);

    const report = cli(token);
    expect(await report.run("report", scanId, "--output", "report.json")).toBe(0);
    const direct = await callWorker("GET", `/api/v1/scans/${scanId}/report.json`, { jar });
    expect(report.files.get("report.json")).toBe(direct.text);

    const receipt = cli(token);
    expect(await receipt.run("receipt", scanId)).toBe(0);
    expect(JSON.parse(receipt.out.join(""))).toMatchObject({
      schema: "drydock.release-receipt.v1",
    });

    const releases = cli(token);
    expect(await releases.run("releases", "@acme/cli-e2e")).toBe(0);
    expect(releases.out.join("")).toContain("2.0.0");

    const gate = cli(token);
    expect(await gate.run("gate", scanId)).toBe(1);
    expect(gate.err.join("")).toContain("not found");
  });

  test("a revoked key fails with exit 1 and never echoes the key", async () => {
    const jar: Jar = new Map();
    await signUpUserId(jar);
    const created = await callWorker("POST", "/api/v1/api-keys", { jar, body: { name: "gone" } });
    const token = created.json?.token as string;
    const keyId = (created.json as { key: { id: string } }).key.id;
    await callWorker("DELETE", `/api/v1/api-keys/${keyId}`, { jar });

    const run = cli(token);
    expect(await run.run("whoami")).toBe(1);
    expect(run.err.join("")).toContain("invalid_api_key");
    expect(run.err.join("") + run.out.join("")).not.toContain(token);
  });
});
