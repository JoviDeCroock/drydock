import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createDb, ensurePersonalOrganization, getScan } from "../../server/db";
import * as schema from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app";
import { getGateForOrganization } from "../../server/lib/github-app-webhook";
import { executeWorkflowGateJob } from "../../server/lib/workflow-gate-job";
import worker from "../../server/index";

const WEBHOOK_SECRET = "webhook-secret-value-1234567890";
const REPORT_BASE_URL = "https://drydock.test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ── Test setup helpers ───────────────────────────────────────────────────────

async function seedGateForTest(opts: {
  installationExternalId: string;
  repositoryId: number;
  runId: number;
}) {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: opts.installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    packageName: "demo-package",
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    workflowFilename: null,
    environment: "pypi",
    pypiTrustedPublisherEnvironment: "pypi",
    createdByUserId: null,
  });

  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId: opts.runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${opts.runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, userId, installation, releaseTarget, gateId };
}

interface ZipEntry {
  path: string;
  body: Uint8Array | string;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? encoder.encode(entry.body) : entry.body;
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    records.push(local);

    const c = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    central.push(c);
    offset += local.length;
  }
  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...records, centralBytes, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const part of parts) {
    out.set(part, i);
    i += part.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface LoaderMockOptions {
  fail?: boolean;
  metadataName?: string;
}

function buildLoaderMock(opts: LoaderMockOptions = {}) {
  const calls: { format: string | null; bodySize: number }[] = [];
  const metadataName = opts.metadataName ?? "demo-package";
  return {
    calls,
    binding: {
      load: vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: vi.fn(async (request: Request) => {
            calls.push({
              format: request.headers.get("x-archive-format"),
              bodySize: (await request.arrayBuffer()).byteLength,
            });
            if (opts.fail) {
              return new Response(JSON.stringify({ error: "archive invalid", status: 422 }), {
                status: 422,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify({
                files: [
                  {
                    path: "demo_package-1.2.0.dist-info/METADATA",
                    size: 40,
                    sha256: "00",
                    flags: [],
                    textSample: `Metadata-Version: 2.3\nName: ${metadataName}\nVersion: 1.2.0\n`,
                  },
                  {
                    path: "demo_package-1.2.0.dist-info/RECORD",
                    size: 1,
                    sha256: "01",
                    flags: [],
                    textSample: "",
                  },
                ],
                packageJson: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }),
        }),
      })),
    },
  };
}

function buildCtxWithGateway() {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = {
    NpmStageGateway: vi.fn(() => ({ fetch: vi.fn() }) as unknown as Fetcher),
  };
  return ctx;
}

function buildConfigBindings(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

interface DecisionCall {
  state: string;
  environment_name: string;
  comment: string;
}

interface ScenarioOpts {
  digestMatches: boolean;
}

async function buildScenario(runId: number, opts: ScenarioOpts) {
  const wheelPath = "dist/demo_package-1.2.0-py3-none-any.whl";
  const wheelBytes = makeZip([
    {
      path: "demo_package-1.2.0.dist-info/METADATA",
      body: "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
    },
    {
      path: "demo_package-1.2.0.dist-info/WHEEL",
      body: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    },
    {
      path: "demo_package-1.2.0.dist-info/RECORD",
      body: "",
    },
  ]);
  const declaredSha = opts.digestMatches ? await sha256Hex(wheelBytes) : "0".repeat(64);
  const manifestRaw = JSON.stringify({
    schema: "drydock.release-artifacts.v1",
    ecosystem: "pypi",
    package: "demo-package",
    version: "1.2.0",
    artifacts: [{ path: wheelPath, sha256: declaredSha }],
  });
  const bundleZip = makeZip([
    { path: "drydock-manifest.json", body: manifestRaw },
    { path: wheelPath, body: wheelBytes },
  ]);

  const decisionCalls: DecisionCall[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith("/deployment_protection_rule")) {
      decisionCalls.push((await request.json()) as DecisionCall);
      return new Response(null, { status: 204 });
    }
    if (request.url.includes("/access_tokens")) {
      return Response.json({
        token: "ghs_install_token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    if (request.url.includes(`/actions/runs/${runId}/artifacts`)) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 88888,
              name: "pypi-release-candidate",
              size_in_bytes: bundleZip.length,
              expired: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (request.url.includes("/actions/artifacts/")) {
      return new Response(bundleZip, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected fetch in test: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, decisionCalls, wheelPath };
}

function buildEnv(bindings: Record<string, string>, loaderBinding: unknown): Cloudflare.Env {
  return {
    ...env,
    ...bindings,
    BETTER_AUTH_URL: REPORT_BASE_URL,
    LOADER: loaderBinding as WorkerLoader,
  } as Cloudflare.Env;
}

async function scanEventTypes(organizationId: string, gateId: string): Promise<string[]> {
  const db = createDb(env.DB);
  const rows = await db
    .select({ type: schema.scanEvents.type, metadataJson: schema.scanEvents.metadataJson })
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
  return rows
    .filter((row) => {
      const meta = row.metadataJson as { gateId?: string } | null;
      return meta?.gateId === gateId;
    })
    .map((row) => row.type);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("executeWorkflowGateJob", () => {
  test("approves a clean candidate, persists the scan, and posts an approval", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9200",
      repositoryId: 72001,
      runId: 7777,
    });
    const scenario = await buildScenario(7777, { digestMatches: true });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);

    await executeWorkflowGateJob(
      sandboxEnv,
      ctx,
      { kind: "workflow_gate", organizationId: seeded.organizationId, gateId: seeded.gateId },
      db,
    );

    const gate = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(gate?.status).toBe("approved");
    expect(gate?.decision).toBe("approved");
    expect(gate?.scanId).toBeTruthy();
    expect(gate?.reportUrl).toBe(`${REPORT_BASE_URL}/dashboard/scans/${gate?.scanId}`);

    expect(scenario.decisionCalls).toHaveLength(1);
    expect(scenario.decisionCalls[0].state).toBe("approved");
    expect(scenario.decisionCalls[0].environment_name).toBe("pypi");

    const persisted = await getScan(db, gate!.scanId!, seeded.organizationId);
    expect(persisted?.scan.status).toBe("complete");
    expect(persisted?.scan.source).toBe("workflow_gate");

    const types = await scanEventTypes(seeded.organizationId, seeded.gateId);
    expect(types).toContain("github_workflow_gate.received");
    expect(types).toContain("github_workflow_gate.reviewed");
    expect(types).toContain("github_workflow_gate.approved");
  });

  test("rejects the deployment when the manifest digest is tampered", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9201",
      repositoryId: 72002,
      runId: 8888,
    });
    const scenario = await buildScenario(8888, { digestMatches: false });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);

    await executeWorkflowGateJob(
      sandboxEnv,
      ctx,
      { kind: "workflow_gate", organizationId: seeded.organizationId, gateId: seeded.gateId },
      db,
    );

    const gate = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(gate?.status).toBe("rejected");
    expect(gate?.failureReason).toBe("artifact_digest_mismatch");
    expect(gate?.scanId).toBeNull();

    expect(scenario.decisionCalls).toHaveLength(1);
    expect(scenario.decisionCalls[0].state).toBe("rejected");

    // The sandbox parser must never run for an artifact that fails verification.
    expect(loaderMock.calls).toHaveLength(0);

    const types = await scanEventTypes(seeded.organizationId, seeded.gateId);
    expect(types).toContain("github_workflow_gate.rejected");
  });

  test("rejects candidate-specific PyPI critical findings via release risk", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9206",
      repositoryId: 72007,
      runId: 12121,
    });
    const scenario = await buildScenario(12121, { digestMatches: true });
    const loaderMock = buildLoaderMock({ metadataName: "different-package" });
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);

    await executeWorkflowGateJob(
      sandboxEnv,
      ctx,
      { kind: "workflow_gate", organizationId: seeded.organizationId, gateId: seeded.gateId },
      db,
    );

    const gate = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(gate?.status).toBe("rejected");
    expect(gate?.decision).toBe("rejected");
    expect(scenario.decisionCalls).toHaveLength(1);
    expect(scenario.decisionCalls[0].state).toBe("rejected");

    const persisted = await getScan(db, gate!.scanId!, seeded.organizationId);
    expect(persisted?.scan.riskSummaryJson).toMatchObject({
      artifactRisk: "critical",
      releaseRisk: "critical",
    });
    expect(persisted?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "pypi.metadata-mismatch", severity: "critical" }),
    );
  });

  test("leaves the deployment pending and visible when the review errors", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9202",
      repositoryId: 72003,
      runId: 9999,
    });
    const scenario = await buildScenario(9999, { digestMatches: true });
    const loaderMock = buildLoaderMock({ fail: true });
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);

    await executeWorkflowGateJob(
      sandboxEnv,
      ctx,
      { kind: "workflow_gate", organizationId: seeded.organizationId, gateId: seeded.gateId },
      db,
    );

    const gate = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(gate?.status).toBe("pending");
    expect(gate?.failureReason).toBe("preparation_failed");

    // No decision must be posted to GitHub on a review error.
    expect(scenario.decisionCalls).toHaveLength(0);

    const types = await scanEventTypes(seeded.organizationId, seeded.gateId);
    expect(types).toContain("github_workflow_gate.received");
    expect(types).toContain("github_workflow_gate.review_failed");
    expect(types).not.toContain("github_workflow_gate.approved");
    expect(types).not.toContain("github_workflow_gate.rejected");
  });

  test("re-delivers the decision for an already-decided gate without re-running the review", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9203",
      repositoryId: 72004,
      runId: 10101,
    });
    const scenario = await buildScenario(10101, { digestMatches: true });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);
    const message = {
      kind: "workflow_gate" as const,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    };

    await executeWorkflowGateJob(sandboxEnv, ctx, message, db);
    const loaderCallsAfterFirst = loaderMock.calls.length;
    expect(scenario.decisionCalls).toHaveLength(1);

    await executeWorkflowGateJob(sandboxEnv, ctx, message, db);

    // Second delivery must re-post the stored decision but not re-parse artifacts.
    expect(loaderMock.calls.length).toBe(loaderCallsAfterFirst);
    expect(scenario.decisionCalls).toHaveLength(2);
    expect(scenario.decisionCalls[1].state).toBe("approved");
  });

  test("retries a failed redelivery for an already-decided gate", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9204",
      repositoryId: 72005,
      runId: 11111,
    });
    const scenario = await buildScenario(11111, { digestMatches: true });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);
    const message = {
      kind: "workflow_gate" as const,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    };

    await executeWorkflowGateJob(sandboxEnv, ctx, message, db);
    const loaderCallsAfterFirst = loaderMock.calls.length;
    expect(scenario.decisionCalls).toHaveLength(1);

    const redeliveryFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({
          token: "ghs_install_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        return new Response("try again", { status: 503 });
      }
      throw new Error(`unexpected fetch in redelivery test: ${request.url}`);
    });
    vi.stubGlobal("fetch", redeliveryFetch);

    await expect(executeWorkflowGateJob(sandboxEnv, ctx, message, db)).rejects.toThrow(
      "GitHub deployment protection decision failed (503)",
    );

    expect(loaderMock.calls.length).toBe(loaderCallsAfterFirst);
    expect(redeliveryFetch).toHaveBeenCalledTimes(2);
  });

  test("throws final workflow-gate queue callback failure so the message can reach the DLQ", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9205",
      repositoryId: 72006,
      runId: 11112,
    });
    const scenario = await buildScenario(11112, { digestMatches: true });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const sandboxEnv = buildEnv(bindings, loaderMock.binding);
    const db = createDb(env.DB);
    const body = {
      kind: "workflow_gate" as const,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    };

    await executeWorkflowGateJob(sandboxEnv, ctx, body, db);
    expect(scenario.decisionCalls).toHaveLength(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.includes("/access_tokens")) {
          return Response.json({
            token: "ghs_install_token",
            expires_at: "2099-01-01T00:00:00Z",
          });
        }
        if (request.url.endsWith("/deployment_protection_rule")) {
          return new Response("still failing", { status: 503 });
        }
        throw new Error(`unexpected fetch in queue final-attempt test: ${request.url}`);
      }),
    );

    const retry = vi.fn();
    const batch = {
      messages: [{ body, attempts: 3, retry }],
    } as unknown as MessageBatch<import("../../server/lib/scan-job").QueueMessage>;

    await expect(worker.queue(batch, sandboxEnv, ctx)).rejects.toThrow(
      "GitHub deployment protection decision failed (503)",
    );
    expect(retry).not.toHaveBeenCalled();
  });
});
