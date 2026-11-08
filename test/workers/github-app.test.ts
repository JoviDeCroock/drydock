import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { createPublisherSetupJob } from "../../server/db/publisher-setup-jobs";
import { createScanJob, markScanFailed } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { GithubAppValidationError } from "../../server/lib/github-app/config";
import {
  createReleaseTarget,
  deleteReleaseTarget,
  getInstallationByExternalId,
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
  markInstallationStatus,
  resolveDeploymentProtectionTarget,
  upsertInstallation,
} from "../../server/lib/github-app/persistence";
import type { PublisherSetupDraftRequest } from "../../server/lib/github-app/setup-types";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { githubAppRoutes } from "../../server/routes/github-app";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import type { Bindings } from "../../server/types";
import { persistScanWithArtifacts } from "./helpers/persist-scan";
import { buildTestApp, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";

const mountGithubApp = (app: TestApp) => app.route("/api/v1/github-app", githubAppRoutes);

const originalFetch = globalThis.fetch;

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
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
  return testPrivateKeyPem;
}

async function seedInstallation(
  organizationId: string,
  overrides: { installationId?: string; status?: "active" | "suspended" | "uninstalled" } = {},
) {
  const db = createDb(env.DB);
  return upsertInstallation(db, {
    organizationId,
    installationId: overrides.installationId ?? `${Math.floor(Math.random() * 1e9)}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: overrides.status ?? "active",
    createdByUserId: null,
  });
}

async function callGithubAppRoute(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown,
  envOverrides: Partial<Bindings> = {},
) {
  const ctx = createExecutionContext();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const routeEnv: Bindings = {
    ...env,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: await getTestPrivateKeyPem(),
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
    ...envOverrides,
  };
  const res = await app.fetch(new Request(`http://test.local${path}`, init), routeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("github-app DB helpers", () => {
  test("upsertInstallation links an installation to the calling organization", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);

    const found = await getInstallationByExternalId(createDb(env.DB), installation.installationId);
    expect(found?.id).toBe(installation.id);
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.status).toBe("active");
  });

  test("upsertInstallation refuses to link an existing install to a different org", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const installation = await seedInstallation(a.organizationId, {
      installationId: "shared-install",
    });

    await expect(
      upsertInstallation(createDb(env.DB), {
        organizationId: b.organizationId,
        installationId: installation.installationId,
        accountLogin: "octo",
        accountType: "Organization",
        targetType: "Organization",
        status: "active",
        createdByUserId: null,
      }),
    ).rejects.toBeInstanceOf(GithubAppValidationError);
  });

  test("listInstallationsForOrganization is scoped per organization", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await seedInstallation(a.organizationId);
    await seedInstallation(a.organizationId);
    await seedInstallation(b.organizationId);

    const dbInstance = createDb(env.DB);
    const aList = await listInstallationsForOrganization(dbInstance, a.organizationId);
    const bList = await listInstallationsForOrganization(dbInstance, b.organizationId);
    expect(aList).toHaveLength(2);
    expect(bList).toHaveLength(1);
  });
});

describe("github-app createReleaseTarget", () => {
  test("requires a matching active installation for the organization", async () => {
    const { organizationId } = await seedUser();
    await expect(
      createReleaseTarget(createDb(env.DB), {
        organizationId,
        installationRowId: "missing-install",
        ecosystem: "pypi",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        environment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "installation_missing" });
  });

  test("refuses suspended installations", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    await markInstallationStatus(createDb(env.DB), installation.installationId, "suspended");

    await expect(
      createReleaseTarget(createDb(env.DB), {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        environment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "installation_inactive" });
  });

  test("rejects duplicate repository/environment mappings within an organization", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const dbInstance = createDb(env.DB);

    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      environment: "pypi",
      createdByUserId: null,
    });

    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        environment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "environment_already_mapped" });
  });

  test("normalizes GitHub environment casing before storage and uniqueness checks", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const dbInstance = createDb(env.DB);

    const target = await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      environment: "PyPI",
      createdByUserId: null,
    });

    expect(target.environment).toBe("pypi");
    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        environment: "PYPI",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "environment_already_mapped" });
  });
});

