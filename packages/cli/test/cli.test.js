import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.js";

const TOKEN = "drydock_test_secret_that_must_not_leak";

test("scan creates, polls, authenticates, and exits 2 at the risk threshold", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ scan: { id: "scan-123", status: "pending" } }, 202),
    jsonResponse({ scan: { id: "scan-123", status: "pending" } }),
    jsonResponse({
      scan: {
        id: "scan-123",
        status: "complete",
        source: "manual",
        packageName: "example-package",
        stagedVersion: "1.2.3",
        risk: "high",
      },
      riskSummary: { releaseRisk: "medium", contextRisk: "high" },
      findings: [{ ruleId: "code.network" }],
    }),
  ];
  const io = captureIo();

  const exitCode = await runCli(
    ["scan", "--stage", "stage-abc", "--poll-interval", "1", "--fail-on", "high"],
    {
      ...io,
      env: { DRYDOCK_TOKEN: TOKEN, DRYDOCK_API_URL: "https://example.test" },
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return responses.shift();
      },
    },
  );

  assert.equal(exitCode, 2);
  assert.equal(calls[0].url, "https://example.test/api/v1/scans");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { stageId: "stage-abc" });
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(calls[1].url, "https://example.test/api/v1/scans/scan-123?poll=1");
  assert.match(io.stdout.text, /example-package@1\.2\.3/);
  assert.match(io.stdout.text, /artifact high, release medium, context high/);
  assert.equal(io.stderr.text.match(/pending/g)?.length, 1);
  assert.match(io.stderr.text, /complete/);
});

test("scan --gate waits for an existing workflow-gate scan without creating one", async () => {
  const calls = [];
  const io = captureIo();
  const exitCode = await runCli(["scan", "--gate", "gate-scan", "--fail-on", "none"], {
    ...io,
    env: { DRYDOCK_TOKEN: TOKEN, DRYDOCK_API_URL: "https://example.test" },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        scan: {
          id: "gate-scan",
          status: "complete",
          source: "workflow_gate",
          risk: "critical",
        },
        riskSummary: { releaseRisk: "critical", contextRisk: "none" },
        findings: [],
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, undefined);
  assert.match(calls[0].url, /gate-scan\?poll=1$/);
});

test("report --json writes the canonical report document", async () => {
  const report = {
    schema: "drydock.report.v1",
    scan: { id: "scan-json", status: "complete", risk: "low" },
    findings: [],
  };
  const canonical = JSON.stringify(report);
  const io = captureIo();
  const exitCode = await runCli(["report", "scan-json", "--json"], {
    ...io,
    env: { DRYDOCK_TOKEN: TOKEN, DRYDOCK_API_URL: "https://example.test" },
    fetch: async (url, init) => {
      assert.equal(String(url), "https://example.test/api/v1/scans/scan-json/report.json");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
      return new Response(canonical, { status: 200 });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(io.stdout.text, `${canonical}\n`);
  assert.equal(io.stderr.text, "");
});

test("human report separates artifact, release, and context risk", async () => {
  const io = captureIo();
  const exitCode = await runCli(["report", "scan-report"], {
    ...io,
    env: { DRYDOCK_TOKEN: TOKEN },
    fetch: async () =>
      new Response(
        JSON.stringify({
          scan: { id: "scan-report", status: "complete", risk: "high" },
          package: { name: "@scope/pkg", stagedVersion: "3.0.0" },
          riskSummary: { releaseRisk: "medium", contextRisk: "high" },
          findings: [{}, {}],
        }),
        { status: 200 },
      ),
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout.text, /Package: @scope\/pkg@3\.0\.0/);
  assert.match(io.stdout.text, /Artifact risk: high/);
  assert.match(io.stdout.text, /Release risk: medium/);
  assert.match(io.stdout.text, /Context risk: high/);
  assert.match(io.stdout.text, /Findings: 2/);
});

test("configuration and API failures never print the token", async () => {
  const io = captureIo();
  const exitCode = await runCli(["report", "scan-error"], {
    ...io,
    env: { DRYDOCK_TOKEN: TOKEN },
    fetch: async () =>
      new Response(JSON.stringify({ error: `invalid token ${TOKEN}` }), { status: 401 }),
  });

  assert.equal(exitCode, 1);
  assert.doesNotMatch(io.stderr.text, new RegExp(TOKEN));
  assert.match(io.stderr.text, /\[redacted\]/);
});

test("scan requires one source and rejects invalid thresholds before making a request", async () => {
  const io = captureIo();
  let fetched = false;
  const exitCode = await runCli(
    ["scan", "--stage", "stage", "--gate", "scan", "--fail-on", "severe"],
    {
      ...io,
      env: { DRYDOCK_TOKEN: TOKEN },
      fetch: async () => {
        fetched = true;
        throw new Error("unexpected request");
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(fetched, false);
  assert.match(io.stderr.text, /exactly one/);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureIo() {
  const stdout = stringWriter();
  const stderr = stringWriter();
  return { stdout, stderr };
}

function stringWriter() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
    },
  };
}
