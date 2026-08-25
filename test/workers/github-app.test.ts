import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember, removeOrganizationMember } from "../../server/db/invitations";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { upsertScanApproval } from "../../server/db/scan-approvals";
import {
  createScanJob,
  loadScanApprovalState,
  markScanFailed,
  setRequiredReleaseApprovals,
} from "../../server/db/scans";
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
import {
  getGateForOrganization,
  resetGateReviewForRetry,
} from "../../server/lib/github-app/webhook-gates";
import { githubAppRoutes } from "../../server/routes/github-app";
import { organizationsRoutes } from "../../server/routes/organizations";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import type { Bindings, Variables } from "../../server/types";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

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

async function seedUser(): Promise<{ userId: string; organizationId: string }> {
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
  return { userId, organizationId };
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

// `organizationId` pins the active organization the way the browser's org
// switcher does. Needed only for a caller whose active org is not their
// personal workspace — a second reviewer in a shared org.
function buildTestApp(userId: string, organizationId?: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId });
    c.set("auth", {
      api: {
        verifyTOTP: async ({ body }: { body: { code: string } }) => {
          if (body.code !== "123456") throw new Error("invalid code");
        },
      },
    } as Variables["auth"]);
    if (organizationId) c.req.raw.headers.set("x-organization-id", organizationId);
    await next();
  });
  app.route("/api/v1/github-app", githubAppRoutes);
  app.route("/api/v1/organizations", organizationsRoutes);
  return app;
}

