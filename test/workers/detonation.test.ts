import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { requestScanDetonation } from "../../server/db/scan-detonations";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import { executeDetonationJob } from "../../server/lib/detonation/job";
import type { DetonationRunOutput } from "../../server/lib/detonation/sandbox-do";
import type { DetonationResult, HarnessReport } from "../../server/lib/detonation/types";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings } from "../../server/types";
import { buildTestApp, call } from "./helpers/app";
import { seedCompletedScan, seedUser, type SeededUser } from "./helpers/seed";

const REGISTRY_URL = "https://registry.npmjs.org";
const TOKEN = "npm_realOrganizationTokenNeverInTheContainer000";
const TARBALL = new TextEncoder().encode("staged tarball bytes; inert in this test");

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const flagsOn = { getBooleanValue: vi.fn(async () => true) };
const flagsOff = { getBooleanValue: vi.fn(async () => false) };

const cleanReport: HarnessReport = {
  version: 1,
  coverage: {
    syscallTracing: true,
    runtimeHooks: true,
    dependencyInstall: "complete",
    stepsSkipped: 0,
  },
  steps: [
    { step: "require", target: "@org/pkg:require", exitCode: 0, timedOut: false, durationMs: 40 },
  ],
  events: [],
  truncated: false,
};

function fakeSandbox(output: Partial<DetonationRunOutput> = {}) {
  const received: ArrayBuffer[] = [];
  const names: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return { name };
    },
    get: () => ({
      detonate: async (bytes: ArrayBuffer): Promise<DetonationRunOutput> => {
        received.push(bytes);
        return {
          reportJson: JSON.stringify(cleanReport),
          prepareJson: JSON.stringify({
            ok: true,
            packageName: "@org/pkg",
            dependencyInstall: "complete",
          }),
          egress: [],
          forwardedRegistryReads: 3,
          egressTruncated: false,
          canaryValues: [],
          errorCode: null,
          ...output,
        };
      },
    }),
  } as unknown as NonNullable<Cloudflare.Env["DETONATION_SANDBOX"]>;
  return { namespace, received, names };
}

/** An execution context whose NpmStageGateway serves `body` and records what it was handed. */
function ctxWithGateway(body: Uint8Array<ArrayBuffer>) {
  const gatewayProps: unknown[] = [];
  const requests: string[] = [];
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: Record<string, (options: { props: unknown }) => unknown>;
  };
  ctx.exports = {
    NpmStageGateway: ({ props }) => {
      gatewayProps.push(props);
      return {
        fetch: async (url: string) => {
          requests.push(url);
          return new Response(body);
        },
      };
    },
  };
  return { ctx, gatewayProps, requests };
}

