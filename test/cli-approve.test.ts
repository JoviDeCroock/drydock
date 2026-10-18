import { describe, expect, test } from "vitest";
import { main } from "../cli/src/main.mjs";

const KEY = `ddk_${"k".repeat(43)}`;
const STAGE = "stage-approve-000001";
const SCAN_ID = "scan-approve-1";
const ORG = "org-approve";
// eslint-disable-next-line no-control-regex -- matching terminal controls is the point
const TERMINAL_CONTROL = /[\u001b\u0007‮]/u;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface NpmResult {
  code: number | null;
  signal?: string | null;
  error?: string;
}

function stagedDetail(
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    scan: {
      id: SCAN_ID,
      stageId: STAGE,
      organizationId: ORG,
      source: "auto_discovery",
      gateId: null,
      packageName: "@acme/cli",
      stagedVersion: "2.1.0",
      previousVersion: "2.0.3",
      status: "complete",
      risk: "high",
      decision: null,
      registryUrl: "https://registry.npmjs.org",
      registryVersionStatus: null,
      registryStatusSupersededAt: null,
      summaryJson: {
        packageJsonDiff: {
          hasPreviousManifest: true,
          scripts: [
            { key: "postinstall", status: "added", staged: "node setup.js" },
            { key: "test", status: "modified", previous: "vitest", staged: "vitest run" },
          ],
          dependencies: [
            { key: "left-pad", status: "added", staged: "^1.3.0", section: "dependencies" },
            { key: "chalk", status: "modified", previous: "^4.0.0", staged: "^5.0.0" },
          ],
          bin: [],
        },
      },
      aiJson: {
        status: "complete",
        risk: "high",
        releaseAssessment: "suspicious",
        requiresManualReview: true,
        summary: "The new postinstall downloads a script.",
      },
      ...overrides,
    },
    findings: [
      {
        severity: "low",
        file: "README.md",
        ruleId: "file.prompt-injection",
        releaseDelta: false,
        reason: "old context",
        evidence: "",
      },
      {
        severity: "high",
        file: "package.json",
        line: 12,
        ruleId: "install-script.lifecycle",
        releaseDelta: true,
        reason: "consumer install lifecycle hooks execute on consumer machines",
        evidence: "postinstall: node setup.js",
      },
    ],
    riskSummary: { releaseRisk: "high", artifactRisk: "high", contextRisk: "low" },
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Api {
  list?: unknown[];
  releases?: unknown[];
  detail?: unknown;
  statuses?: string[];
  decision?: () => Response;
  start?: () => Response;
  discovery?: () => Response;
}

function harness(
  api: Api,
  {
    answers = [],
    npm = { code: 0 },
    interactive = true,
  }: { answers?: Array<string | null>; npm?: NpmResult; interactive?: boolean } = {},
) {
  const calls: Call[] = [];
  const npmRuns: string[][] = [];
  const prompts: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const statuses = [...(api.statuses ?? [])];
  let clock = 0;
  const responder = (url: string, method: string): Response => {
    const path = url.replace("https://drydock.test", "");
    if (method === "GET" && path.startsWith("/api/v1/scans?")) {
      return json({ scans: api.list ?? [], nextCursor: null, filter: "all", limit: 100 });
    }
    if (method === "GET" && path.includes("/releases?")) {
      return json({ releases: api.releases ?? [], nextCursor: null, limit: 100 });
    }
    if (method === "GET" && path === `/api/v1/scans/${SCAN_ID}/status`) {
      return json({ scan: { id: SCAN_ID, status: statuses.shift() ?? "complete" } });
    }
    if (method === "GET" && path === `/api/v1/scans/${SCAN_ID}`) {
      return json(api.detail ?? stagedDetail());
    }
    if (method === "POST" && path === `/api/v1/scans/${SCAN_ID}/decision`) {
      return api.decision?.() ?? json(stagedDetail({ decision: "publish" }));
    }
    if (method === "POST" && path === "/api/v1/scans") {
      return (
        api.start?.() ??
        json({ scan: { id: SCAN_ID, stageId: STAGE, status: "pending" }, queued: true }, 202)
      );
    }
    if (method === "POST" && path === "/api/v1/staged-publishes/scan") {
      return api.discovery?.() ?? json({ found: 0, created: 0, skipped: 0, scans: [] }, 202);
    }
    return json({ error: "not found" }, 404);
  };
  const io = {
    env: { DRYDOCK_API_KEY: KEY, DRYDOCK_URL: "https://drydock.test" },
    fetch: (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return responder(String(input), method);
    }) as typeof fetch,
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
    writeFile: async () => undefined,
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
    interactive,
    prompt: async (question: string) => {
      prompts.push(question);
      return answers.length ? (answers.shift() ?? null) : null;
    },
    runNpm: async (args: string[]) => {
      npmRuns.push(args);
      return npm;
    },
  };
  return {
    calls,
    npmRuns,
    prompts,
    run: (...argv: string[]) => main(argv, io),
    decisionCalls: () => calls.filter((call) => call.url.endsWith("/decision")),
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
  };
}

