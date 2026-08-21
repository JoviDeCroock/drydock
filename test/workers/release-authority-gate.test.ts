import { env } from "cloudflare:test";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../../server/index";
import { createDb } from "../../server/db/client";
import {
  ensurePersonalOrganization,
  setRequireAuthorityChangeApproval,
} from "../../server/db/organizations";
import {
  findLatestApprovedAuthoritySnapshotId,
  findApprovedAuthorityBaseline,
  getReleaseAuthorityForGate,
  markAuthoritySnapshotApproved,
} from "../../server/db/release-authority";
import { claimGatePackageDecision, createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { readGithubAppConfig } from "../../server/lib/github-app/config";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import type { WorkflowGateRecord } from "../../server/lib/github-app/webhook-gates";
import {
  getGateForOrganization,
  markGateDecidedForPackageAggregate,
} from "../../server/lib/github-app/webhook-gates";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { captureReleaseAuthority } from "../../server/lib/release-authority/capture";

// Release-authority capture and the policy that can hold a release on it
// (issue #524). These specs drive the real D1 rows and the real decision route,
// so the two properties that matter are exercised end to end: only an *approved*
// snapshot becomes the next release's baseline, and an org that opted in cannot
// approve a changed authority without saying so.

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";
const originalFetch = globalThis.fetch;

const RELEASE_WORKFLOW = `
name: Release
on:
  push:
    tags:
      - "v*"
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/
      - uses: actions/attest-build-provenance@v2
      - uses: pypa/gh-action-pypi-publish@release/v1
`;

type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; jar?: Jar; env?: typeof env } = {},
) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar?.size) {
    headers.set("cookie", [...opts.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), opts.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json: json as Record<string, unknown> | null };
}

let testPrivateKeyPem: string | null = null;
async function getTestPrivateKeyPem(): Promise<string> {
  if (testPrivateKeyPem) return testPrivateKeyPem;
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  let binary = "";
  for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
  const lines =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
  return testPrivateKeyPem;
}

async function githubEnv(): Promise<typeof env> {
  return {
    ...env,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: await getTestPrivateKeyPem(),
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
  } as typeof env;
}

async function signUp(jar: Jar): Promise<string> {
  const email = `authority-${crypto.randomUUID()}@example.test`;
  const up = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "Authority Tester", email, password: PASSWORD },
    jar,
  });
  expect(up.res.status).toBe(200);
  const session = await call("GET", "/api/auth/get-session", { jar });
  const user = session.json?.user as { id?: string } | undefined;
  expect(typeof user?.id).toBe("string");
  return user!.id as string;
}

interface SeededGate {
  gate: WorkflowGateRecord;
  scanId: string;
}

/** A pending gate with one complete package scan, so it is decidable. */
async function seedGate(
  organizationId: string,
  ownerUserId: string,
  releaseTargetId: string,
  installationRowId: string,
  repositoryId: number,
): Promise<SeededGate> {
  const db = createDb(env.DB);
  const now = new Date();
  const gateId = crypto.randomUUID();
  const scanId = `scan_${crypto.randomUUID()}`;
  const runId = Math.floor(Math.random() * 1e6) + 1;
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: "pending",
    decision: null,
    scanId: null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await createScanJob(db, {
    id: scanId,
    stageId: `workflow-gate:${gateId}`,
    organizationId,
    ownerUserId,
    source: "workflow_gate",
    gateId,
  });
  await persistScan(db, {
    id: scanId,
    stageId: `workflow-gate:${gateId}`,
    organizationId,
    ownerUserId,
    packageJson: { name: "pkg", version: "1.0.0" },
    previousPackageJson: null,
    risk: "low",
    status: "complete",
    summary: { diff: [] },
    ai: null,
    files: [],
    previousFiles: [],
    diff: [],
    findings: [],
  });
  await db
    .update(schema.githubWorkflowGates)
    .set({ scanId })
    .where(eq(schema.githubWorkflowGates.id, gateId));
  const gate = await getGateForOrganization(db, organizationId, gateId);
  if (!gate) throw new Error("seeded gate vanished");
  return { gate, scanId };
}