async function callGithubAppRoute(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
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
      buildTestApp(userId),
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
      buildTestApp(userId),
      "POST",
      "/api/v1/github-app/install",
    );
    const { state } = (await installRes.json()) as { state: string };

    const res = await callGithubAppRoute(
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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

  test("POST /install/callback refuses installation ids the GitHub user cannot access", async () => {
    const { userId, organizationId } = await seedUser();
    const installRes = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      "/api/v1/github-app/install",
    );
    const { state } = (await installRes.json()) as { state: string };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "user-token" }))
      .mockResolvedValueOnce(
        Response.json({
          installations: [{ id: 456, account: { login: "octo", type: "Organization" } }],
        }),
      );

    const res = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      "/api/v1/github-app/install/callback",
      {
        state,
        code: "callback-code",
        installationId: "123",
        setupAction: "install",
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "installation_not_authorized" });
    const installations = await listInstallationsForOrganization(createDb(env.DB), organizationId);
    expect(installations).toHaveLength(0);
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
  test("does not persist a vote after the gate has finalized", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await db
      .update(schema.githubWorkflowGates)
      .set({ status: "approved", decision: "approved", decidedAt: new Date() })
      .where(eq(schema.githubWorkflowGates.id, gateId));

    const outcome = await upsertScanApproval(db, {
      scanId: scanId!,
      organizationId,
      userId,
      decision: "publish",
      reason: null,
      now: new Date(),
      hardenOnly: true,
      pendingGateId: gateId,
    });

    expect(outcome).toBe("not_actionable");
    expect(
      await db.select().from(schema.scanApprovals).where(eq(schema.scanApprovals.scanId, scanId!)),
    ).toHaveLength(0);
  });

  test("does not persist a vote after a retry advances the gate generation", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await markScanFailed(db, scanId!, organizationId, {
      code: "review_failed",
      message: "review failed",
    });
    const observed = await getGateForOrganization(db, organizationId, gateId);
    expect(observed).not.toBeNull();

    expect(await resetGateReviewForRetry(db, { gateId, organizationId })).toBe(true);
    const retried = await getGateForOrganization(db, organizationId, gateId);
    expect(retried!.updatedAt.getTime()).toBeGreaterThan(observed!.updatedAt.getTime());
    const outcome = await upsertScanApproval(db, {
      scanId: scanId!,
      organizationId,
      userId,
      decision: "publish",
      reason: null,
      now: new Date(),
      hardenOnly: true,
      pendingGateId: gateId,
      pendingGateUpdatedAt: observed!.updatedAt,
    });

    expect(outcome).toBe("not_actionable");
    expect(
      await db.select().from(schema.scanApprovals).where(eq(schema.scanApprovals.scanId, scanId!)),
    ).toHaveLength(0);
  });

  test("rejects a decision that is not approved/rejected", async () => {
    const { userId, organizationId } = await seedUser();
    const { gateId } = await seedGate(organizationId);

    const res = await callGithubAppRoute(
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(caller.userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "gate has already been decided" });
    // The CAS lost the second transition, so no extra callback is posted.
    expect(decisionCalls).toHaveLength(1);
  });

  test("a retry finishes a gate after the vote committed before its package verdict", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });
    const now = new Date();
    await db.insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId: scanId!,
      organizationId,
      userId,
      decision: "publish",
      createdAt: now,
      updatedAt: now,
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
      throw new Error(`unexpected fetch in vote recovery test: ${request.url}`);
    });

    const recovered = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ gate: { status: "approved" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);
  });

  test("opposite-decision recovery audits the durable gate vote", async () => {
    const { userId, organizationId } = await seedUser();
    const second = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId,
      userId: second.userId,
      role: "member",
    });
    await setRequiredReleaseApprovals(db, organizationId, 2);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });
    const now = new Date();
    await db.insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId: scanId!,
      organizationId,
      userId,
      decision: "no_publish",
      reason: "durable block",
      createdAt: now,
      updatedAt: now,
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
      throw new Error(`unexpected fetch in opposite-decision recovery test: ${request.url}`);
    });

    const recovered = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ gate: { status: "rejected" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "rejected" })]);
    const approvalEvents = await db
      .select({ metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, scanId!),
          eq(schema.scanEvents.type, "scan.approval_recorded"),
        ),
      );
    expect(approvalEvents).toEqual([
      {
        metadata: expect.objectContaining({
          decision: "no_publish",
          reason: "durable block",
        }),
      },
    ]);
  });

  test("a retry finishes a gate after the package verdict committed before aggregation", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });
    await db
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: userId,
        decidedAt: new Date(),
      })
      .where(eq(schema.scans.id, scanId!));
    const now = new Date();
    await db.insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId: scanId!,
      organizationId,
      userId,
      decision: "publish",
      createdAt: now,
      updatedAt: now,
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
      throw new Error(`unexpected fetch in aggregate recovery test: ${request.url}`);
    });

    const opposite = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );
    expect(opposite.status).toBe(409);
    expect(decisionCalls).toHaveLength(0);

    const recovered = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ gate: { status: "approved" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);
    expect(
      await db
        .select()
        .from(schema.scanEvents)
        .where(
          and(eq(schema.scanEvents.scanId, scanId!), eq(schema.scanEvents.type, "scan.decided")),
        ),
    ).toHaveLength(1);
  });

  test("holds the deployment until the org's approval bar is met on every package", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    // Two reviewers in the org, two approvals required. The personal workspace
    // seeded above already has one member, so this adds the second.
    const second = await seedUser();
    await addOrganizationMember(db, {
      organizationId,
      userId: second.userId,
      role: "member",
    });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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

    // One approval on a single-package gate is no longer enough to release.
    const first = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      gate: { status: "pending", requiredApprovals: 2 },
      approvals: { approvedCount: 1, required: 2, verdict: null },
    });
    expect(decisionCalls).toHaveLength(0);

    // The same member cannot supply the second approval.
    const selfRepeat = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(selfRepeat.status).toBe(409);
    expect(decisionCalls).toHaveLength(0);

    // A different member's approval meets the bar and releases the job.
    const release = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ gate: { status: "approved" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);
  });

  test("completed gates keep the approval bar that released them", async () => {
    const { userId, organizationId } = await seedUser();
    const second = await seedUser();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId,
      userId: second.userId,
      role: "member",
    });
    await setRequiredReleaseApprovals(db, organizationId, 2);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in gate policy snapshot test: ${request.url}`);
    });

    await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    const released = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(released.status).toBe(200);
    expect(
      (await getGateForOrganization(db, organizationId, gateId))?.requiredReleaseApprovals,
    ).toBe(2);

    await setRequiredReleaseApprovals(db, organizationId, 1);
    const readback = await callGithubAppRoute(
      buildTestApp(userId),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
    );
    expect(await readback.json()).toMatchObject({ gate: { requiredApprovals: 2 } });

    const [scan] = await db
      .select({
        decision: schema.scans.decision,
        decisionReason: schema.scans.decisionReason,
        decidedByUserId: schema.scans.decidedByUserId,
        decidedAt: schema.scans.decidedAt,
        source: schema.scans.source,
        gateId: schema.scans.gateId,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!));
    const approvals = await loadScanApprovalState(db, {
      scanId: scanId!,
      organizationId,
      viewerUserId: userId,
      scan,
    });
    expect(approvals.required).toBe(2);
  });

  test("removing an approver reopens an approved package while its gate is still pending", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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
    await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "beta-pkg",
      version: "1.0.0",
    });

    await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    const [approvedPackage] = await db
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!));
    expect(approvedPackage.decision).toBe("publish");
    expect((await getGateForOrganization(db, organizationId, gateId))?.status).toBe("pending");

    await removeOrganizationMember(db, organizationId, second.userId);

    const [reopenedPackage] = await db
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!));
    expect(reopenedPackage.decision).toBeNull();
    expect(
      await db
        .select()
        .from(schema.scanApprovals)
        .where(
          and(
            eq(schema.scanApprovals.scanId, scanId!),
            eq(schema.scanApprovals.userId, second.userId),
          ),
        ),
    ).toHaveLength(0);
  });

  test("a retry audits the exact durable block transition before recovering the gate", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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
    await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "beta-pkg",
      version: "1.0.0",
    });
    await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );

    // Simulate interruption after the fail-closed vote and package verdict
    // committed, but before either audit event or aggregate gate CAS ran.
    const transitionAt = new Date("2030-01-02T03:04:05.000Z");
    await db
      .update(schema.scanApprovals)
      .set({ decision: "no_publish", reason: "late blocker", updatedAt: transitionAt })
      .where(
        and(
          eq(schema.scanApprovals.scanId, scanId!),
          eq(schema.scanApprovals.userId, second.userId),
        ),
      );
    await db
      .update(schema.scans)
      .set({
        decision: "no_publish",
        decisionReason: "late blocker",
        decidedByUserId: second.userId,
        decidedAt: transitionAt,
        updatedAt: transitionAt,
      })
      .where(eq(schema.scans.id, scanId!));
    // Timestamp precision is finite, so an older opposite transition may have
    // the same timestamp. Recovery must include the decision in its identity.
    await db.insert(schema.scanEvents).values([
      {
        id: crypto.randomUUID(),
        organizationId,
        actorUserId: second.userId,
        scanId: scanId!,
        type: "scan.approval_recorded",
        metadataJson: {
          decision: "publish",
          voteUpdatedAt: transitionAt.toISOString(),
        },
        createdAt: transitionAt,
      },
      {
        id: crypto.randomUUID(),
        organizationId,
        actorUserId: second.userId,
        scanId: scanId!,
        type: "scan.decided",
        metadataJson: {
          decision: "publish",
          decisionAt: transitionAt.toISOString(),
        },
        createdAt: transitionAt,
      },
    ]);

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
      throw new Error(`unexpected fetch in block recovery test: ${request.url}`);
    });

    const recovered = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId! },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ gate: { status: "rejected" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "rejected" })]);
    const transitionEvents = await db
      .select({ type: schema.scanEvents.type, metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.scanId, scanId!));
    expect(transitionEvents).toContainEqual({
      type: "scan.approval_recorded",
      metadata: expect.objectContaining({
        decision: "no_publish",
        voteUpdatedAt: transitionAt.toISOString(),
      }),
    });
    expect(transitionEvents).toContainEqual({
      type: "scan.decided",
      metadata: expect.objectContaining({
        decision: "no_publish",
        decisionAt: transitionAt.toISOString(),
      }),
    });
  });

  test("an approval retry recovers a durable rejection with the blocker's attribution", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    // Only the recovery trigger has 2FA enabled. The final gate event belongs
    // to the durable blocker, so this proof must stay explicitly attributed to
    // the recovering member rather than being stamped on the blocker.
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, second.userId));
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
    });

    const transitionAt = new Date("2030-02-03T04:05:06.000Z");
    await db.insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId: scanId!,
      organizationId,
      userId,
      decision: "no_publish",
      reason: "found a release blocker",
      createdAt: transitionAt,
      updatedAt: transitionAt,
    });
    // The vote is durable, but the package projection and aggregate gate CAS
    // were both interrupted. Another member's approval retry repairs both.

    const decisionCalls: Array<{ state: string; comment?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string; comment?: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in attributed recovery test: ${request.url}`);
    });

    const recovered = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      {
        decision: "approved",
        scanId: scanId!,
        comment: "looks good to me",
        totpCode: "123456",
      },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      gate: { status: "rejected", decisionComment: "found a release blocker" },
    });
    expect(decisionCalls).toEqual([
      expect.objectContaining({ state: "rejected", comment: "found a release blocker" }),
    ]);
    const [gateEvent] = await db
      .select({
        actorUserId: schema.scanEvents.actorUserId,
        metadata: schema.scanEvents.metadataJson,
      })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, scanId!),
          eq(schema.scanEvents.type, "github_workflow_gate.rejected"),
        ),
      );
    expect(gateEvent).toMatchObject({
      actorUserId: userId,
      metadata: expect.objectContaining({
        recoveredByUserId: second.userId,
        recoveryTwoFactor: true,
        recoveryTwoFactorMethod: "totp",
        recoveryTwoFactorRequiredByOrg: false,
      }),
    });
    expect(gateEvent.metadata).not.toHaveProperty("twoFactor");
    expect(gateEvent.metadata).not.toHaveProperty("twoFactorMethod");
    expect(gateEvent.metadata).not.toHaveProperty("twoFactorRequiredByOrg");
  });

  test("a later package rejection preserves the first durable blocker's attribution", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
      packageName: "first-pkg",
    });
    const secondScanId = await seedGatePackageScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      packageName: "second-pkg",
      version: "2.0.0",
    });

    const firstBlockAt = new Date("2020-02-03T04:05:06.000Z");
    await db.insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId: scanId!,
      organizationId,
      userId,
      decision: "no_publish",
      reason: "first durable blocker",
      createdAt: firstBlockAt,
      updatedAt: firstBlockAt,
    });
    // Simulate interruption after the first vote but before its package
    // projection and the aggregate gate CAS. A later rejection is recovery
    // work, not the cause of the already-durable aggregate block.

    const decisionCalls: Array<{ state: string; comment?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string; comment?: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in multi-block recovery test: ${request.url}`);
    });

    const recovered = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: secondScanId, comment: "second blocker" },
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      gate: { status: "rejected", decisionComment: "first durable blocker" },
    });
    expect(decisionCalls).toEqual([
      expect.objectContaining({ state: "rejected", comment: "first durable blocker" }),
    ]);
    const [gateEvent] = await db
      .select({
        actorUserId: schema.scanEvents.actorUserId,
        metadata: schema.scanEvents.metadataJson,
      })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, scanId!),
          eq(schema.scanEvents.type, "github_workflow_gate.rejected"),
        ),
      );
    expect(gateEvent).toMatchObject({
      actorUserId: userId,
      metadata: expect.objectContaining({ recoveredByUserId: second.userId }),
    });
  });

  test("lowering the approval bar releases a gate whose existing votes now meet it", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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
      throw new Error(`unexpected fetch in policy reconciliation test: ${request.url}`);
    });

    const first = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(first.status).toBe(200);
    expect(decisionCalls).toHaveLength(0);

    const oldVoteAt = new Date("2000-01-01T00:00:00.000Z");
    await db
      .update(schema.scanApprovals)
      .set({ createdAt: oldVoteAt, updatedAt: oldVoteAt })
      .where(eq(schema.scanApprovals.scanId, scanId!));

    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, userId));

    const lowered = await callGithubAppRoute(
      buildTestApp(userId),
      "PUT",
      `/api/v1/organizations/${organizationId}/release-approvals`,
      { requiredApprovals: 1, totpCode: "123456" },
    );
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toEqual({ requiredApprovals: 1 });
    expect((await getGateForOrganization(db, organizationId, gateId))?.status).toBe("approved");
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "approved" })]);
    const [decidedScan] = await db
      .select({ decidedAt: schema.scans.decidedAt })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!));
    expect(decidedScan?.decidedAt?.getTime()).toBeGreaterThan(oldVoteAt.getTime());
    const decisionEvents = await db
      .select({ metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(
        and(eq(schema.scanEvents.scanId, scanId!), eq(schema.scanEvents.type, "scan.decided")),
      );
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]?.metadata).toMatchObject({
      decision: "publish",
      trigger: "approval_policy",
      approvedCount: 1,
      requiredApprovals: 1,
    });
  });

  test("policy reconciliation delivers a durable rejection whose package verdict was interrupted", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const blocker = await seedUser();
    await addOrganizationMember(db, {
      organizationId,
      userId: blocker.userId,
      role: "member",
    });
    await setRequiredReleaseApprovals(db, organizationId, 2);

    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await completeWorkflowGateScan({
      organizationId,
      ownerUserId: userId,
      gateId,
      scanId: scanId!,
      packageName: "blocked-pkg",
    });
    expect(
      await upsertScanApproval(db, {
        scanId: scanId!,
        organizationId,
        userId: blocker.userId,
        decision: "no_publish",
        reason: "durable blocker",
        now: new Date(),
        hardenOnly: true,
        pendingGateId: gateId,
      }),
    ).toBe("recorded");
    // Simulate interruption after the vote insert and before its scan projection.
    const [before] = await db
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId!));
    expect(before?.decision).toBeNull();

    const decisionCalls: Array<{ state: string; comment: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.endsWith("/deployment_protection_rule")) {
        decisionCalls.push((await request.json()) as { state: string; comment: string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in rejected policy reconciliation test: ${request.url}`);
    });
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, userId));

    const lowered = await callGithubAppRoute(
      buildTestApp(userId),
      "PUT",
      `/api/v1/organizations/${organizationId}/release-approvals`,
      { requiredApprovals: 1, totpCode: "123456" },
    );

    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toEqual({ requiredApprovals: 1 });
    expect(await getGateForOrganization(db, organizationId, gateId)).toMatchObject({
      status: "rejected",
      decision: "rejected",
      decisionComment: "durable blocker",
    });
    expect(decisionCalls).toEqual([
      expect.objectContaining({ state: "rejected", comment: "durable blocker" }),
    ]);
    const [gateEvent] = await db
      .select({
        actorUserId: schema.scanEvents.actorUserId,
        metadata: schema.scanEvents.metadataJson,
      })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, scanId!),
          eq(schema.scanEvents.type, "github_workflow_gate.rejected"),
        ),
      );
    expect(gateEvent).toMatchObject({
      actorUserId: blocker.userId,
      metadata: expect.objectContaining({
        decidedBy: "human",
        trigger: "approval_policy",
        recoveredByUserId: userId,
      }),
    });
  });

  test("a reviewer who approved can still block before the bar is met", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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

    await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    // Nothing has released yet, so changing your mind in the fail-closed
    // direction has to still be possible.
    const blocked = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId!, comment: "spotted a postinstall" },
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ gate: { status: "rejected" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "rejected" })]);
  });

  test("a reviewer can still block a published package while its multi-package gate is pending", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    const third = await seedUser();
    await addOrganizationMember(db, { organizationId, userId: second.userId, role: "member" });
    await addOrganizationMember(db, { organizationId, userId: third.userId, role: "member" });
    await setRequiredReleaseApprovals(db, organizationId, 2);

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
      throw new Error(`unexpected fetch in gate hardening test: ${request.url}`);
    });

    await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    const packageQuorum = await callGithubAppRoute(
      buildTestApp(second.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(packageQuorum.status).toBe(200);
    expect(await packageQuorum.json()).toMatchObject({ gate: { status: "pending" } });

    const blocked = await callGithubAppRoute(
      buildTestApp(third.userId, organizationId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "rejected", scanId: scanId!, comment: "late blocker" },
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ gate: { status: "rejected" } });
    expect(decisionCalls).toEqual([expect.objectContaining({ state: "rejected" })]);
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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

  test("refuses to retry a failed gate after a partial approval", async () => {
    const { userId, organizationId } = await seedUser();
    const db = createDb(env.DB);
    const second = await seedUser();
    await addOrganizationMember(db, {
      organizationId,
      userId: second.userId,
      role: "member",
    });
    await setRequiredReleaseApprovals(db, organizationId, 2);
    const { gateId, scanId } = await seedGate(organizationId, {
      attachScan: { ownerUserId: userId },
    });
    await markScanFailed(db, scanId!, organizationId, {
      code: "review_failed",
      message: "review failed",
    });

    const approval = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/decision`,
      { decision: "approved", scanId: scanId! },
    );
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      gate: { status: "pending" },
      approvals: { approvedCount: 1, required: 2, verdict: null },
    });

    const queueSend = vi.fn(async () => undefined);
    const retry = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      `/api/v1/github-app/workflow-gates/${gateId}/retry`,
      {},
      { SCAN_QUEUE: { send: queueSend } as unknown as Queue },
    );

    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "gate review is not retryable" });
    expect(queueSend).not.toHaveBeenCalled();
    expect(
      await db.select().from(schema.scanApprovals).where(eq(schema.scanApprovals.scanId, scanId!)),
    ).toHaveLength(1);
  });
});

describe("github-app workflow-gate by-scan route", () => {
  test("returns 404 when no gate references the scan", async () => {
    const { userId } = await seedUser();
    const res = await callGithubAppRoute(
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(caller.userId),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
    );
    expect(res.status).toBe(404);
  });
});