const listed = [{ id: SCAN_ID, stageId: STAGE, source: "auto_discovery", status: "complete" }];

describe("drydock approve", () => {
  test("refuses to run without a terminal, says why, and contacts nothing", async () => {
    const cli = harness({ list: listed }, { interactive: false, answers: ["p", ""] });
    expect(await cli.run("approve", STAGE)).toBe(2);
    expect(cli.stderr).toContain("needs an interactive terminal");
    expect(cli.stderr).toContain("no non-interactive mode on");
    expect(cli.calls).toEqual([]);
    expect(cli.prompts).toEqual([]);
    expect(cli.npmRuns).toEqual([]);
  });

  test("has no flag that skips the decision", async () => {
    for (const flag of ["--yes", "-y", "--force"]) {
      const cli = harness({ list: listed });
      expect(await cli.run("approve", STAGE, flag), flag).toBe(2);
      expect(cli.calls, flag).toEqual([]);
    }
    const json = harness({ list: listed });
    expect(await json.run("approve", STAGE, "--json")).toBe(2);
  });

  test("leads with the install-path facts, the risk, and the AI assessment", async () => {
    const cli = harness({ list: listed }, { answers: ["s"] });
    await cli.run("approve", STAGE);
    const summary = cli.stdout;
    expect(summary).toContain("package           @acme/cli@2.1.0");
    expect(summary).toContain("compared against  2.0.3");
    expect(summary).toContain("release risk      high (package risk high)");
    expect(summary).toContain("suspicious (AI risk high), asks for a manual review");
    expect(summary).toContain("The new postinstall downloads a script.");
    expect(summary).toContain("Since 2.0.3:");
    expect(summary).toContain("install-time scripts   postinstall added: node setup.js");
    expect(summary).not.toContain("vitest run");
    expect(summary).toContain("new dependencies       left-pad ^1.3.0");
    expect(summary).not.toContain("chalk");
    expect(summary).toContain("new executables        none");
    // The release-delta finding leads, ahead of older context.
    expect(summary.indexOf("install-script.lifecycle")).toBeLessThan(
      summary.indexOf("file.prompt-injection"),
    );
    expect(summary).toContain(
      `Full report: https://drydock.test/dashboard/scans/${SCAN_ID}?org=${ORG}`,
    );
  });

  test("says unknown, not none, when the review cannot support a fact", async () => {
    const skipped = harness(
      {
        list: listed,
        detail: stagedDetail({
          summaryJson: {
            baseline: { comparisonSkipped: "too_large" },
            packageJsonDiff: { hasPreviousManifest: true, scripts: [], dependencies: [], bin: [] },
          },
          aiJson: null,
        }),
      },
      { answers: ["s"] },
    );
    await skipped.run("approve", STAGE);
    expect(skipped.stdout).toContain(
      "install-time scripts   unknown (the previous release 2.0.3 was not downloaded for comparison)",
    );
    expect(skipped.stdout).toContain("new dependencies       unknown");
    expect(skipped.stdout).toContain("AI review         not run");

    // A review recorded before the bin map was diffed has no `bin` rows.
    const legacy = harness(
      {
        list: listed,
        detail: stagedDetail({
          summaryJson: {
            packageJsonDiff: { hasPreviousManifest: true, scripts: [], dependencies: [] },
          },
          aiJson: { status: "unavailable", risk: "low", releaseAssessment: "not_assessed" },
        }),
      },
      { answers: ["s"] },
    );
    await legacy.run("approve", STAGE);
    expect(legacy.stdout).toContain("install-time scripts   none");
    expect(legacy.stdout).toContain("new executables        unknown");
    expect(legacy.stdout).toContain("AI review         unavailable (unavailable)");
    expect(legacy.stdout).not.toContain("nothing unusual");
  });

  test("an npm baseline that was not downloaded is unknown, and only a missing predecessor is a first release", async () => {
    const added = {
      hasPreviousManifest: false,
      previousVersion: null,
      scripts: [{ key: "postinstall", status: "added", staged: "node setup.js" }],
      dependencies: [{ key: "left-pad", status: "added", staged: "^1.3.0" }],
      bin: [],
    };
    // npm names the baseline it picked and drops the manifest diff's previous side.
    const tooLarge = harness(
      {
        list: listed,
        detail: stagedDetail({
          previousVersion: null,
          summaryJson: {
            baseline: { version: "2.0.3", reason: "semver-predecessor:baseline-too-large" },
            packageJsonDiff: added,
          },
        }),
      },
      { answers: ["s"] },
    );
    await tooLarge.run("approve", STAGE);
    expect(tooLarge.stdout).toContain("compared against  2.0.3 (not downloaded for comparison)");
    expect(tooLarge.stdout).toContain(
      "install-time scripts   unknown (the previous release 2.0.3 was not downloaded for comparison)",
    );
    expect(tooLarge.stdout).not.toContain("first release");
    expect(tooLarge.stdout).not.toContain("postinstall added");

    const metadata = harness(
      {
        list: listed,
        detail: stagedDetail({
          previousVersion: null,
          summaryJson: {
            baseline: { version: null, reason: "metadata-unavailable" },
            packageJsonDiff: added,
          },
        }),
      },
      { answers: ["s"] },
    );
    await metadata.run("approve", STAGE);
    expect(metadata.stdout).toContain("compared against  unknown");
    expect(metadata.stdout).toContain("new dependencies       unknown");

    const first = harness(
      {
        list: listed,
        detail: stagedDetail({
          previousVersion: null,
          summaryJson: { baseline: { version: null, reason: "none" }, packageJsonDiff: added },
        }),
      },
      { answers: ["s"] },
    );
    await first.run("approve", STAGE);
    expect(first.stdout).toContain("compared against  none (first release)");
    expect(first.stdout).toContain("install-time scripts   postinstall added: node setup.js");
  });

  test("strips terminal controls from package-controlled summary text", async () => {
    const cli = harness(
      {
        list: listed,
        detail: stagedDetail({
          summaryJson: {
            packageJsonDiff: {
              hasPreviousManifest: true,
              scripts: [{ key: "postinstall", status: "added", staged: "node \u001b[2Jx.js" }],
              dependencies: [{ key: "evil‮pkg", status: "added", staged: "1.0.0" }],
              bin: [{ key: "run\u0007", status: "added", staged: "bin/run.js" }],
            },
          },
        }),
      },
      { answers: ["s"] },
    );
    await cli.run("approve", STAGE);
    expect(cli.stdout).not.toMatch(TERMINAL_CONTROL);
    expect(cli.stdout).toContain("command run added: bin/run.js");
  });

  test("declining records nothing, runs no npm, and exits non-zero", async () => {
    for (const answers of [["s"], [""], [null], ["p", null], ["maybe", "later", "no"]]) {
      const cli = harness({ list: listed }, { answers });
      expect(await cli.run("approve", STAGE), JSON.stringify(answers)).toBe(1);
      expect(cli.stderr).toContain(
        "no decision made: Drydock recorded nothing and npm was not run",
      );
      expect(cli.decisionCalls()).toEqual([]);
      expect(cli.npmRuns).toEqual([]);
    }
  });

  test("publish records the decision, then hands the terminal to npm stage approve without an OTP", async () => {
    const cli = harness({ list: listed }, { answers: ["publish", "read the diff"] });
    expect(await cli.run("approve", STAGE)).toBe(0);
    expect(cli.decisionCalls()).toEqual([
      {
        url: `https://drydock.test/api/v1/scans/${SCAN_ID}/decision`,
        method: "POST",
        body: { decision: "publish", reason: "read the diff" },
      },
    ]);
    expect(cli.npmRuns).toEqual([
      ["stage", "approve", STAGE, "--registry", "https://registry.npmjs.org"],
    ]);
    expect(cli.npmRuns.flat().some((arg) => arg.includes("otp"))).toBe(false);
    expect(cli.stderr).toContain("npm asks for your one-time password itself");
    expect(cli.stdout).toContain("Drydock recorded: publish (read the diff)");
    expect(cli.stdout).toContain("npm approved the stage: @acme/cli@2.1.0 is published.");
    expect(cli.stdout + cli.stderr).not.toContain(KEY);
  });

  test("an npm failure after the decision says Drydock recorded it but npm did not approve", async () => {
    for (const npm of [
      { code: 1 },
      { code: null, signal: "SIGINT" },
      { code: null, error: "spawn npm ENOENT" },
    ]) {
      const cli = harness({ list: listed }, { answers: ["p", ""], npm });
      expect(await cli.run("approve", STAGE), JSON.stringify(npm)).toBe(5);
      expect(cli.decisionCalls()).toHaveLength(1);
      expect(cli.decisionCalls()[0].body).toEqual({ decision: "publish" });
      expect(cli.stderr).toContain(
        "Drydock recorded your publish decision, but npm did not approve the stage",
      );
      expect(cli.stderr).toContain("@acme/cli@2.1.0 is still staged on npm.");
      expect(cli.stderr).toContain(`Retry with: npm stage approve ${STAGE}`);
      expect(cli.stdout).not.toContain("is published");
    }
  });

  test("a decision Drydock refuses to record never runs npm", async () => {
    const cli = harness(
      {
        list: listed,
        decision: () =>
          json(
            {
              error: "recording a staged-publish decision needs a key with decide_staged access",
              code: "api_key_access_insufficient",
              requiredAccess: "decide_staged",
            },
            403,
          ),
      },
      { answers: ["p", ""] },
    );
    expect(await cli.run("approve", STAGE)).toBe(1);
    expect(cli.stderr).toContain("drydock approve needs a key with decide_staged access");
    expect(cli.stderr).toContain("Drydock recorded nothing and npm was not run");
    expect(cli.npmRuns).toEqual([]);

    // A server error may follow a committed decision, so the CLI does not claim either way.
    const failed = harness(
      { list: listed, decision: () => json({ error: "internal error" }, 500) },
      { answers: ["p", ""] },
    );
    expect(await failed.run("approve", STAGE)).toBe(1);
    expect(failed.stderr).toContain(
      "Drydock may have recorded the decision; check https://drydock.test/dashboard/scans/",
    );
    expect(failed.stderr).not.toContain("recorded nothing");
    expect(failed.npmRuns).toEqual([]);
  });

  test("reject records the rejection and says how to reject on npm, running it only when asked", async () => {
    const declined = harness(
      { list: listed, decision: () => json(stagedDetail({ decision: "no_publish" })) },
      { answers: ["r", "new postinstall", "n"] },
    );
    expect(await declined.run("approve", STAGE)).toBe(0);
    expect(declined.decisionCalls()[0].body).toEqual({
      decision: "no_publish",
      reason: "new postinstall",
    });
    expect(declined.stdout).toContain("Drydock recorded: reject (new postinstall)");
    expect(declined.stdout).toContain(
      `@acme/cli@2.1.0 is still staged on npm. To remove it there, run: npm stage reject ${STAGE} --registry https://registry.npmjs.org`,
    );
    expect(declined.stdout).toContain("npm asks for your one-time password");
    expect(declined.stdout).toContain("permanently removes the staged version");
    expect(declined.npmRuns).toEqual([]);

    const ran = harness({ list: listed }, { answers: ["reject", "", "y"] });
    expect(await ran.run("approve", STAGE)).toBe(0);
    expect(ran.npmRuns).toEqual([
      ["stage", "reject", STAGE, "--registry", "https://registry.npmjs.org"],
    ]);
    expect(ran.stdout).toContain("npm rejected the stage");

    const failed = harness({ list: listed }, { answers: ["r", "", "yes"], npm: { code: 1 } });
    expect(await failed.run("approve", STAGE)).toBe(5);
    expect(failed.stderr).toContain(
      "Drydock recorded your reject decision, but npm did not reject the stage (npm exited with 1)",
    );
  });

  test("starts a review when the stage has none, and waits for it with progress", async () => {
    const cli = harness({ list: [], statuses: ["pending", "running"] }, { answers: ["s"] });
    expect(await cli.run("approve", STAGE, "--interval", "1")).toBe(1);
    const start = cli.calls.find((call) => call.method === "POST" && call.url.endsWith("/scans"));
    expect(start?.body).toEqual({ stageId: STAGE });
    expect(cli.stderr).toContain(`started review ${SCAN_ID}`);
    expect(cli.stderr).toContain(`waiting for review ${SCAN_ID}: pending (0s)`);
    expect(cli.stderr).toContain(`waiting for review ${SCAN_ID}: running (1s)`);
    expect(cli.stdout).toContain("package           @acme/cli@2.1.0");
  });

  test("a review that does not finish in time exits 4 before asking anything", async () => {
    const cli = harness({ list: [], statuses: Array(20).fill("running") }, { answers: ["p", ""] });
    expect(await cli.run("approve", STAGE, "--timeout", "3", "--interval", "1")).toBe(4);
    expect(cli.prompts).toEqual([]);
    expect(cli.decisionCalls()).toEqual([]);
    expect(cli.npmRuns).toEqual([]);
  });

  test("finds a package@version review through the package's releases", async () => {
    const cli = harness(
      {
        releases: [
          {
            id: "older",
            stageId: STAGE,
            source: "manual",
            status: "complete",
            stagedVersion: "2.0.3",
          },
          {
            id: SCAN_ID,
            stageId: STAGE,
            source: "manual",
            status: "complete",
            stagedVersion: "2.1.0",
          },
        ],
      },
      { answers: ["s"] },
    );
    await cli.run("approve", "@acme/cli@2.1.0");
    expect(cli.calls[0].url).toBe(
      "https://drydock.test/api/v1/packages/%40acme/cli/releases?limit=100&ecosystem=npm",
    );
    expect(cli.calls.some((call) => call.url.endsWith(`/api/v1/scans/${SCAN_ID}`))).toBe(true);
  });

  test("refuses gate packages, settled stages, and stage ids npm would read as flags", async () => {
    for (const detail of [
      stagedDetail({ gateId: "gate-1" }),
      stagedDetail({ source: "workflow_gate" }),
      stagedDetail({ registryVersionStatus: "published" }),
      stagedDetail({ registryStatusSupersededAt: "2026-10-01T00:00:00.000Z" }),
      stagedDetail({ registryUrl: "https://registry.npmjs.org/ --otp=1" }),
    ]) {
      const cli = harness({ list: listed, detail }, { answers: ["p", ""] });
      expect(await cli.run("approve", STAGE)).toBe(1);
      expect(cli.prompts).toEqual([]);
      expect(cli.decisionCalls()).toEqual([]);
      expect(cli.npmRuns).toEqual([]);
    }
    const flag = harness({ list: listed });
    expect(await flag.run("approve", "--", "--registry=https://evil.test")).toBe(2);
    expect(flag.calls).toEqual([]);
  });
});