describe("github-app routes", () => {
  test("POST /release-targets requires a repository full name", async () => {
    const { userId } = await seedUser();
    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      "/api/v1/github-app/release-targets",
      {
        installationRowId: "install-row",
        ecosystem: "pypi",
        environment: "pypi",
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "repositoryFullName is required",
    });
  });

  test("POST /install/callback requires the GitHub user OAuth code", async () => {
    const { userId } = await seedUser();
    const installRes = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      "/api/v1/github-app/install",
    );
    const { state } = (await installRes.json()) as { state: string };

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      "/api/v1/github-app/install/callback",
      {
        state,
        installationId: "123",
        setupAction: "install",
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "code is required" });
  });

  test("GET /installations/:id/repositories proxies the install token to GitHub", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "install-token" }))
      .mockResolvedValueOnce(
        Response.json({
          repositories: [
            { id: 11, full_name: "octo/alpha", default_branch: "main" },
            { id: 22, full_name: "octo/beta" },
          ],
        }),
      );

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        { id: 11, fullName: "octo/alpha", defaultBranch: "main" },
        { id: 22, fullName: "octo/beta", defaultBranch: null },
      ],
    });
  });

  test("GET /installations/:id/repositories follows GitHub pagination until exhausted", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "install-token" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            repositories: [{ id: 22, full_name: "octo/beta" }],
          },
          {
            headers: {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          repositories: [{ id: 11, full_name: "octo/alpha", default_branch: "main" }],
        }),
      );

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        { id: 11, fullName: "octo/alpha", defaultBranch: "main" },
        { id: 22, fullName: "octo/beta", defaultBranch: null },
      ],
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(String(calls[2][0])).toBe(
      "https://api.github.com/installation/repositories?per_page=100&page=2",
    );
  });

  test("GET /installations/:id/repositories rejects installs the org does not own", async () => {
    const { userId } = await seedUser();
    const other = await seedUser();
    const installation = await seedInstallation(other.organizationId);
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories`,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "installation_missing" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("GET /installations/:id/repositories rate limits GitHub proxy calls", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // The per-minute budget is enforced by the native Rate Limiting binding, so
    // the blocked path is driven with an exhausted limiter double rather than by
    // issuing GITHUB_APP_PROXY_LIMIT real requests.
    const { overrides, limiter } = exhaustedRateLimitBindings();
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories`,
      undefined,
      overrides,
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "GitHub repository lookup rate limit exceeded",
    });
    expect(limiter.keys).toEqual([`github-app:repositories:${organizationId}:${installation.id}`]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("GET /installations/:id/repositories/:owner/:repo/environments proxies the install token", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "install-token" }))
      .mockResolvedValueOnce(
        Response.json({
          environments: [{ name: "pypi" }, { name: "staging" }],
        }),
      );

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories/octo/alpha/environments`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      environments: [{ name: "pypi" }, { name: "staging" }],
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[1][0])).toBe(
      "https://api.github.com/repos/octo/alpha/environments?per_page=100",
    );
  });

  test("GET /installations/:id/repositories/:owner/:repo/environments returns 403 when repo is unreachable", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "install-token" }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories/octo/gone/environments`,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "repository_not_accessible" });
  });

  test("GET /installations/:id/repositories/:owner/:repo/environments rate limits GitHub proxy calls", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const { overrides, limiter } = exhaustedRateLimitBindings();
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/installations/${installation.id}/repositories/octo/alpha/environments`,
      undefined,
      overrides,
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "GitHub environment lookup rate limit exceeded",
    });
    // Scoped per repository, not just per installation.
    expect(limiter.keys).toEqual([
      `github-app:environments:${organizationId}:${installation.id}:octo/alpha`,
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("resolveDeploymentProtectionTarget", () => {
  test("returns the matching installation + release target", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId, { installationId: "111" });
    const dbInstance = createDb(env.DB);

    const target = await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 9001,
      repositoryFullName: "octo/example",
      environment: "pypi",
      createdByUserId: null,
    });

    const resolved = await resolveDeploymentProtectionTarget(dbInstance, {
      installationId: "111",
      repositoryId: 9001,
      environment: "pypi",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.installation.id).toBe(installation.id);
    expect(resolved?.releaseTarget.id).toBe(target.id);
    expect(resolved?.releaseTarget.repositoryFullName).toBe("octo/example");
  });

  test("matches webhook environments case-insensitively", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId, { installationId: "112" });
    const dbInstance = createDb(env.DB);

    const target = await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 9002,
      repositoryFullName: "octo/example-case",
      environment: "PyPI",
      createdByUserId: null,
    });

    const resolved = await resolveDeploymentProtectionTarget(dbInstance, {
      installationId: "112",
      repositoryId: 9002,
      environment: "PYPI",
    });
    expect(resolved?.releaseTarget.id).toBe(target.id);
  });

  test("returns null when the environment is unmapped", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId, { installationId: "222" });
    const dbInstance = createDb(env.DB);

    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 42,
      repositoryFullName: "octo/example",
      environment: "pypi",
      createdByUserId: null,
    });

    const resolved = await resolveDeploymentProtectionTarget(dbInstance, {
      installationId: "222",
      repositoryId: 42,
      environment: "staging",
    });
    expect(resolved).toBeNull();
  });

  test("returns null when the webhook installation does not own the mapped target", async () => {
    const { organizationId } = await seedUser();
    const targetInstallation = await seedInstallation(organizationId, { installationId: "444" });
    await seedInstallation(organizationId, { installationId: "555" });
    const dbInstance = createDb(env.DB);

    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: targetInstallation.id,
      ecosystem: "pypi",
      repositoryId: 42,
      repositoryFullName: "octo/example",
      environment: "pypi",
      createdByUserId: null,
    });

    const resolved = await resolveDeploymentProtectionTarget(dbInstance, {
      installationId: "555",
      repositoryId: 42,
      environment: "pypi",
    });
    expect(resolved).toBeNull();
  });

  test("returns null for suspended installations", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId, { installationId: "333" });
    const dbInstance = createDb(env.DB);
    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      repositoryId: 77,
      repositoryFullName: "octo/example",
      environment: "pypi",
      createdByUserId: null,
    });

    await markInstallationStatus(dbInstance, "333", "suspended");

    const resolved = await resolveDeploymentProtectionTarget(dbInstance, {
      installationId: "333",
      repositoryId: 77,
      environment: "pypi",
    });
    expect(resolved).toBeNull();
  });
});

describe("github-app cleanup helpers", () => {
  test("deleteReleaseTarget removes only the matching organization's row", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const installA = await seedInstallation(a.organizationId);
    const installB = await seedInstallation(b.organizationId);
    const dbInstance = createDb(env.DB);

    const aTarget = await createReleaseTarget(dbInstance, {
      organizationId: a.organizationId,
      installationRowId: installA.id,
      ecosystem: "pypi",
      repositoryId: 1,
      repositoryFullName: "octo/a",
      environment: "pypi",
      createdByUserId: null,
    });
    await createReleaseTarget(dbInstance, {
      organizationId: b.organizationId,
      installationRowId: installB.id,
      ecosystem: "pypi",
      repositoryId: 2,
      repositoryFullName: "octo/b",
      environment: "pypi",
      createdByUserId: null,
    });

    const removed = await deleteReleaseTarget(dbInstance, b.organizationId, aTarget.id);
    expect(removed).toBe(false);

    const bList = await listReleaseTargetsForOrganization(dbInstance, b.organizationId);
    expect(bList).toHaveLength(1);
    const aList = await listReleaseTargetsForOrganization(dbInstance, a.organizationId);
    expect(aList).toHaveLength(1);

    const correct = await deleteReleaseTarget(dbInstance, a.organizationId, aTarget.id);
    expect(correct).toBe(true);

    const aListAfter = await listReleaseTargetsForOrganization(dbInstance, a.organizationId);
    expect(aListAfter).toHaveLength(0);
  });
});

// Seeds a pending gate (installation + release target + gate row). Pass
// `attachScan` with the org owner's user id to also create a real `scans` row
// and link it via the gate's `scanId` FK — required for the by-scan lookups.
async function seedGate(
  organizationId: string,
  overrides: {
    status?: "pending" | "approved" | "rejected" | "errored";
    decision?: "approved" | "rejected" | null;
    attachScan?: { ownerUserId: string };
  } = {},
) {
  const db = createDb(env.DB);
  const now = new Date();
  const installation = await seedInstallation(organizationId);
  const runId = Math.floor(Math.random() * 1e6) + 1;
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    repositoryId: Math.floor(Math.random() * 1e6) + 1,
    repositoryFullName: "octo/example",
    environment: "pypi",
    createdByUserId: null,
  });
  const gateId = crypto.randomUUID();
  // Insert the gate before any per-package scan: `scans.gate_id` references the
  // gate, so the gate must exist first (production creates the gate from the
  // webhook before the runner fans out per-package scans).
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: releaseTarget.repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: overrides.status ?? "pending",
    decision: overrides.decision ?? null,
    scanId: null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  let scanId: string | null = null;
  if (overrides.attachScan) {
    scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `workflow-gate:${gateId}`,
      organizationId,
      ownerUserId: overrides.attachScan.ownerUserId,
      source: "workflow_gate",
      gateId,
    });
    // Point the gate at its representative scan, mirroring `attachScanToGate`.
    await db
      .update(schema.githubWorkflowGates)
      .set({ scanId })
      .where(eq(schema.githubWorkflowGates.id, gateId));
  }
  return { gateId, scanId, installation, releaseTarget, runId };
}

async function completeWorkflowGateScan(input: {
  organizationId: string;
  ownerUserId: string;
  gateId: string;
  scanId: string;
  packageName?: string;
  version?: string;
}) {
  await persistScanWithArtifacts(createDb(env.DB), {
    id: input.scanId,
    stageId: `workflow-gate:${input.gateId}`,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    packageJson: { name: input.packageName ?? "pkg", version: input.version ?? "1.0.0" },
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
}

// Seed a second (or further) complete per-package scan linked to an existing
// gate via `scans.gate_id`. The gate decision aggregates over every such scan,
// so multi-package tests stack these on top of the gate's first package.
async function seedGatePackageScan(input: {
  organizationId: string;
  ownerUserId: string;
  gateId: string;
  packageName: string;
  version: string;
}) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `workflow-gate:${input.gateId}:pypi:${input.packageName}`,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    source: "workflow_gate",
    gateId: input.gateId,
  });
  await completeWorkflowGateScan({
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    gateId: input.gateId,
    scanId,
    packageName: input.packageName,
    version: input.version,
  });
  return scanId;
}

describe("github-app workflow-gate decision route", () => {
  test("rejects a decision that is not approved/rejected", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "maybe" },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "decision must be 'approved' or 'rejected'",
    });
  });

  test("rejects a comment that exceeds the length limit", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: "scan_x", comment: "x".repeat(501) },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "comment must be <= 500 characters",
    });
  });

  test("rejects a decision that does not name the package scan", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved" },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "scanId of the package being decided is required",
    });
  });

  test("returns 404 for a gate the organization does not own", async () => {
    const caller = await seedUser();
    const other = await seedUser();
    const { gateId } = await seedGate(other.organizationId);
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId: caller.userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: "scan_x" },
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not found" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects a scanId that is not a package of this gate", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: `scan_${crypto.randomUUID()}` },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "scanId is not a reviewable package of this gate",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("allows a human to approve a failed package review", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await markScanFailed(createDb(env.DB), scanId!, organizationId, {
      code: "review_failed",
      message: "review failed",
    });
    const decisionCalls: { state: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in decision test: ${request.url}`);
    });

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      gate: { status: "approved", decision: "approved" },
    });
    const scan = await createDb(env.DB)
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!))
      .limit(1);
    expect(scan[0]?.decision).toBe("publish");
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("approved");
  });

  test("rejects a decision while the package scan is still pending", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "scanId is not a reviewable package of this gate",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects approval for a partial failed review batch", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);
    const completeScanId = await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "alpha-pkg",
      version: "1.0.0",
    });
    const failedScanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(createDb(env.DB), {
      id: failedScanId,
      stageId: `workflow-gate:${gateId}:pypi:beta-pkg`,
      organizationId,
      ownerUserId: userId,
      source: "workflow_gate",
      gateId,
    });
    await markScanFailed(createDb(env.DB), failedScanId, organizationId, {
      code: "review_failed",
      message: "review failed",
    });
    globalThis.fetch = vi.fn();

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: completeScanId },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "approval requires a completed workflow-gate review batch",
      gate: { status: "pending" },
    });
    const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
    expect(stored?.scanId).toBeNull();
    expect(stored?.status).toBe("pending");
    const scan = await createDb(env.DB)
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, completeScanId))
      .limit(1);
    expect(scan[0]?.decision).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("decides a pending gate once, posts to GitHub, and 409s a double-submit", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });
    const decisionCalls: { state: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in decision test: ${request.url}`);
    });

    const first = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId!, comment: "ship it" },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      gate: { status: "approved", decision: "approved" },
    });

    const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
    expect(stored?.status).toBe("approved");
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("approved");

    const second = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "gate has already been decided" });
    // The CAS lost the second transition, so no extra callback is posted.
    expect(decisionCalls).toHaveLength(1);
  });

  test("holds the deployment until every package is approved, then releases", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
      packageName: "alpha-pkg",
    });
    const secondScanId = await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "beta-pkg",
      version: "2.0.0",
    });
    const decisionCalls: { state: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in decision test: ${request.url}`);
    });

    // Approving only the first package keeps the gate pending: no callback yet.
    const partial = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(partial.status).toBe(200);
    const partialBody = (await partial.json()) as {
      gate: { status: string; packages: { scanId: string; decision: string | null }[] };
    };
    expect(partialBody.gate.status).toBe("pending");
    expect(partialBody.gate.packages).toHaveLength(2);
    expect(decisionCalls).toHaveLength(0);

    // The package decision is final while the gate is pending; a stale second
    // submit must not overwrite it before the aggregate gate decision happens.
    const staleOverwrite = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );
    expect(staleOverwrite.status).toBe(409);
    expect(await staleOverwrite.json()).toMatchObject({
      error: "package has already been decided",
    });
    expect(decisionCalls).toHaveLength(0);

    // Approving the last package finalizes the gate and posts the release.
    const finalRes = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: secondScanId },
    );
    expect(finalRes.status).toBe(200);
    expect(await finalRes.json()).toMatchObject({
      gate: { status: "approved", decision: "approved" },
    });
    const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
    expect(stored?.status).toBe("approved");
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("approved");
  });

  test("rejecting any single package blocks the whole release immediately", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
      packageName: "alpha-pkg",
    });
    // A second, still-undecided package exists, yet one rejection is enough.
    await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "beta-pkg",
      version: "2.0.0",
    });
    const decisionCalls: { state: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in decision test: ${request.url}`);
    });

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      gate: { status: "rejected", decision: "rejected" },
    });
    const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
    expect(stored?.status).toBe("rejected");
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].state).toBe("rejected");
  });

  test("retries a failed package review by requeueing the pending gate", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await markScanFailed(createDb(env.DB), scanId!, organizationId, {
      code: "review_failed",
      message: "review failed",
    });
    const queueSend = vi.fn(async () => undefined);

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/retry`,
      {},
      { SCAN_QUEUE: { send: queueSend } as unknown as Queue },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: true, gate: { status: "pending" } });
    expect(queueSend).toHaveBeenCalledWith({
      kind: "workflow_gate",
      organizationId,
      gateId,
    });
    const gate = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
    expect(gate?.scanId).toBeNull();
  });
});

