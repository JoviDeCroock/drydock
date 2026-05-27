import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
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
