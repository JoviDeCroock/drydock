import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { recordScanDecision } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  getReleaseSet,
  listReleaseArtifacts,
  listReleaseSetScans,
} from "../../server/db/ci-release-sets";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { executeCiReleaseSetJob } from "../../server/lib/ci/release-set-job";
import { executeWorkflowGateJob } from "../../server/lib/workflow-gate-job";
import { resetJwksCacheForTests } from "../../server/lib/ci/oidc";
import { ciReleaseRoutes } from "../../server/routes/ci-releases";
import { githubWebhookRoutes } from "../../server/routes/github-webhooks";
import type { Bindings, Variables } from "../../server/types";
import { createFakeOidcIssuer, withJwks, type FakeOidcIssuer } from "./support/ci-oidc";
// Imported for its side effect: the worker pool infers the Worker's exported
// entrypoints (NpmStageGateway) from the main module, and the scan pipeline
// reaches for one through `ctx.exports`.
import "../../server";

const WEBHOOK_SECRET = "webhook-secret-value-1234567890";
const REPORT_BASE_URL = "https://drydock.test";
const originalFetch = globalThis.fetch;

let nextRepositoryId = 77000;
let nextRunId = 55000;
let issuer: FakeOidcIssuer;

beforeEach(() => {
  vi.unstubAllGlobals();
  resetJwksCacheForTests();
  issuer = createFakeOidcIssuer();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

// ── harness ──────────────────────────────────────────────────────────────────

interface DecisionCall {
  state: string;
  environment_name: string;
  comment: string;
}

/**
 * One fetch stub for everything the flow touches: the fake OIDC JWKS, GitHub's
 * installation-token and deployment-protection callback endpoints, and PyPI's
 * baseline metadata (404, so the review degrades to a no-baseline comparison
 * rather than reaching the network).
 */
function stubNetwork(decisionCalls: DecisionCall[]) {
  const spy = vi.fn(
    withJwks(issuer, async (request) => {
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as DecisionCall);
        return new Response(null, { status: 204 });
      }
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      // Baseline lookup: 404 makes the review degrade to a no-baseline
      // comparison instead of reaching the real network.
      return new Response("not found", { status: 404 });
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * Sandbox stand-in that reports each uploaded artifact as a wheel for the
 * package named in its filename, so a two-artifact upload fans out into two
 * independent package reviews.
 */
function buildLoaderMock() {
  return {
    load: vi.fn(() => ({
      getEntrypoint: () => ({
        fetch: vi.fn(async (request: Request) => {
          const body = new Uint8Array(await request.arrayBuffer());
          const marker = new TextDecoder().decode(body);
          const name = marker.startsWith("pkg:") ? marker.slice(4).split("\n")[0] : "demo-package";
          const dist = `${name.replace(/-/g, "_")}-1.2.0.dist-info`;
          return Response.json({
            files: [
              {
                path: `${dist}/METADATA`,
                size: 64,
                sha256: "00",
                flags: [],
                textSample: `Metadata-Version: 2.3\nName: ${name}\nVersion: 1.2.0\n`,
              },
              {
                path: `${dist}/WHEEL`,
                size: 60,
                sha256: "01",
                flags: [],
                textSample: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
              },
              { path: `${dist}/RECORD`, size: 0, sha256: "02", flags: [], textSample: "" },
            ],
            packageJson: null,
          });
        }),
      }),
    })),
  };
}

function buildConfigBindings(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

/**
 * The queue is stubbed rather than left unbound so enqueued work is recorded
 * and *not* run inline. Each test then drives the review and gate jobs itself,
 * which keeps every step observable and gives those jobs an execution context
 * that carries the sandbox gateway entrypoint.
 */
function buildEnv(): { env: Cloudflare.Env; queued: QueueMessage[] } {
  const queued: QueueMessage[] = [];
  const testEnv = {
    ...env,
    ...buildConfigBindings(),
    BETTER_AUTH_URL: REPORT_BASE_URL,
    CI_OIDC_ISSUER: issuer.issuer,
    CI_OIDC_AUDIENCE: issuer.audience,
    LOADER: buildLoaderMock() as unknown as WorkerLoader,
    SCAN_QUEUE: { send: async (message: QueueMessage) => void queued.push(message) },
  } as unknown as Cloudflare.Env;
  return { env: testEnv, queued };
}

type QueueMessage = {
  kind: string;
  organizationId: string;
  releaseSetId?: string;
  gateId?: string;
};

function buildCtx() {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = { NpmStageGateway: vi.fn(() => ({ fetch: vi.fn() }) as unknown as Fetcher) };
  return ctx;
}

function buildCiApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/api/ci/v1", ciReleaseRoutes);
  return app;
}

async function seedRepository(): Promise<{
  organizationId: string;
  userId: string;
  installationExternalId: string;
  repositoryId: number;
  runId: number;
  token(claims?: Record<string, unknown>): string;
}> {
  const repositoryId = nextRepositoryId++;
  const runId = nextRunId++;
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
  const installationExternalId = String(900000 + repositoryId);
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  for (const environment of ["release", "release-secondary"]) {
    await createReleaseTarget(db, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId,
      repositoryFullName: "octo/example",
      environment,
      createdByUserId: null,
    });
  }
  return {
    organizationId,
    userId,
    installationExternalId,
    repositoryId,
    runId,
    token: (claims) =>
      issuer.mint({
        repository_id: String(repositoryId),
        run_id: String(runId),
        ...claims,
      }),
  };
}

async function ciCall(
  testEnv: Cloudflare.Env,
  pathname: string,
  options: { method?: string; token: string; body?: unknown; raw?: Uint8Array; sha256?: string },
) {
  const app = buildCiApp();
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  let body: BodyInit | undefined;
  if (options.raw) {
    body = options.raw as unknown as BodyInit;
    headers["x-drydock-sha256"] = options.sha256!;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://drydock.test${pathname}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A wheel-shaped payload whose bytes tell the mocked sandbox which package it is. */
function wheelBytes(packageName: string): Uint8Array {
  return new TextEncoder().encode(`pkg:${packageName}\n${"padding".repeat(8)}`);
}

/** Upload the given packages into one release set and seal it. */
async function pushRelease(
  testEnv: Cloudflare.Env,
  seeded: Awaited<ReturnType<typeof seedRepository>>,
  packageNames: string[],
) {
  const token = seeded.token();
  const opened = await ciCall(testEnv, "/api/ci/v1/releases", {
    method: "POST",
    token,
    body: {},
  });
  const setId = opened.body.releaseSet.id as string;
  for (const name of packageNames) {
    const bytes = wheelBytes(name);
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/artifacts/${name}-1.2.0-py3-none-any.whl`, {
      method: "PUT",
      token,
      raw: bytes,
      sha256: await sha256Hex(bytes),
    });
  }
  await ciCall(testEnv, `/api/ci/v1/releases/${setId}/seal`, { method: "POST", token, body: {} });
  return { setId, token };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deliver a `deployment_protection_rule.requested` webhook for a run. */
async function deliverGateWebhook(
  testEnv: Cloudflare.Env,
  seeded: Awaited<ReturnType<typeof seedRepository>>,
  environment = "release",
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", githubWebhookRoutes);
  const payload = JSON.stringify({
    action: "requested",
    environment,
    installation: { id: Number(seeded.installationExternalId) },
    repository: { id: seeded.repositoryId, full_name: "octo/example" },
    deployment: { id: 4242 },
    deployment_callback_url: `https://api.github.com/repos/octo/example/actions/runs/${seeded.runId}/deployment_protection_rule`,
  });
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request("https://drydock.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "deployment_protection_rule",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${await hmacHex(WEBHOOK_SECRET, payload)}`,
        "content-type": "application/json",
      },
      body: payload,
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return (await response.json()) as { gateId?: string };
}

async function approveEveryPackage(
  organizationId: string,
  userId: string,
  setId: string,
  decision: "publish" | "no_publish" = "publish",
) {
  const db = createDb(env.DB);
  const packages = await listReleaseSetScans(db, { releaseSetId: setId, organizationId });
  for (const pkg of packages) {
    await recordScanDecision(db, {
      scanId: pkg.scanId,
      organizationId,
      actorUserId: userId,
      decision,
      reason: null,
    });
  }
  return packages;
}

// ── review ───────────────────────────────────────────────────────────────────

describe("pushed release review", () => {
  test("a monorepo upload fans out into one scan per package", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package", "other-package"]);

    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const db = createDb(env.DB);
    const set = await getReleaseSet(db, seeded.organizationId, setId);
    expect(set?.status).toBe("reviewed");
    expect(set?.scanId).toBeTruthy();

    const packages = await listReleaseSetScans(db, {
      releaseSetId: setId,
      organizationId: seeded.organizationId,
    });
    expect(packages.map((pkg) => pkg.packageName).sort()).toEqual([
      "demo-package",
      "other-package",
    ]);
    expect(packages.every((pkg) => pkg.status === "complete")).toBe(true);
    // Every package is decided independently: approving one must not approve
    // the other.
    expect(packages.every((pkg) => pkg.decision === null)).toBe(true);
  });

  test("reviewed bytes are deleted but their digests survive as provenance", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);

    const db = createDb(env.DB);
    const before = await listReleaseArtifacts(db, setId);
    expect(before[0].storageKey).toBeTruthy();
    expect(await env.ARTIFACTS.get(before[0].storageKey!)).not.toBeNull();

    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const after = await listReleaseArtifacts(db, setId);
    expect(after[0].sha256).toBe(before[0].sha256);
    expect(after[0].storageKey).toBeNull();
    expect(await env.ARTIFACTS.get(before[0].storageKey!)).toBeNull();
  });

  test("a pushed release is attested by its signed OIDC claims", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const db = createDb(env.DB);
    const set = await getReleaseSet(db, seeded.organizationId, setId);
    const [row] = await db
      .select({ summaryJson: schema.scans.summaryJson })
      .from(schema.scans)
      .where(eq(schema.scans.id, set!.scanId!));
    const envelope = (row.summaryJson as { intentEnvelope?: { tier: string; signals: unknown[] } })
      .intentEnvelope;
    expect(envelope?.tier).toBe("attested");
    expect(JSON.stringify(envelope?.signals)).toContain("ci-oidc");
  });

  test("a re-delivered review does not double-run the package scans", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);
    const message = {
      kind: "ci_release_set" as const,
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    };

    await executeCiReleaseSetJob(testEnv, buildCtx(), message);
    await executeCiReleaseSetJob(testEnv, buildCtx(), message);

    const db = createDb(env.DB);
    const packages = await listReleaseSetScans(db, {
      releaseSetId: setId,
      organizationId: seeded.organizationId,
    });
    expect(packages).toHaveLength(1);
  });

  test("an unrecognizable upload errors the set instead of reviewing nothing", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const token = seeded.token();
    const opened = await ciCall(testEnv, "/api/ci/v1/releases", {
      method: "POST",
      token,
      body: {},
    });
    const setId = opened.body.releaseSet.id as string;
    // A checksum file, not a distribution: the pinned PyPI classifier ignores it.
    const bytes = new TextEncoder().encode("deadbeef  demo.whl\n");
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/artifacts/SHA256SUMS`, {
      method: "PUT",
      token,
      raw: bytes,
      sha256: await sha256Hex(bytes),
    });
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/seal`, { method: "POST", token, body: {} });

    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const db = createDb(env.DB);
    const set = await getReleaseSet(db, seeded.organizationId, setId);
    expect(set?.status).toBe("errored");
    expect(set?.failureReason).toBe("artifact_identity_missing");
  });
});

