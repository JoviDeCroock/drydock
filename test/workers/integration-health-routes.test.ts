import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDb,
  ensurePersonalOrganization,
  markNpmConnectionInvalid,
  upsertNpmConnection,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import {
  createReleaseTarget,
  markInstallationStatus,
  recordInstallationHealthFailure,
  upsertInstallation,
} from "../../server/lib/github-app";
import { encryptNpmToken } from "../../server/lib/npm-connection";
import {
  integrationHealthRoutes,
  type IntegrationHealthIssue,
} from "../../server/routes/integration-health";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
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

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/integration-health", integrationHealthRoutes);
  return app;
}

async function fetchIssues(owner: SeededUser): Promise<IntegrationHealthIssue[]> {
  const app = buildTestApp(owner);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://test.local/api/v1/integration-health"),
    env as unknown as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { issues: IntegrationHealthIssue[] };
  return body.issues;
}

describe("integration health route", () => {
  test("returns no issues when both integrations are healthy", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
    await upsertNpmConnection(db, {
      organizationId: owner.organizationId,
      registryUrl: "https://registry.npmjs.org",
      label: "npm registry",
      createdByUserId: owner.userId,
      ...encrypted,
    });
    await upsertInstallation(db, {
      organizationId: owner.organizationId,
      installationId: `${Date.now()}1`,
      accountLogin: "octo",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      createdByUserId: null,
    });

    expect(await fetchIssues(owner)).toEqual([]);
  });

  test("composes an invalid npm token and a degraded GitHub installation", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
    await upsertNpmConnection(db, {
      organizationId: owner.organizationId,
      registryUrl: "https://registry.npmjs.org",
      label: "npm registry",
      createdByUserId: owner.userId,
      ...encrypted,
    });
    await markNpmConnectionInvalid(db, {
      organizationId: owner.organizationId,
      reason: "The organization's npm token was rejected by the registry.",
    });
    const installation = await upsertInstallation(db, {
      organizationId: owner.organizationId,
      installationId: `${Date.now()}2`,
      accountLogin: "octo",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      createdByUserId: null,
    });
    await recordInstallationHealthFailure(
      db,
      installation.id,
      "GitHub rejected Drydock's installation token — re-authorize the GitHub App installation.",
    );

    const issues = await fetchIssues(owner);
    const npm = issues.find((issue) => issue.kind === "npm_token");
    const github = issues.find((issue) => issue.kind === "github_installation");

    expect(npm).toMatchObject({ severity: "critical" });
    expect(npm?.detail).toContain("rejected by the registry");
    expect(npm?.occurredAt).toBeTruthy();

    expect(github).toMatchObject({ severity: "critical" });
    expect(github?.detail).toContain("re-authorize");
    expect(github?.occurredAt).toBeTruthy();
  });

  test("flags a gated installation that was disabled on GitHub but stays quiet for ungated ones", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const gatedExternalId = `${Date.now()}3`;
    const gated = await upsertInstallation(db, {
      organizationId: owner.organizationId,
      installationId: gatedExternalId,
      accountLogin: "gated-org",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      createdByUserId: null,
    });
    await createReleaseTarget(db, {
      organizationId: owner.organizationId,
      installationRowId: gated.id,
      ecosystem: "pypi",
      repositoryId: 4242,
      repositoryFullName: "gated-org/example",
      environment: "pypi",
      createdByUserId: null,
    });
    await markInstallationStatus(db, gatedExternalId, "suspended");

    // An installation with no release target is intentionally quiet when disabled.
    const ungated = await upsertInstallation(db, {
      organizationId: owner.organizationId,
      installationId: `${Date.now()}4`,
      accountLogin: "ungated-org",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      createdByUserId: null,
    });
    await markInstallationStatus(db, ungated.installationId, "suspended");

    const issues = await fetchIssues(owner);
    const githubIssues = issues.filter((issue) => issue.kind === "github_installation");
    expect(githubIssues).toHaveLength(1);
    expect(githubIssues[0]).toMatchObject({ severity: "warn" });
    expect(githubIssues[0].title).toContain("gated-org");
    expect(githubIssues[0].detail).toContain("Re-enable");
  });
});
