import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { readGithubAppConfig } from "../../server/lib/github-app/config";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { prepareReleaseCandidatesForGate } from "../../server/lib/workflow-gates/prepare";
import { pypiWorkflowGateAdapter } from "../../server/lib/workflow-gates/pypi";
import {
  UnsupportedEcosystemError,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/workflow-gates/registry";

// ── Pure adapter dispatch ────────────────────────────────────────────────────

describe("workflow-gate adapter registry", () => {
  test("resolves the PyPI adapter by ecosystem", () => {
    const adapter = getWorkflowGateAdapter("pypi");
    expect(adapter).toBe(pypiWorkflowGateAdapter);
    expect(adapter.ecosystem).toBe("pypi");
  });

  test("throws UnsupportedEcosystemError for an ecosystem without an adapter", () => {
    let caught: unknown;
    try {
      getWorkflowGateAdapter("cargo");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedEcosystemError);
    expect((caught as UnsupportedEcosystemError).ecosystem).toBe("cargo");
  });

  test("lists every registered ecosystem", () => {
    expect(supportedWorkflowGateEcosystems()).toContain("pypi");
  });
});

// ── Dispatch failure inside the shared runner ────────────────────────────────

function buildConfig() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return readGithubAppConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  });
}

// Seed an org + active installation + a pending gate whose release target names
// an ecosystem with no registered workflow-gate adapter. The release target is
// inserted directly (not via `createReleaseTarget`, which rejects unsupported
// ecosystems) so we can exercise the runner's adapter-selection failure.
async function seedUnsupportedEcosystemGate(ecosystem: string) {
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
    installationId: "9200",
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTargetId = crypto.randomUUID();
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId,
    installationRowId: installation.id,
    ecosystem,
    repositoryId: 72001,
    repositoryFullName: "octo/example",
    environment: "release",
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: 72001,
    repositoryFullName: "octo/example",
    environment: "release",
    runId: 7000,
    deploymentId: 909,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/example/actions/runs/7000/deployment_protection_rule",
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, gateId };
}

describe("prepareReleaseCandidatesForGate adapter dispatch", () => {
  test("marks the gate errored and rethrows when the ecosystem has no adapter", async () => {
    const { organizationId, gateId } = await seedUnsupportedEcosystemGate("cargo");
    const ctx = createExecutionContext();
    const config = buildConfig();
    const db = createDb(env.DB);

    await expect(
      prepareReleaseCandidatesForGate(env, ctx, db, { config, organizationId, gateId }),
    ).rejects.toBeInstanceOf(UnsupportedEcosystemError);

    // A configuration/data problem leaves the gate pending (never auto-approved)
    // with the typed reason recorded for the dashboard.
    const refreshed = await getGateForOrganization(db, organizationId, gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("unsupported_ecosystem");
  });
});