// ── gate coupling ────────────────────────────────────────────────────────────

describe("gate binding to a pushed release", () => {
  test("a gate for a pushed run binds instead of pulling a bundle", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);

    const outcome = await deliverGateWebhook(testEnv, seeded);
    expect(outcome.gateId).toBeTruthy();

    const db = createDb(env.DB);
    const gate = await getGateForOrganization(db, seeded.organizationId, outcome.gateId!);
    expect(gate?.releaseSetId).toBe(setId);
  });

  test("a run with no pushed release stays on the pull path", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();

    const outcome = await deliverGateWebhook(testEnv, seeded);
    const db = createDb(env.DB);
    const gate = await getGateForOrganization(db, seeded.organizationId, outcome.gateId!);
    expect(gate?.releaseSetId).toBeNull();
  });

  test("an already-approved release releases the deployment immediately", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package", "other-package"]);

    // Review finishes during the build…
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });
    // …a maintainer approves every package before the publish job runs…
    const decided = await approveEveryPackage(seeded.organizationId, seeded.userId, setId);
    expect(decided).toHaveLength(2);

    // …and only then does the protected environment ask for permission.
    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("approved");
    expect(decisionCalls[0].comment).toContain("before it reached the gate");

    const db = createDb(env.DB);
    const gate = await getGateForOrganization(db, seeded.organizationId, outcome.gateId!);
    expect(gate?.status).toBe("approved");
  });

  test("one blocked package blocks the whole held deployment", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package", "other-package"]);
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const db = createDb(env.DB);
    const packages = await listReleaseSetScans(db, {
      releaseSetId: setId,
      organizationId: seeded.organizationId,
    });
    await recordScanDecision(db, {
      scanId: packages[0].scanId,
      organizationId: seeded.organizationId,
      actorUserId: seeded.userId,
      decision: "publish",
      reason: null,
    });
    await recordScanDecision(db, {
      scanId: packages[1].scanId,
      organizationId: seeded.organizationId,
      actorUserId: seeded.userId,
      decision: "no_publish",
      reason: null,
    });

    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("rejected");
  });

  test("an undecided release leaves the deployment held and adopts the scans", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    expect(decisionCalls).toHaveLength(0);
    const db = createDb(env.DB);
    const gate = await getGateForOrganization(db, seeded.organizationId, outcome.gateId!);
    expect(gate?.status).toBe("pending");
    // The pushed scans now answer to the gate, so the existing per-package
    // decision surface works unchanged.
    expect(gate?.scanId).toBeTruthy();
    const [scanRow] = await db
      .select({ gateId: schema.scans.gateId })
      .from(schema.scans)
      .where(eq(schema.scans.id, gate!.scanId!));
    expect(scanRow.gateId).toBe(outcome.gateId);
  });

  test("deciding after the gate bound still releases the deployment", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    // Gate arrives first and adopts the review, undecided.
    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });
    expect(decisionCalls).toHaveLength(0);

    // The maintainer then decides. Re-running the gate must re-evaluate the
    // aggregate rather than short-circuit on the scan it already attached.
    await approveEveryPackage(seeded.organizationId, seeded.userId, setId);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("approved");
  });

  test("a release that could not be reviewed blocks its deployment", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const token = seeded.token();
    const opened = await ciCall(testEnv, "/api/ci/v1/releases", {
      method: "POST",
      token,
      body: {},
    });
    const setId = opened.body.releaseSet.id as string;
    const bytes = new TextEncoder().encode("deadbeef  demo.whl\n");
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/artifacts/SHA256SUMS`, {
      method: "PUT",
      token,
      raw: bytes,
      sha256: await sha256Hex(bytes),
    });
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/seal`, { method: "POST", token, body: {} });
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });

    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("rejected");
  });

  test("two protected environments over one review both get an answer", async () => {
    const decisionCalls: DecisionCall[] = [];
    stubNetwork(decisionCalls);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const { setId } = await pushRelease(testEnv, seeded, ["demo-package"]);
    await executeCiReleaseSetJob(testEnv, buildCtx(), {
      kind: "ci_release_set",
      organizationId: seeded.organizationId,
      releaseSetId: setId,
    });
    await approveEveryPackage(seeded.organizationId, seeded.userId, setId);

    // One run, two protected environments: two gates bind to the same review.
    // Only the first claims the scans, so the second must resolve from the
    // release set or its deployment would stay held forever.
    const first = await deliverGateWebhook(testEnv, seeded, "release");
    const second = await deliverGateWebhook(testEnv, seeded, "release-secondary");
    expect(first.gateId).not.toBe(second.gateId);

    for (const gateId of [first.gateId!, second.gateId!]) {
      await executeWorkflowGateJob(testEnv, buildCtx(), {
        kind: "workflow_gate",
        organizationId: seeded.organizationId,
        gateId,
      });
    }

    expect(decisionCalls).toHaveLength(2);
    expect(decisionCalls.every((entry) => entry.state === "approved")).toBe(true);
    expect(decisionCalls.map((entry) => entry.environment_name).sort()).toEqual([
      "release",
      "release-secondary",
    ]);

    const db = createDb(env.DB);
    for (const gateId of [first.gateId!, second.gateId!]) {
      expect((await getGateForOrganization(db, seeded.organizationId, gateId))?.status).toBe(
        "approved",
      );
    }
  });

  test("a gate arriving before the seal seals the release rather than pulling a bundle", async () => {
    stubNetwork([]);
    const { env: testEnv } = buildEnv();
    const seeded = await seedRepository();
    const token = seeded.token();
    const opened = await ciCall(testEnv, "/api/ci/v1/releases", {
      method: "POST",
      token,
      body: {},
    });
    const setId = opened.body.releaseSet.id as string;
    const bytes = wheelBytes("demo-package");
    await ciCall(testEnv, `/api/ci/v1/releases/${setId}/artifacts/demo-1.2.0-py3-none-any.whl`, {
      method: "PUT",
      token,
      raw: bytes,
      sha256: await sha256Hex(bytes),
    });

    const outcome = await deliverGateWebhook(testEnv, seeded);
    await executeWorkflowGateJob(testEnv, buildCtx(), {
      kind: "workflow_gate",
      organizationId: seeded.organizationId,
      gateId: outcome.gateId!,
    });

    const db = createDb(env.DB);
    expect((await getReleaseSet(db, seeded.organizationId, setId))?.status).toBe("sealed");
    const gate = await getGateForOrganization(db, seeded.organizationId, outcome.gateId!);
    expect(gate?.status).toBe("pending");
  });
});