describe("github-app workflow-gate by-scan route", () => {
  test("returns 404 when no gate references the scan", async () => {
    const { userId } = await seedUser();
    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/scan_${crypto.randomUUID()}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not found" });
  });

  test("returns the gate for its scan without exposing the deployment callback URL", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { gate: Record<string, unknown> };
    expect(body.gate.id).toBe(gateId);
    expect(body.gate.scanId).toBe(scanId);
    expect(body.gate).not.toHaveProperty("deploymentCallbackUrl");
  });

  test("does not leak gates across organizations", async () => {
    const caller = await seedUser();
    const other = await seedUser();
    const { scanId } = await seedGate(other.organizationId, {
      attachScan: { ownerUserId: other.userId },
    });

    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId: caller.userId }),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("github-app install callback ownership", () => {
  const ORG_ACCOUNT = { id: 7001, login: "acme", type: "Organization" };
  const USER_ACCOUNT = { id: 9001, login: "octocat", type: "User" };

  interface GithubDouble {
    account: { id: number; login: string; type: string };
    membership?: Response;
    user?: Response;
  }

  // Routes by URL so the assertions name the exact GitHub calls the link makes.
  function mockGithub(installationId: string, double: GithubDouble) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "user-token" });
      }
      if (url === `https://api.github.com/app/installations/${installationId}`) {
        return Response.json({
          id: Number(installationId),
          account: double.account,
          target_type: double.account.type,
          suspended_at: null,
        });
      }
      if (auth !== "Bearer user-token") throw new Error(`unexpected credential for ${url}`);
      if (url === `https://api.github.com/user/memberships/orgs/${double.account.login}`) {
        return double.membership ?? new Response("{}", { status: 404 });
      }
      if (url === "https://api.github.com/user") {
        return double.user ?? new Response("{}", { status: 404 });
      }
      throw new Error(`unexpected GitHub request ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchMock;
  }

  function membership(overrides: Record<string, unknown> = {}) {
    return Response.json({
      state: "active",
      role: "admin",
      organization: { id: ORG_ACCOUNT.id, login: ORG_ACCOUNT.login },
      user: { id: 55, login: "acme-owner" },
      ...overrides,
    });
  }

  async function linkInstallation(userId: string, installationId: string, double: GithubDouble) {
    const installRes = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      "/api/v1/github-app/install",
    );
    const { state } = (await installRes.json()) as { state: string };
    const fetchMock = mockGithub(installationId, double);
    const res = await callGithubAppRoute(
      buildTestApp(mountGithubApp, { userId }),
      "POST",
      "/api/v1/github-app/install/callback",
      { state, code: "callback-code", installationId, setupAction: "install" },
    );
    return { res, fetchMock };
  }

  function newInstallationId() {
    return String(Math.floor(Math.random() * 1e9) + 1);
  }

  async function eventsFor(organizationId: string) {
    return createDb(env.DB)
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, organizationId));
  }

  test("links an organization installation for an active GitHub organization owner", async () => {
    const { userId, organizationId } = await seedUser();
    const installationId = newInstallationId();

    const { res, fetchMock } = await linkInstallation(userId, installationId, {
      account: ORG_ACCOUNT,
      membership: membership(),
    });

    expect(res.status).toBe(201);
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls).toContain(`https://api.github.com/user/memberships/orgs/${ORG_ACCOUNT.login}`);
    expect(calls).not.toContain("https://api.github.com/user/installations?per_page=100");
    const [linked] = await listInstallationsForOrganization(createDb(env.DB), organizationId);
    expect(linked).toMatchObject({ installationId, accountLogin: "acme" });
    const events = await eventsFor(organizationId);
    expect(events.map((event) => event.type)).toEqual(["github_app_installation.linked"]);
  });

  test.each([
    ["a non-admin organization member", membership({ role: "member" })],
    ["an outside collaborator", new Response('{"message":"Not Found"}', { status: 404 })],
  ])("refuses %s", async (_label, response) => {
    const { userId, organizationId } = await seedUser();

    const { res } = await linkInstallation(userId, newInstallationId(), {
      account: ORG_ACCOUNT,
      membership: response,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "installation_owner_required",
      error: "you must be an owner of acme on GitHub to link this installation",
    });
    expect(await listInstallationsForOrganization(createDb(env.DB), organizationId)).toEqual([]);
  });

  test("links a user-account installation only for that GitHub user", async () => {
    const owner = await seedUser();
    const other = await seedUser();

    const accepted = await linkInstallation(owner.userId, newInstallationId(), {
      account: USER_ACCOUNT,
      user: Response.json({ id: USER_ACCOUNT.id, login: "octocat" }),
    });
    const refused = await linkInstallation(other.userId, newInstallationId(), {
      account: USER_ACCOUNT,
      user: Response.json({ id: USER_ACCOUNT.id + 1, login: "someone-else" }),
    });

    expect(accepted.res.status).toBe(201);
    expect(refused.res.status).toBe(403);
    expect(await refused.res.json()).toMatchObject({ code: "installation_owner_required" });
    const db = createDb(env.DB);
    expect(await listInstallationsForOrganization(db, owner.organizationId)).toHaveLength(1);
    expect(await listInstallationsForOrganization(db, other.organizationId)).toEqual([]);
  });

  test.each([
    ["GitHub refuses the membership lookup", ORG_ACCOUNT, new Response("{}", { status: 403 })],
    ["the account is an enterprise", { id: 1, login: "acme-ent", type: "Enterprise" }, undefined],
  ])("fails closed when %s", async (_label, account, response) => {
    const { userId, organizationId } = await seedUser();

    const { res } = await linkInstallation(userId, newInstallationId(), {
      account,
      membership: response,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "installation_owner_unverified" });
    expect(await listInstallationsForOrganization(createDb(env.DB), organizationId)).toEqual([]);
  });

  test("re-linking to the same organization keeps the same installation row", async () => {
    const { userId, organizationId } = await seedUser();
    const installationId = newInstallationId();
    const double = () => ({ account: ORG_ACCOUNT, membership: membership() });

    const first = await linkInstallation(userId, installationId, double());
    const second = await linkInstallation(userId, installationId, double());

    expect([first.res.status, second.res.status]).toEqual([201, 201]);
    const rows = await listInstallationsForOrganization(createDb(env.DB), organizationId);
    expect(rows).toHaveLength(1);
  });

  async function seedPreviousOrganizationState() {
    const previous = await seedUser();
    const db = createDb(env.DB);
    const { gateId, installation, releaseTarget } = await seedGate(previous.organizationId);
    const now = new Date();
    await db.insert(schema.dependencyReviews).values({
      id: crypto.randomUUID(),
      organizationId: previous.organizationId,
      installationRowId: installation.id,
      repositoryId: releaseTarget.repositoryId,
      repositoryFullName: "octo/example",
      pullNumber: 1,
      headSha: "a".repeat(40),
      authorLogin: "dependabot[bot]",
      createdAt: now,
      updatedAt: now,
    });
    const setupJob = await createPublisherSetupJob(db, previous.organizationId, previous.userId, {
      installationRowId: installation.id,
    } as PublisherSetupDraftRequest);
    await db
      .update(schema.publisherSetupJobs)
      .set({ status: "running" })
      .where(eq(schema.publisherSetupJobs.id, setupJob.id));
    return { previous, gateId, installation, releaseTarget, setupJobId: setupJob.id };
  }

  test("a verified GitHub owner moves an installation linked to another organization", async () => {
    const { previous, gateId, installation, setupJobId } = await seedPreviousOrganizationState();
    const next = await seedUser();
    const db = createDb(env.DB);

    const { res } = await linkInstallation(next.userId, installation.installationId, {
      account: ORG_ACCOUNT,
      membership: membership(),
    });

    expect(res.status).toBe(201);
    const [moved] = await listInstallationsForOrganization(db, next.organizationId);
    expect(moved).toMatchObject({
      id: installation.id,
      installationId: installation.installationId,
    });
    expect(await listInstallationsForOrganization(db, previous.organizationId)).toEqual([]);
    expect(await listReleaseTargetsForOrganization(db, previous.organizationId)).toEqual([]);
    expect(await getGateForOrganization(db, previous.organizationId, gateId)).toBeNull();
    const reviews = await db
      .select()
      .from(schema.dependencyReviews)
      .where(eq(schema.dependencyReviews.installationRowId, installation.id));
    expect(reviews).toEqual([]);
    const [setupJob] = await db
      .select()
      .from(schema.publisherSetupJobs)
      .where(eq(schema.publisherSetupJobs.id, setupJobId));
    expect(setupJob.status).toBe("failed");
    expect(setupJob.failureJson).toMatchObject({ code: "installation_moved" });
    expect(setupJob.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    const [movedAway] = await eventsFor(previous.organizationId);
    expect(movedAway).toMatchObject({
      type: "github_app_installation.moved_away",
      actorUserId: null,
      metadataJson: { accountLogin: "acme", githubLogin: "acme-owner" },
    });
    const [movedHere] = await eventsFor(next.organizationId);
    expect(movedHere).toMatchObject({
      type: "github_app_installation.moved_here",
      actorUserId: next.userId,
    });
  });

  test("a non-owner cannot move an installation linked to another organization", async () => {
    const { previous, gateId, installation, setupJobId } = await seedPreviousOrganizationState();
    const next = await seedUser();
    const db = createDb(env.DB);

    const { res } = await linkInstallation(next.userId, installation.installationId, {
      account: ORG_ACCOUNT,
      membership: membership({ role: "member" }),
    });

    expect(res.status).toBe(403);
    const [kept] = await listInstallationsForOrganization(db, previous.organizationId);
    expect(kept?.id).toBe(installation.id);
    expect(await listReleaseTargetsForOrganization(db, previous.organizationId)).toHaveLength(1);
    expect(await getGateForOrganization(db, previous.organizationId, gateId)).not.toBeNull();
    const [setupJob] = await db
      .select()
      .from(schema.publisherSetupJobs)
      .where(eq(schema.publisherSetupJobs.id, setupJobId));
    expect(setupJob.status).toBe("running");
    expect(await eventsFor(previous.organizationId)).toEqual([]);
    expect(await eventsFor(next.organizationId)).toEqual([]);
  });
});