async function seedOwnerWithConnection(): Promise<SeededUser> {
  const owner = await seedUser();
  const db = createDb(env.DB);
  await upsertNpmConnection(db, {
    organizationId: owner.organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    createdByUserId: owner.userId,
    ...(await encryptNpmToken(env, TOKEN)),
  });
  await updateNpmConnectionValidation(db, {
    organizationId: owner.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
  return owner;
}

async function seedStagedScan(
  owner: SeededUser,
  sha256: string | null,
  source: "manual" | "workflow_gate" = "manual",
) {
  return seedCompletedScan(owner, {
    stageId: `stage-${crypto.randomUUID().slice(0, 12)}`,
    job: { registryUrl: REGISTRY_URL, source },
    summary: {
      diff: [{ path: "package.json", status: "modified" }],
      stagedPublish: { artifactSha256: sha256 },
    },
  });
}

async function readRow(scanId: string) {
  const [row] = await createDb(env.DB)
    .select()
    .from(schema.scanDetonations)
    .where(eq(schema.scanDetonations.scanId, scanId));
  return row;
}

async function queueRun(owner: SeededUser, scanId: string) {
  const runId = crypto.randomUUID();
  await requestScanDetonation(createDb(env.DB), {
    scanId,
    organizationId: owner.organizationId,
    runId,
    requestedByUserId: owner.userId,
    now: new Date(),
  });
  return { kind: "detonation" as const, scanId, organizationId: owner.organizationId, runId };
}

describe("detonation routes", () => {
  let owner: SeededUser;
  let scanId: string;
  const app = () =>
    buildTestApp((a) => a.route("/api/v1/scans", scansRoutes), { userId: owner.userId });

  beforeEach(async () => {
    owner = await seedOwnerWithConnection();
    scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
  });

  test("are invisible to organizations outside the beta", async () => {
    const envOverride = {
      FLAGS: flagsOff,
      DETONATION_SANDBOX: fakeSandbox().namespace,
    } as unknown as Partial<Bindings>;
    const get = await call(app(), "GET", `/api/v1/scans/${scanId}/detonation`, { envOverride });
    const post = await call(app(), "POST", `/api/v1/scans/${scanId}/detonation`, { envOverride });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ eligible: false, detonation: null });
    expect(post.status).toBe(404);
    expect(await readRow(scanId)).toBeUndefined();
  });

  test("are invisible without the container binding even when flagged", async () => {
    const envOverride = { FLAGS: flagsOn } as unknown as Partial<Bindings>;
    const res = await call(app(), "GET", `/api/v1/scans/${scanId}/detonation`, { envOverride });
    expect(await res.json()).toEqual({ eligible: false, detonation: null });
  });

  test("report an eligible scan that has not been detonated", async () => {
    const envOverride = {
      FLAGS: flagsOn,
      DETONATION_SANDBOX: fakeSandbox().namespace,
    } as unknown as Partial<Bindings>;
    const res = await call(app(), "GET", `/api/v1/scans/${scanId}/detonation`, { envOverride });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: true, detonation: null });
  });

  test("do not offer workflow-gate scans, which have no npm stage to fetch", async () => {
    const gateScan = await seedStagedScan(owner, await sha256Hex(TARBALL), "workflow_gate");
    const envOverride = {
      FLAGS: flagsOn,
      DETONATION_SANDBOX: fakeSandbox().namespace,
    } as unknown as Partial<Bindings>;
    const get = await call(app(), "GET", `/api/v1/scans/${gateScan}/detonation`, { envOverride });
    const post = await call(app(), "POST", `/api/v1/scans/${gateScan}/detonation`, {
      envOverride,
    });
    expect(await get.json()).toEqual({ eligible: false, detonation: null });
    expect(post.status).toBe(404);
  });

  test("do not reveal another organization's scan", async () => {
    const other = await seedOwnerWithConnection();
    const otherScan = await seedStagedScan(other, await sha256Hex(TARBALL));
    const envOverride = {
      FLAGS: flagsOn,
      DETONATION_SANDBOX: fakeSandbox().namespace,
    } as unknown as Partial<Bindings>;
    const get = await call(app(), "GET", `/api/v1/scans/${otherScan}/detonation`, { envOverride });
    const post = await call(app(), "POST", `/api/v1/scans/${otherScan}/detonation`, {
      envOverride,
    });
    expect(await get.json()).toEqual({ eligible: false, detonation: null });
    expect(post.status).toBe(404);
    expect(await readRow(otherScan)).toBeUndefined();
  });

  test("refuse a second run while one is live", async () => {
    const queued: unknown[] = [];
    const envOverride = {
      FLAGS: flagsOn,
      DETONATION_SANDBOX: fakeSandbox().namespace,
      DETONATION_QUEUE: { send: async (message: unknown) => void queued.push(message) },
    } as unknown as Partial<Bindings>;
    const first = await call(app(), "POST", `/api/v1/scans/${scanId}/detonation`, { envOverride });
    const second = await call(app(), "POST", `/api/v1/scans/${scanId}/detonation`, {
      envOverride,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(queued).toEqual([
      expect.objectContaining({ kind: "detonation", scanId, organizationId: owner.organizationId }),
    ]);
    expect((await readRow(scanId))?.status).toBe("queued");
  });
});

