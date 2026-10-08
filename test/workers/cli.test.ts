import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import type { ScanQueueMessage } from "../../server/lib/scan/job";
import { main } from "../../cli/src/main.mjs";
import { type Jar, callWorker, signUpUserId } from "./helpers/auth-http";
import { seedCompletedScan } from "./helpers/seed";

// The CLI against the real Worker: its paths, headers, and response handling
// must match what the API-key surface actually serves.

const CLI_ORIGIN = "https://drydock.test";

function workerFetchWith(workerEnv: typeof env) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin).toBe(CLI_ORIGIN);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://example.com${url.pathname}${url.search}`, init),
      workerEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
}

function cli(token: string, workerEnv: typeof env = env) {
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
        fetch: workerFetchWith(workerEnv) as typeof fetch,
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

  describe("starting reviews", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // The Worker's own registry calls (packument, stage listing) go through the
    // global fetch; the CLI reaches the Worker through `workerFetchWith`, so it
    // is unaffected by this stub.
    function stubRegistry(packageName: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === `https://registry.npmjs.org/${packageName}`) {
            return Response.json({
              "dist-tags": { latest: "1.1.0" },
              versions: Object.fromEntries(
                ["1.0.0", "1.1.0"].map((version) => [
                  version,
                  {
                    dist: {
                      tarball: `https://registry.npmjs.org/${packageName}/-/x-${version}.tgz`,
                    },
                  },
                ]),
              ),
            });
          }
          if (url === "https://registry.npmjs.org/-/stage?perPage=50") {
            return Response.json({
              items: [
                {
                  id: "stage-cli-0001",
                  packageName: "@cli-e2e/staged",
                  access: "public",
                  version: "3.0.0",
                  tag: "latest",
                  actor: "maintainer",
                  createdAt: "2026-10-01T12:00:00.000Z",
                  shasum: "c".repeat(40),
                },
              ],
              total: 1,
              perPage: 50,
              page: 1,
            });
          }
          if (url === "https://registry.npmjs.org/-/stage/stage-cli-0001/tarball") {
            return new Response("", { status: 206 });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
    }

    test("a scan-access key starts a review and runs Check npm; a read-only key cannot", async () => {
      const jar: Jar = new Map();
      const userId = await signUpUserId(jar);
      expect((await callWorker("GET", "/api/v1/organizations", { jar })).res.status).toBe(200);
      const organizationId = personalOrganizationId(userId);
      const db = createDb(env.DB);
      await upsertNpmConnection(db, {
        organizationId,
        registryUrl: "https://registry.npmjs.org",
        label: "npm registry",
        createdByUserId: userId,
        ...(await encryptNpmToken(env, "npm_test_token_0123456789")),
      });
      await updateNpmConnectionValidation(db, {
        organizationId,
        validationStatus: "valid",
        validatedAt: new Date(),
      });

      const scanKey = await callWorker("POST", "/api/v1/api-keys", {
        jar,
        body: { name: "ci-scan", access: "scan" },
      });
      expect(scanKey.res.status, scanKey.text).toBe(201);
      const scanToken = scanKey.json?.token as string;
      const readKey = await callWorker("POST", "/api/v1/api-keys", { jar, body: { name: "ro" } });
      const readToken = readKey.json?.token as string;

      const packageName = `cli-e2e-${crypto.randomUUID()}`;
      stubRegistry(packageName);
      // A queue double keeps the review from running: only admission is under test.
      const queue = { send: vi.fn(async (_message: ScanQueueMessage) => undefined) };
      const queuedEnv = { ...env, SCAN_QUEUE: queue } as unknown as typeof env;

      const whoami = cli(scanToken, queuedEnv);
      expect(await whoami.run("whoami")).toBe(0);
      expect(whoami.out.join("")).toMatch(/access\s+scan/);

      const denied = cli(readToken, queuedEnv);
      expect(await denied.run("scans", "start", `${packageName}@1.1.0`)).toBe(1);
      expect(denied.err.join("")).toContain("read-only");
      expect(denied.err.join("") + denied.out.join("")).not.toContain(readToken);
      expect(await cli(readToken, queuedEnv).run("check-npm")).toBe(1);
      expect(queue.send).not.toHaveBeenCalled();

      const started = cli(scanToken, queuedEnv);
      const code = await started.run("scans", "start", `${packageName}@1.1.0`, "--json");
      expect(code, started.err.join("")).toBe(0);
      const body = JSON.parse(started.out.join("")) as { scan: { id: string } };
      expect(queue.send).toHaveBeenCalledTimes(1);
      expect(queue.send.mock.calls[0]?.[0]).toMatchObject({
        scanId: body.scan.id,
        actorUserId: userId,
        published: { packageName, version: "1.1.0", baselineVersion: "1.0.0" },
      });
      const detail = cli(scanToken, queuedEnv);
      expect(await detail.run("scans", "get", body.scan.id)).toBe(0);
      expect(detail.out.join("")).toContain(`${packageName}@1.1.0`);

      const discovery = cli(scanToken, queuedEnv);
      const discovered = await discovery.run("check-npm");
      expect(discovered, discovery.err.join("")).toBe(0);
      expect(discovery.out.join("")).toContain("1 review started");
      expect(discovery.out.join("")).toContain("@cli-e2e/staged@3.0.0");
      expect(queue.send).toHaveBeenCalledTimes(2);
      expect(queue.send.mock.calls[1]?.[0]).toMatchObject({ stageId: "stage-cli-0001" });
    });
  });
});
