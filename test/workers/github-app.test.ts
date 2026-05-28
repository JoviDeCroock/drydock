import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb, ensurePersonalOrganization } from "../../server/db";
import * as schema from "../../server/db/schema";
import {
  GithubAppValidationError,
  createReleaseTarget,
  deleteReleaseTarget,
  getInstallationByExternalId,
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
  markInstallationStatus,
  resolveDeploymentProtectionTarget,
  upsertInstallation,
} from "../../server/lib/github-app";
import { githubAppRoutes } from "../../server/routes/github-app";
import type { Bindings, Variables } from "../../server/types";

const originalFetch = globalThis.fetch;

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

function buildTestApp(userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId });
    await next();
  });
  app.route("/api/v1/github-app", githubAppRoutes);
  return app;
}

async function callGithubAppRoute(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  method: string,
  path: string,
  body?: unknown,
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
    GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
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
        packageName: "example",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        workflowFilename: null,
        environment: "pypi",
        pypiTrustedPublisherEnvironment: "pypi",
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
        packageName: "example",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        workflowFilename: null,
        environment: "pypi",
        pypiTrustedPublisherEnvironment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "installation_inactive" });
  });

  test("rejects duplicate (org, ecosystem, package) mappings", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const dbInstance = createDb(env.DB);

    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      packageName: "example",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
      createdByUserId: null,
    });

    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        packageName: "example",
        repositoryId: 2,
        repositoryFullName: "octo/example-2",
        workflowFilename: null,
        environment: "pypi",
        pypiTrustedPublisherEnvironment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "package_already_mapped" });
  });

  test("normalizes equivalent PyPI package names before enforcing uniqueness", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const dbInstance = createDb(env.DB);

    const target = await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      packageName: "Example.Package",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
      createdByUserId: null,
    });

    expect(target.packageName).toBe("example-package");
    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        packageName: "example_package",
        repositoryId: 2,
        repositoryFullName: "octo/example-2",
        workflowFilename: null,
        environment: "pypi-2",
        pypiTrustedPublisherEnvironment: "pypi-2",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "package_already_mapped" });
  });

  test("rejects environment mismatch with the trusted publisher environment", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);

    await expect(
      createReleaseTarget(createDb(env.DB), {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        packageName: "example",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        workflowFilename: null,
        environment: "drydock",
        pypiTrustedPublisherEnvironment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "environment_mismatch" });
  });

  test("rejects duplicate repository/environment mappings within an organization", async () => {
    const { organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const dbInstance = createDb(env.DB);

    await createReleaseTarget(dbInstance, {
      organizationId,
      installationRowId: installation.id,
      ecosystem: "pypi",
      packageName: "example-a",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
      createdByUserId: null,
    });

    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        packageName: "example-b",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        workflowFilename: null,
        environment: "pypi",
        pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "example-a",
      repositoryId: 1,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "PyPI",
      pypiTrustedPublisherEnvironment: "pypi",
      createdByUserId: null,
    });

    expect(target.environment).toBe("pypi");
    expect(target.pypiTrustedPublisherEnvironment).toBe("pypi");
    await expect(
      createReleaseTarget(dbInstance, {
        organizationId,
        installationRowId: installation.id,
        ecosystem: "pypi",
        packageName: "example-b",
        repositoryId: 1,
        repositoryFullName: "octo/example",
        workflowFilename: null,
        environment: "PYPI",
        pypiTrustedPublisherEnvironment: "pypi",
        createdByUserId: null,
      }),
    ).rejects.toMatchObject({ code: "environment_already_mapped" });
  });
});

describe("github-app routes", () => {
  test("POST /release-targets requires an explicit PyPI Trusted Publisher environment", async () => {
    const { userId } = await seedUser();
    const res = await callGithubAppRoute(
      buildTestApp(userId),
      "POST",
      "/api/v1/github-app/release-targets",
      {
        installationRowId: "install-row",
        ecosystem: "pypi",
        packageName: "example",
        repositoryFullName: "octo/example",
        environment: "pypi",
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "pypiTrustedPublisherEnvironment is required",
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
      packageName: "example",
      repositoryId: 9001,
      repositoryFullName: "octo/example",
      workflowFilename: "release.yml",
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "example-case",
      repositoryId: 9002,
      repositoryFullName: "octo/example-case",
      workflowFilename: "release.yml",
      environment: "PyPI",
      pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "example",
      repositoryId: 42,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "example",
      repositoryId: 42,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "example",
      repositoryId: 77,
      repositoryFullName: "octo/example",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
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
      packageName: "shared-name",
      repositoryId: 1,
      repositoryFullName: "octo/a",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
      createdByUserId: null,
    });
    await createReleaseTarget(dbInstance, {
      organizationId: b.organizationId,
      installationRowId: installB.id,
      ecosystem: "pypi",
      packageName: "shared-name",
      repositoryId: 2,
      repositoryFullName: "octo/b",
      workflowFilename: null,
      environment: "pypi",
      pypiTrustedPublisherEnvironment: "pypi",
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