describe("detonation job", () => {
  let owner: SeededUser;

  beforeEach(async () => {
    owner = await seedOwnerWithConnection();
  });

  test("hands the container the reviewed bytes and keeps the npm token in the gateway", async () => {
    const scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox({
      egress: [
        {
          phase: "detonate",
          method: "POST",
          host: "exfil.example",
          path: "/collect",
          bodyBytes: 120,
          canaryHits: ["npm-token"],
          action: "sinkholed",
        },
      ],
    });
    const { ctx, gatewayProps, requests } = ctxWithGateway(TARBALL);

    await executeDetonationJob(
      {
        ...env,
        FLAGS: flagsOn,
        DETONATION_SANDBOX: sandbox.namespace,
      } as unknown as Cloudflare.Env,
      ctx,
      message,
    );
    await waitOnExecutionContext(ctx);

    expect(gatewayProps).toEqual([{ npmToken: TOKEN, npmRegistry: REGISTRY_URL }]);
    expect(requests[0]).toMatch(/\/-\/stage\/stage-[^/]+\/tarball$/);
    expect(sandbox.received).toHaveLength(1);
    expect(new Uint8Array(sandbox.received[0])).toEqual(TARBALL);
    expect(sandbox.names).toEqual([`${scanId}:${message.runId}`]);

    const row = await readRow(scanId);
    expect(row?.status).toBe("complete");
    const result = row?.resultJson as DetonationResult;
    expect(result.signals.map((signal) => [signal.id, signal.severity, signal.source])).toEqual([
      ["dynamic.canary-exfiltration", "critical", "egress"],
      ["dynamic.network-egress", "high", "egress"],
    ]);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  test("leaves risk, findings, and the decision untouched", async () => {
    const scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
    const db = createDb(env.DB);
    const before = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox({
      egress: [
        {
          phase: "detonate",
          method: "PUT",
          host: "registry.npmjs.org",
          path: "/victim",
          bodyBytes: 4000,
          canaryHits: ["npm-token"],
          action: "sinkholed",
        },
      ],
    });
    const { ctx } = ctxWithGateway(TARBALL);
    await executeDetonationJob(
      {
        ...env,
        FLAGS: flagsOn,
        DETONATION_SANDBOX: sandbox.namespace,
      } as unknown as Cloudflare.Env,
      ctx,
      message,
    );

    const after = await db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    expect(after).toEqual(before);
  });

  test("refuses to detonate bytes that differ from the reviewed digest", async () => {
    const scanId = await seedStagedScan(owner, "f".repeat(64));
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox();
    const { ctx } = ctxWithGateway(TARBALL);
    await executeDetonationJob(
      {
        ...env,
        FLAGS: flagsOn,
        DETONATION_SANDBOX: sandbox.namespace,
      } as unknown as Cloudflare.Env,
      ctx,
      message,
    );
    expect(sandbox.received).toHaveLength(0);
    const row = await readRow(scanId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("artifact_digest_mismatch");
  });

  test("skips a scan without a reviewed digest", async () => {
    const scanId = await seedStagedScan(owner, null);
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox();
    const { ctx } = ctxWithGateway(TARBALL);
    await executeDetonationJob(
      {
        ...env,
        FLAGS: flagsOn,
        DETONATION_SANDBOX: sandbox.namespace,
      } as unknown as Cloudflare.Env,
      ctx,
      message,
    );
    expect(sandbox.received).toHaveLength(0);
    expect(await readRow(scanId)).toMatchObject({
      status: "skipped",
      errorCode: "artifact_unavailable",
    });
  });

  test("keeps egress signals when the harness report is unusable", async () => {
    const scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox({
      reportJson: "{ not json",
      egress: [
        {
          phase: "detonate",
          method: "POST",
          host: "exfil.example",
          path: "/x",
          bodyBytes: 10,
          canaryHits: ["github-token"],
          action: "sinkholed",
        },
      ],
    });
    const { ctx } = ctxWithGateway(TARBALL);
    await executeDetonationJob(
      {
        ...env,
        FLAGS: flagsOn,
        DETONATION_SANDBOX: sandbox.namespace,
      } as unknown as Cloudflare.Env,
      ctx,
      message,
    );
    const row = await readRow(scanId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("harness_report_invalid");
    const result = row?.resultJson as DetonationResult;
    expect(result.signals[0]).toMatchObject({ id: "dynamic.canary-exfiltration" });
  });

  test("hands the run back for a retry when no container could start", async () => {
    const scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
    const message = await queueRun(owner, scanId);
    const sandbox = fakeSandbox({ reportJson: null, errorCode: "container_unavailable" });
    const { ctx } = ctxWithGateway(TARBALL);
    const testEnv = {
      ...env,
      FLAGS: flagsOn,
      DETONATION_SANDBOX: sandbox.namespace,
    } as unknown as Cloudflare.Env;

    expect(
      await executeDetonationJob(testEnv, ctx, message, undefined, { finalAttempt: false }),
    ).toBe("retry");
    expect(await readRow(scanId)).toMatchObject({ status: "queued", startedAt: null });

    expect(
      await executeDetonationJob(testEnv, ctx, message, undefined, { finalAttempt: true }),
    ).toBe("done");
    expect(sandbox.received).toHaveLength(2);
    expect(await readRow(scanId)).toMatchObject({
      status: "failed",
      errorCode: "container_unavailable",
    });
  });

  test("ignores a superseded run", async () => {
    const scanId = await seedStagedScan(owner, await sha256Hex(TARBALL));
    const stale = await queueRun(owner, scanId);
    // A finished run frees the row, and the rerun replaces the run id.
    await createDb(env.DB)
      .update(schema.scanDetonations)
      .set({ status: "complete" })
      .where(eq(schema.scanDetonations.scanId, scanId));
    const current = await queueRun(owner, scanId);
    const sandbox = fakeSandbox();
    const { ctx } = ctxWithGateway(TARBALL);
    const testEnv = {
      ...env,
      FLAGS: flagsOn,
      DETONATION_SANDBOX: sandbox.namespace,
    } as unknown as Cloudflare.Env;

    await executeDetonationJob(testEnv, ctx, stale);
    expect(sandbox.received).toHaveLength(0);
    await executeDetonationJob(testEnv, ctx, current);
    await executeDetonationJob(testEnv, ctx, current);
    expect(sandbox.received).toHaveLength(1);
  });
});