interface Fixture {
  organizationId: string;
  userId: string;
  releaseTargetId: string;
  installationRowId: string;
  installationExternalId: string;
  repositoryId: number;
  jar: Jar;
}

async function seedFixture(): Promise<Fixture> {
  const jar: Jar = new Map();
  const userId = await signUp(jar);
  const organizationId = personalOrganizationId(userId);
  const db = createDb(env.DB);
  await ensurePersonalOrganization(db, { userId });
  const installationExternalId = `${Math.floor(Math.random() * 1e9)}`;
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const repositoryId = Math.floor(Math.random() * 1e6) + 1;
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    createdByUserId: null,
  });
  return {
    organizationId,
    userId,
    releaseTargetId: releaseTarget.id,
    installationRowId: installation.id,
    installationExternalId,
    repositoryId,
    jar,
  };
}

/**
 * Stand in for the GitHub App API: an installation token, the workflow run's
 * metadata, and the workflow definition at the run's commit. `workflow` is what
 * the contents endpoint serves, so a spec can move the release's authority
 * between captures by handing in different YAML.
 */
function mockGithub(options: {
  workflow: string;
  headSha?: string;
  /** Entry workflow path the run reports; `null` reports none at all. */
  workflowPath?: string | null;
  referenced?: Array<{ path: string; sha: string; ref: string; content?: string }>;
  decisionCalls?: { state: string }[];
}) {
  const referenced = options.referenced ?? [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access_tokens")) {
      return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (url.pathname.endsWith("/deployment_protection_rule")) {
      options.decisionCalls?.push((await request.json()) as { state: string });
      return new Response(null, { status: 204 });
    }
    if (/\/actions\/runs\/\d+$/.test(url.pathname)) {
      const workflowPath =
        options.workflowPath === undefined ? ".github/workflows/release.yml" : options.workflowPath;
      return Response.json({
        head_sha: options.headSha ?? "a".repeat(40),
        ...(workflowPath === null ? {} : { path: workflowPath }),
        run_attempt: 1,
        event: "push",
        head_branch: "refs/tags/v1.0.0",
        actor: { login: "maintainer" },
        triggering_actor: { login: "maintainer" },
        referenced_workflows: referenced.map((item) => ({
          path: `${item.path}@${item.ref}`,
          sha: item.sha,
          ref: item.ref,
        })),
      });
    }
    if (url.pathname.includes("/contents/.github/workflows/")) {
      const match = referenced.find(
        (item) =>
          url.pathname.includes(item.path.split("/").slice(2).join("/")) &&
          !url.pathname.includes("/repos/octo/example/"),
      );
      if (match?.content !== undefined) return new Response(match.content);
      if (url.pathname.startsWith("/repos/octo/example/")) return new Response(options.workflow);
      return new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected fetch in release-authority test: ${request.url}`);
  });
}

async function capture(fixture: Fixture, gate: WorkflowGateRecord) {
  const db = createDb(env.DB);
  const config = readGithubAppConfig(await githubEnv());
  return captureReleaseAuthority(db, {
    config,
    gate,
    installationExternalId: fixture.installationExternalId,
    artifacts: [
      { path: "dist/pkg-1.0.0-py3-none-any.whl", kind: "wheel", sha256: "aa".repeat(32) },
      { path: "dist/pkg-1.0.0.tar.gz", kind: "sdist", sha256: "bb".repeat(32) },
    ],
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("release-authority capture", () => {
  test("captures a snapshot and reports no_baseline for the first release", async () => {
    const fixture = await seedFixture();
    const { gate } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });

    const delta = await capture(fixture, gate);
    expect(delta?.status).toBe("no_baseline");
    expect(delta?.requiresApproval).toBe(false);

    const record = await getReleaseAuthorityForGate(
      createDb(env.DB),
      fixture.organizationId,
      gate.id,
    );
    expect(record?.workflowPath).toBe(".github/workflows/release.yml");
    expect(record?.snapshot?.permissions).toContainEqual({
      workflow: ".github/workflows/release.yml",
      job: "publish",
      scope: "id-token",
      level: "write",
    });
    expect(record?.snapshot?.coverage.complete).toBe(true);
    // The approval binding exists as soon as the artifacts have digests.
    expect(record?.artifactBindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.approvedAt).toBeNull();
  });

  test("records unreadable definitions as incomplete coverage instead of failing", async () => {
    const fixture = await seedFixture();
    const { gate } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    // A reusable workflow in a repository the installation cannot read.
    mockGithub({
      workflow: RELEASE_WORKFLOW,
      referenced: [
        { path: "other/private/.github/workflows/publish.yml", sha: "c".repeat(40), ref: "main" },
      ],
    });

    const delta = await capture(fixture, gate);
    expect(delta?.status).toBe("no_baseline");
    const record = await getReleaseAuthorityForGate(
      createDb(env.DB),
      fixture.organizationId,
      gate.id,
    );
    expect(record?.snapshot?.coverage.complete).toBe(false);
    expect(record?.snapshot?.coverage.unresolved[0]).toMatchObject({
      reason: "not_accessible",
    });
  });

  test("never blocks the review when GitHub cannot be reached", async () => {
    const fixture = await seedFixture();
    const { gate } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(capture(fixture, gate)).resolves.toBeNull();
    const record = await getReleaseAuthorityForGate(
      createDb(env.DB),
      fixture.organizationId,
      gate.id,
    );
    // No row at all: "not assessed", which must stay distinct from "unchanged".
    expect(record).toBeNull();
  });
});

describe("release-authority baseline", () => {
  test("compares against the last approved release and flags a widened permission", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace("  contents: read\n", "  contents: write\n"),
      headSha: "b".repeat(40),
    });
    const delta = await capture(fixture, second.gate);

    expect(delta?.status).toBe("changed");
    expect(delta?.requiresApproval).toBe(true);
    expect(delta?.baseline?.gateId).toBe(first.gate.id);
    expect(delta?.changes.map((change) => change.kind)).toContain("permission_widened");
  });

  test("reports unchanged for a re-run of the same authority", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW, headSha: "b".repeat(40) });
    const delta = await capture(fixture, second.gate);
    expect(delta?.status).toBe("unchanged");
    expect(delta?.requiresApproval).toBe(false);
  });

  test("an unapproved snapshot never becomes the baseline", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    // Captured but never approved — a rejected or undecided authority change
    // must not launder itself into the thing later releases are measured by.

    const baseline = await findApprovedAuthorityBaseline(db, {
      organizationId: fixture.organizationId,
      releaseTargetId: fixture.releaseTargetId,
      workflowPath: ".github/workflows/release.yml",
      excludeGateId: "some-other-gate",
    });
    expect(baseline).toBeNull();
  });

  test("keeps separate baselines per release path", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const other = await findApprovedAuthorityBaseline(db, {
      organizationId: fixture.organizationId,
      releaseTargetId: fixture.releaseTargetId,
      workflowPath: ".github/workflows/other.yml",
      excludeGateId: "none",
    });
    expect(other).toBeNull();
  });

  test("uses the same id tie-breaker for equal-time baselines and revisions", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const approvals: SeededGate[] = [];
    for (const headSha of ["a".repeat(40), "b".repeat(40)]) {
      const seeded = await seedGate(
        fixture.organizationId,
        fixture.userId,
        fixture.releaseTargetId,
        fixture.installationRowId,
        fixture.repositoryId,
      );
      mockGithub({ workflow: RELEASE_WORKFLOW, headSha });
      await capture(fixture, seeded.gate);
      await markAuthoritySnapshotApproved(db, {
        organizationId: fixture.organizationId,
        gateId: seeded.gate.id,
        approvedByUserId: fixture.userId,
      });
      approvals.push(seeded);
    }

    const sameApprovalTime = new Date("2026-08-21T12:00:00.000Z");
    await db
      .update(schema.releaseAuthoritySnapshots)
      .set({ approvedAt: sameApprovalTime })
      .where(eq(schema.releaseAuthoritySnapshots.releaseTargetId, fixture.releaseTargetId));

    const records = await Promise.all(
      approvals.map(({ gate }) => getReleaseAuthorityForGate(db, fixture.organizationId, gate.id)),
    );
    const expectedId = records
      .map((record) => record!.id)
      .sort()
      .at(-1)!;
    const baseline = await findApprovedAuthorityBaseline(db, {
      organizationId: fixture.organizationId,
      releaseTargetId: fixture.releaseTargetId,
      workflowPath: ".github/workflows/release.yml",
      excludeGateId: "pending-gate",
    });
    const revision = await findLatestApprovedAuthoritySnapshotId(db, {
      organizationId: fixture.organizationId,
      releaseTargetId: fixture.releaseTargetId,
      excludeGateId: "pending-gate",
    });

    expect(baseline?.ref.snapshotId).toBe(expectedId);
    expect(revision).toBe(expectedId);
  });

  // Separate baselines per release path must not turn into a quiet spot. A
  // second publish workflow appearing on a target with approved history leaves
  // the package diff clean while changing who may publish — reporting that as
  // `no_baseline` would say "first release here" and ask for nothing.
  test("flags a release arriving on a workflow path with no approved history", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({
      workflow: RELEASE_WORKFLOW,
      workflowPath: ".github/workflows/publish-extra.yml",
      headSha: "b".repeat(40),
    });
    const delta = await capture(fixture, second.gate);

    expect(delta?.status).toBe("changed");
    expect(delta?.requiresApproval).toBe(true);
    // Nothing was diffed — the change names the approved paths instead.
    expect(delta?.baseline).toBeNull();
    expect(delta?.changes).toHaveLength(1);
    expect(delta?.changes[0]).toMatchObject({
      kind: "release_path_changed",
      significance: "high",
      before: ".github/workflows/release.yml",
      after: ".github/workflows/publish-extra.yml",
    });
  });

  test("a target's genuine first release still reports no_baseline", async () => {
    const fixture = await seedFixture();
    const { gate } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW, workflowPath: ".github/workflows/only-ever.yml" });
    const delta = await capture(fixture, gate);
    expect(delta?.status).toBe("no_baseline");
    expect(delta?.requiresApproval).toBe(false);
  });

  // An unreadable entry path is a coverage problem, not evidence that the
  // release path moved. Coverage reports it; the delta must not overclaim.
  test("does not call an unreadable entry path a new release path", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW, workflowPath: null, headSha: "b".repeat(40) });
    const delta = await capture(fixture, second.gate);

    expect(delta?.status).toBe("no_baseline");
    expect(delta?.standing.coverageComplete).toBe(false);
  });
});

describe("release-authority approval policy", () => {
  test("holds approval on a changed authority until it is acknowledged", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();

    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    const decisionCalls: { state: string }[] = [];
    mockGithub({
      // The bittensor-shaped change: the attestation step is gone and the
      // publish path was swapped, while the release still builds and publishes.
      workflow: RELEASE_WORKFLOW.replace("      - uses: actions/attest-build-provenance@v2\n", ""),
      headSha: "b".repeat(40),
      decisionCalls,
    });
    const delta = await capture(fixture, second.gate);
    expect(delta?.changes.map((change) => change.kind)).toContain("safeguard_removed");

    await setRequireAuthorityChangeApproval(db, fixture.organizationId, true);

    const blocked = await call(
      "POST",
      `/api/v1/github-app/workflow-gates/${second.gate.id}/decision`,
      {
        body: { decision: "approved", scanId: second.scanId },
        jar: fixture.jar,
        env: gitEnv,
      },
    );
    expect(blocked.res.status).toBe(409);
    expect(blocked.json?.code).toBe("authority_change_acknowledgement_required");
    expect(decisionCalls).toHaveLength(0);

    // The gate is untouched: a refused approval must leave no partial state.
    const stillPending = await getGateForOrganization(db, fixture.organizationId, second.gate.id);
    expect(stillPending?.status).toBe("pending");

    const lookup = await call("GET", `/api/v1/github-app/workflow-gates/by-scan/${second.scanId}`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    const acknowledgementToken = (
      lookup.json?.releaseAuthority as { acknowledgementToken?: string } | undefined
    )?.acknowledgementToken;
    expect(acknowledgementToken).toMatch(/^[0-9a-f]{64}$/);

    const approved = await call(
      "POST",
      `/api/v1/github-app/workflow-gates/${second.gate.id}/decision`,
      {
        body: {
          decision: "approved",
          scanId: second.scanId,
          acknowledgeAuthorityChange: true,
          authorityAcknowledgementToken: acknowledgementToken,
        },
        jar: fixture.jar,
        env: gitEnv,
      },
    );
    expect(approved.res.status).toBe(200);
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);

    // Approving records the durable binding: this authority is now the baseline.
    const record = await getReleaseAuthorityForGate(db, fixture.organizationId, second.gate.id);
    expect(record?.approvedAt).toBeInstanceOf(Date);
    expect(record?.approvedByUserId).toBe(fixture.userId);
    expect(record?.artifactBindingDigest).toMatch(/^[0-9a-f]{64}$/);
    const [event] = await db
      .select({ metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.type, "github_workflow_gate.approved"));
    expect(event?.metadata).toMatchObject({ authorityChangeAcknowledged: true });
  });

  test("refreshes a stale delta and rejects an acknowledgement bound to the old baseline", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();

    const baseline = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, baseline.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: baseline.gate.id,
      approvedByUserId: fixture.userId,
    });

    const stale = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW, headSha: "b".repeat(40) });
    expect((await capture(fixture, stale.gate))?.status).toBe("unchanged");
    const before = await call("GET", `/api/v1/github-app/workflow-gates/by-scan/${stale.scanId}`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    const oldAuthority = before.json?.releaseAuthority as {
      acknowledgementToken: string;
      delta: { status: string };
    };
    expect(oldAuthority.delta.status).toBe("unchanged");

    const moved = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace("  contents: read\n", "  contents: write\n"),
      headSha: "c".repeat(40),
    });
    await capture(fixture, moved.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: moved.gate.id,
      approvedByUserId: fixture.userId,
    });
    await setRequireAuthorityChangeApproval(db, fixture.organizationId, true);

    const blocked = await call(
      "POST",
      `/api/v1/github-app/workflow-gates/${stale.gate.id}/decision`,
      {
        body: {
          decision: "approved",
          scanId: stale.scanId,
          acknowledgeAuthorityChange: true,
          authorityAcknowledgementToken: oldAuthority.acknowledgementToken,
        },
        jar: fixture.jar,
        env: gitEnv,
      },
    );
    expect(blocked.res.status).toBe(409);
    expect(blocked.json?.code).toBe("authority_change_acknowledgement_required");

    const refreshed = await getReleaseAuthorityForGate(db, fixture.organizationId, stale.gate.id);
    expect(refreshed?.delta?.status).toBe("changed");
    expect(refreshed?.delta?.baseline?.gateId).toBe(moved.gate.id);
    expect(refreshed?.delta?.changes.map((change) => change.kind)).toContain("permission_narrowed");
    const scan = await db
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, stale.scanId));
    expect(scan[0]?.decision).toBeNull();
  });

  test("atomically rejects an approval when the authority revision moves after refresh", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);

    const baseline = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, baseline.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: baseline.gate.id,
      approvedByUserId: fixture.userId,
    });

    const stale = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW, headSha: "b".repeat(40) });
    expect((await capture(fixture, stale.gate))?.status).toBe("unchanged");
    const authorityRevision = await findLatestApprovedAuthoritySnapshotId(db, {
      organizationId: fixture.organizationId,
      releaseTargetId: fixture.releaseTargetId,
      excludeGateId: stale.gate.id,
    });

    const claimed = await claimGatePackageDecision(db, {
      scanId: stale.scanId,
      organizationId: fixture.organizationId,
      gateId: stale.gate.id,
      actorUserId: fixture.userId,
      decision: "publish",
      reason: null,
    });
    expect(claimed).not.toBeNull();

    // Another release becomes the approved baseline after this request read its
    // revision and delta but before it reaches the final gate CAS.
    const moved = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace("  contents: read\n", "  contents: write\n"),
      headSha: "c".repeat(40),
    });
    await capture(fixture, moved.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: moved.gate.id,
      approvedByUserId: fixture.userId,
    });

    const decided = await markGateDecidedForPackageAggregate(db, {
      gateId: stale.gate.id,
      organizationId: fixture.organizationId,
      decision: "approved",
      comment: "approved",
      packageClaim: {
        scanId: stale.scanId,
        actorUserId: fixture.userId,
        decidedAt: claimed!.decidedAt,
        decision: "publish",
      },
      authorityApproval: {
        approvedByUserId: fixture.userId,
        releaseTargetId: fixture.releaseTargetId,
        expectedLatestApprovedSnapshotId: authorityRevision,
      },
    });

    expect(decided).toBeNull();
    expect(await getGateForOrganization(db, fixture.organizationId, stale.gate.id)).toMatchObject({
      status: "pending",
    });
    const [scan] = await db
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, stale.scanId));
    expect(scan?.decision).toBeNull();
    const authority = await getReleaseAuthorityForGate(db, fixture.organizationId, stale.gate.id);
    expect(authority?.approvedAt).toBeNull();
  });

  test("never blocks a rejection on an unacknowledged authority change", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();

    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    const decisionCalls: { state: string }[] = [];
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace("    environment: pypi\n", ""),
      headSha: "b".repeat(40),
      decisionCalls,
    });
    await capture(fixture, second.gate);
    await setRequireAuthorityChangeApproval(db, fixture.organizationId, true);

    const rejected = await call(
      "POST",
      `/api/v1/github-app/workflow-gates/${second.gate.id}/decision`,
      {
        body: {
          decision: "rejected",
          scanId: second.scanId,
          acknowledgeAuthorityChange: true,
          authorityAcknowledgementToken: "forged",
        },
        jar: fixture.jar,
        env: gitEnv,
      },
    );
    expect(rejected.res.status).toBe(200);
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "rejected" })]);

    // A rejected release must not become the baseline either.
    const record = await getReleaseAuthorityForGate(db, fixture.organizationId, second.gate.id);
    expect(record?.approvedAt).toBeNull();
    const [event] = await db
      .select({ metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.type, "github_workflow_gate.rejected"));
    expect(event?.metadata).toMatchObject({ authorityChangeAcknowledged: false });
  });

  test("approves without acknowledgement while the policy is off", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();

    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    const decisionCalls: { state: string }[] = [];
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace("  contents: read\n", "  contents: write\n"),
      headSha: "b".repeat(40),
      decisionCalls,
    });
    const delta = await capture(fixture, second.gate);
    expect(delta?.requiresApproval).toBe(true);

    const approved = await call(
      "POST",
      `/api/v1/github-app/workflow-gates/${second.gate.id}/decision`,
      {
        body: { decision: "approved", scanId: second.scanId },
        jar: fixture.jar,
        env: gitEnv,
      },
    );
    expect(approved.res.status).toBe(200);
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);
  });
});

describe("release-authority surfaces", () => {
  test("exposes the delta on the gate lookup and in the report export", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();

    const first = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, first.gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: first.gate.id,
      approvedByUserId: fixture.userId,
    });

    const second = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({
      workflow: RELEASE_WORKFLOW.replace(
        "actions/download-artifact@v4",
        "actions/download-artifact@v3",
      ),
      headSha: "b".repeat(40),
    });
    await capture(fixture, second.gate);

    const lookup = await call("GET", `/api/v1/github-app/workflow-gates/by-scan/${second.scanId}`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    expect(lookup.res.status).toBe(200);
    const authority = lookup.json?.releaseAuthority as {
      delta: { status: string; changes: Array<{ kind: string }> };
      workflowPath: string;
    };
    expect(authority.workflowPath).toBe(".github/workflows/release.yml");
    expect(authority.delta.status).toBe("changed");
    expect(authority.delta.changes.map((change) => change.kind)).toContain("action_ref_changed");
    expect(lookup.json?.organizationRequiresAuthorityApproval).toBe(false);

    const report = await call("GET", `/api/v1/scans/${second.scanId}/report.json`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    expect(report.res.status).toBe(200);
    const exported = report.json?.releaseAuthority as {
      snapshot: { schema: string };
      delta: { status: string; baseline: { present: true } | null };
      artifactBindingDigest: string;
    };
    expect(exported.snapshot.schema).toBe("drydock.release-authority.v1");
    expect(exported.delta.status).toBe("changed");
    expect(exported.delta.baseline).toEqual({ present: true });
    expect(exported.artifactBindingDigest).toMatch(/^[0-9a-f]{64}$/);

    const baselineRecord = await getReleaseAuthorityForGate(
      db,
      fixture.organizationId,
      first.gate.id,
    );
    const serialized = JSON.stringify(report.json);
    expect(serialized).not.toContain(first.gate.id);
    expect(serialized).not.toContain(baselineRecord!.id);
    expect(serialized).not.toContain(baselineRecord!.approvedAt!.toISOString());
  });

  // The report export has exactly one serialization: the authenticated
  // download, the shared `/public/reports/:token` body, and the attestation
  // subject digest are all the same bytes. `docs/security-model.md` states that
  // surface carries no org/user identifiers, so the authority record must not
  // smuggle the approver's user id or the run's GitHub logins into it.
  test("the exported authority record carries no user identifiers", async () => {
    const fixture = await seedFixture();
    const db = createDb(env.DB);
    const gitEnv = await githubEnv();
    const { gate, scanId } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    mockGithub({ workflow: RELEASE_WORKFLOW });
    await capture(fixture, gate);
    await markAuthoritySnapshotApproved(db, {
      organizationId: fixture.organizationId,
      gateId: gate.id,
      approvedByUserId: fixture.userId,
    });

    const report = await call("GET", `/api/v1/scans/${scanId}/report.json`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    expect(report.res.status).toBe(200);
    const exported = report.json?.releaseAuthority as {
      approvedAt: string | null;
      snapshot: { run: { actor: string | null; triggeringActor: string | null } };
    };
    // The approval itself still exports — it is what binds the record to a
    // reviewed release; only who performed it is withheld.
    expect(exported.approvedAt).not.toBeNull();
    expect(exported.snapshot.run.actor).toBeNull();
    expect(exported.snapshot.run.triggeringActor).toBeNull();

    const serialized = JSON.stringify(report.json);
    expect(serialized).not.toContain(fixture.userId);
    expect(serialized).not.toContain("maintainer");

    // The authenticated, org-scoped gate lookup is a different surface and
    // keeps the run context the workbench shows.
    const lookup = await call("GET", `/api/v1/github-app/workflow-gates/by-scan/${scanId}`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    expect(lookup.res.status).toBe(200);
    const live = lookup.json?.releaseAuthority as { run: { actor: string | null } };
    expect(live.run.actor).toBe("maintainer");
  });

  test("exports null for a scan with no authority record", async () => {
    const fixture = await seedFixture();
    const gitEnv = await githubEnv();
    const { scanId } = await seedGate(
      fixture.organizationId,
      fixture.userId,
      fixture.releaseTargetId,
      fixture.installationRowId,
      fixture.repositoryId,
    );
    const report = await call("GET", `/api/v1/scans/${scanId}/report.json`, {
      jar: fixture.jar,
      env: gitEnv,
    });
    expect(report.res.status).toBe(200);
    expect(report.json?.releaseAuthority).toBeNull();
  });
});
