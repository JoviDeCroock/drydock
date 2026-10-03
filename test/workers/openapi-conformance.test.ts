import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { ECOSYSTEMS } from "../../server/lib/ecosystems";
import { PUBLIC_NPM_REGISTRY } from "../../server/lib/ecosystems/npm/public-diff";
import { OPENAPI_OPERATIONS } from "../../server/lib/openapi/document";
import { computePublicDiffCacheKey, writePublicDiffCache } from "../../server/lib/public-diff";
import { summarizePackageJsonDiff } from "../../server/lib/review/serialize";
import { type Jar, callWorker, signUpUserId } from "./helpers/auth-http";
import { seedCompletedScan } from "./helpers/seed";

// Every documented response schema is checked against what the Worker actually
// serves, so docs/openapi.json cannot promise a field the API does not send.

async function seedGate(organizationId: string, scanId: string): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date("2026-08-02T00:00:00.000Z");
  const installationId = crypto.randomUUID();
  const releaseTargetId = crypto.randomUUID();
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId,
    installationId: crypto.randomUUID(),
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId,
    installationRowId: installationId,
    ecosystem: "npm",
    repositoryId: 42,
    repositoryFullName: "octo/release",
    environment: "production",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installationId,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: 42,
    repositoryFullName: "octo/release",
    environment: "production",
    runId: 987654,
    deploymentId: 123,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/release/actions/runs/987654/deployment_protection_rule",
    eventAction: "requested",
    status: "pending",
    scanId,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.update(schema.scans).set({ gateId }).where(eq(schema.scans.id, scanId));
}

async function seedPublicDiff(packageName: string): Promise<void> {
  const textSample = "export const value = 1;\n";
  const record = (sha256: string) => ({
    path: "index.js",
    size: textSample.length,
    sha256,
    flags: [],
    textSample,
  });
  await writePublicDiffCache(
    env,
    await computePublicDiffCacheKey({
      ecosystem: "npm",
      registryUrl: PUBLIC_NPM_REGISTRY,
      packageName,
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    }),
    {
      ecosystem: "npm",
      packageName,
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      fromPackageJson: null,
      toPackageJson: null,
      fromFiles: [record("before")],
      toFiles: [record("after")],
      diff: [{ path: "index.js", status: "modified", flags: [] }],
      packageJsonDiff: summarizePackageJsonDiff(null, null),
      findings: [
        {
          severity: "medium",
          file: "index.js",
          evidence: "fetch(url)",
          reason: "network access",
          line: 1,
          ruleId: "code.network-access",
          ruleVersion: "1.0.0",
          diffStatus: "modified",
          releaseDelta: true,
        },
      ],
      risk: {
        artifactRisk: "medium",
        releaseRisk: "medium",
        contextRisk: "low",
        releaseFindingCount: 1,
        contextFindingCount: 0,
        unknownFindingCount: 0,
        priorApprovedContextFindingCount: 0,
      },
      cachedAt: "2026-07-15T00:00:00.000Z",
    },
  );
}

describe("OpenAPI response schemas match the Worker", () => {
  test("every documented operation's 200 body parses with its schema", async () => {
    const jar: Jar = new Map();
    const userId = await signUpUserId(jar);
    expect((await callWorker("GET", "/api/v1/organizations", { jar })).res.status).toBe(200);
    const organizationId = personalOrganizationId(userId);
    const scanId = await seedCompletedScan(
      { userId, organizationId },
      {
        packageJson: { name: "@acme/documented", version: "1.1.0" },
        findings: [
          {
            severity: "high",
            file: "index.js",
            evidence: "child_process.exec(cmd)",
            reason: "process execution",
            line: 3,
            ruleId: "code.process-execution",
            ruleVersion: "1.0.0",
          },
        ],
      },
    );
    await seedGate(organizationId, scanId);
    const publicPackage = `documented-${crypto.randomUUID()}`;
    await seedPublicDiff(publicPackage);

    const created = await callWorker("POST", "/api/v1/api-keys", { jar, body: { name: "spec" } });
    const token = created.json?.token as string;
    const auth = { headers: { authorization: `Bearer ${token}` } };

    const requests: Record<string, string> = {
      getCurrentApiKey: "/api/v1/api-keys/current",
      getOpenApiDocument: "/api/v1/openapi.json",
      listScans: "/api/v1/scans?filter=all",
      getScanOverview: "/api/v1/scans/overview",
      getScan: `/api/v1/scans/${scanId}`,
      getScanStatus: `/api/v1/scans/${scanId}/status`,
      exportScanReport: `/api/v1/scans/${scanId}/report.json`,
      getReleaseReceipt: `/api/v1/scans/${scanId}/release-receipt.json`,
      listPackageReleases: "/api/v1/packages/@acme/documented/releases",
      getWorkflowGateByScan: `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
      getPublicPackageDiff: `/api/public/v1/package-diff?package=${publicPackage}&from=1.0.0&to=1.0.1`,
    };
    // Listing versions reaches the live registry; its schema is deliberately
    // loose and is the one operation this suite does not exercise.
    const unexercised = new Set(["listPublicPackageVersions"]);

    expect(
      OPENAPI_OPERATIONS.map((operation) => operation.operationId)
        .filter((id) => !unexercised.has(id))
        .sort(),
    ).toEqual(Object.keys(requests).sort());

    for (const operation of OPENAPI_OPERATIONS) {
      const path = requests[operation.operationId];
      if (!path) continue;
      const res = await callWorker("GET", path, operation.anonymous ? {} : auth);
      expect(res.res.status, `${operation.operationId}: ${res.text.slice(0, 300)}`).toBe(200);
      const parsed = operation.response.safeParse(res.json);
      expect(parsed.success, `${operation.operationId}: ${parsed.error?.message}`).toBe(true);
    }

    const scans = (await callWorker("GET", "/api/v1/scans?filter=all", auth)).json as {
      scans: Array<{ ecosystem: string | null }>;
    };
    expect(ECOSYSTEMS.map((eco) => eco.id)).toContain(scans.scans[0]?.ecosystem);
  });
});
