import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  deleteOrganization,
  deleteUserAccount,
  ensurePersonalOrganization,
} from "../../server/db/organizations";
import { createScanJob, discardGateScans } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import type { DiffEntry, FileRecord } from "../../server/lib/review";
import {
  deleteOrganizationArtifacts,
  deleteScanArtifacts,
  writeScanArtifacts,
} from "../../server/lib/scan-artifacts";
import { sha256Hex, stableJson } from "../../server/lib/stable-json";

// Mirrors the private safeSegment in scan-artifacts.ts: object keys live under
// `orgs/{seg(orgId)}/scans/{seg(scanId)}/...`, so listing/asserting in the test
// has to encode the same way the writer does.
function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

// writeScanArtifacts emits exactly four objects per scan: report/files/diff +
// the manifest. The cleanup assertions count against this.
const OBJECTS_PER_SCAN = 4;

const files: FileRecord[] = [
  { path: "index.js", size: 14, sha256: "a".repeat(64), textSample: "console.log(1)", flags: [] },
];
const diff: DiffEntry[] = [
  { path: "index.js", status: "added", stagedSize: 14, stagedSha256: "a".repeat(64), flags: [] },
];

async function seedUser() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Cleanup Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { db, userId, organizationId };
}

async function seedScanArtifacts(organizationId: string, scanId: string) {
  // Contents are irrelevant to deletion; the cleanup tests never read them back.
  const reportJson = stableJson({ version: 1, ruleFindings: [], findingAnnotations: [] });
  const reportDigest = await sha256Hex(reportJson);
  await writeScanArtifacts(env.ARTIFACTS, {
    organizationId,
    scanId,
    reportJson,
    reportDigest,
    files,
    diff,
    generatedAt: "2026-06-17T00:00:00.000Z",
  });
}

async function listOrgKeys(organizationId: string): Promise<string[]> {
  const listed = await env.ARTIFACTS.list({ prefix: `orgs/${safeSegment(organizationId)}/` });
  return listed.objects.map((object) => object.key);
}

// scans.gate_id is an enforced FK in the test D1, so a gate-attached scan needs
// the full installation → release-target → gate chain to exist first.
async function seedGate(db: ReturnType<typeof createDb>, organizationId: string): Promise<string> {
  const now = new Date();
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: `inst_${crypto.randomUUID()}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "npm",
    repositoryId: 1234,
    repositoryFullName: "octo/example",
    environment: "npm",
    createdByUserId: null,
  });
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: 1234,
    repositoryFullName: "octo/example",
    environment: "npm",
    runId: 1,
    deploymentCallbackUrl: "https://api.github.com/example",
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gateId;
}

async function scanExists(db: ReturnType<typeof createDb>, scanId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.scans.id })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId));
  return rows.length > 0;
}

describe("scan artifact deletion helpers", () => {
  test("deleteOrganizationArtifacts removes only the target org's objects", async () => {
    const orgA = `org_${crypto.randomUUID()}`;
    const orgB = `org_${crypto.randomUUID()}`;
    await seedScanArtifacts(orgA, "scan_1");
    await seedScanArtifacts(orgA, "scan_2");
    await seedScanArtifacts(orgB, "scan_1");

    expect((await listOrgKeys(orgA)).length).toBe(OBJECTS_PER_SCAN * 2);

    await deleteOrganizationArtifacts(env.ARTIFACTS, orgA);

    expect(await listOrgKeys(orgA)).toEqual([]);
    expect((await listOrgKeys(orgB)).length).toBe(OBJECTS_PER_SCAN);
  });

  test("deleteScanArtifacts removes one scan and leaves siblings in the same org", async () => {
    const org = `org_${crypto.randomUUID()}`;
    await seedScanArtifacts(org, "scan_keep");
    await seedScanArtifacts(org, "scan_drop");

    await deleteScanArtifacts(env.ARTIFACTS, org, "scan_drop");

    const remaining = await listOrgKeys(org);
    expect(remaining.length).toBe(OBJECTS_PER_SCAN);
    expect(remaining.every((key) => key.includes("/scans/scan_keep/"))).toBe(true);
  });

  test("a missing bucket is a no-op rather than a throw", async () => {
    await expect(deleteOrganizationArtifacts(undefined, "org_x")).resolves.toBeUndefined();
    await expect(deleteScanArtifacts(undefined, "org_x", "scan_x")).resolves.toBeUndefined();
  });
});

describe("R2 cleanup follows D1 deletion", () => {
  test("deleteOrganization tears down the org's R2 artifacts with its D1 scans", async () => {
    const { db, userId, organizationId } = await seedUser();
    const scanId = `scan_${crypto.randomUUID()}`;
    await seedScanArtifacts(organizationId, scanId);
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-1",
      organizationId,
      ownerUserId: userId,
    });

    expect((await listOrgKeys(organizationId)).length).toBe(OBJECTS_PER_SCAN);

    await deleteOrganization(db, organizationId, env.ARTIFACTS);

    expect(await listOrgKeys(organizationId)).toEqual([]);
    expect(await scanExists(db, scanId)).toBe(false);
  });

  test("deleteUserAccount clears the user's personal-org artifacts", async () => {
    const { db, userId, organizationId } = await seedUser();
    const scanId = `scan_${crypto.randomUUID()}`;
    await seedScanArtifacts(organizationId, scanId);
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-1",
      organizationId,
      ownerUserId: userId,
    });

    await deleteUserAccount(db, userId, env.ARTIFACTS);

    expect(await listOrgKeys(organizationId)).toEqual([]);
  });

  test("discardGateScans clears artifacts for the gate's discarded scans", async () => {
    const { db, userId, organizationId } = await seedUser();
    const gateId = await seedGate(db, organizationId);
    const scanId = `scan_${crypto.randomUUID()}`;
    await seedScanArtifacts(organizationId, scanId);
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-1",
      organizationId,
      ownerUserId: userId,
      gateId,
    });

    await discardGateScans(db, gateId, organizationId, env.ARTIFACTS);

    expect(await listOrgKeys(organizationId)).toEqual([]);
    expect(await scanExists(db, scanId)).toBe(false);
  });

  test("deleteOrganization without a bucket leaves D1 clean and never throws", async () => {
    const { db, userId, organizationId } = await seedUser();
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: "stage-1",
      organizationId,
      ownerUserId: userId,
    });

    await deleteOrganization(db, organizationId);

    expect(await scanExists(db, scanId)).toBe(false);
  });
});
