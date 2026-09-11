import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember, removeOrganizationMember } from "../../server/db/invitations";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { canonicalJson } from "../../server/lib/platform/canonical-json";
import { sha256Hex } from "../../server/lib/platform/crypto-utils";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

interface Owner {
  userId: string;
  organizationId: string;
}

async function seedOwner(): Promise<Owner> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Receipt tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return { userId, organizationId: (await ensurePersonalOrganization(db, { userId }))! };
}

function appFor(owner: Owner) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: owner.userId });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function request(app: ReturnType<typeof appFor>, scanId: string, artifact: string) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://test.local/api/v1/scans/${scanId}/${artifact}`),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedCompleted(
  owner: Owner,
  options: {
    source?: "manual" | "workflow_gate";
    gateId?: string;
    summary?: Record<string, unknown>;
  } = {},
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source: options.source,
    gateId: options.gateId,
  });
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@receipt/example", version: "2.0.0" },
    previousPackageJson: { name: "@receipt/example", version: "1.0.0" },
    risk: "medium",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: "persisted-report-digest",
        digestAlgorithm: "sha256",
        generatedAt: "2026-08-01T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      ...options.summary,
    },
    ai: null,
    files: [],
    diff: [],
    findings: [],
  });
  return scanId;
}

async function seedGate(owner: Owner, options: { requiredReleaseApprovals?: number } = {}) {
  const db = createDb(env.DB);
  const now = new Date("2026-08-02T00:00:00.000Z");
  const installationId = crypto.randomUUID();
  const externalInstallationId = crypto.randomUUID();
  const releaseTargetId = crypto.randomUUID();
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId: owner.organizationId,
    installationId: externalInstallationId,
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
    organizationId: owner.organizationId,
    installationRowId: installationId,
    ecosystem: "pypi",
    repositoryId: 42,
    repositoryFullName: "octo/release",
    environment: "production",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: owner.organizationId,
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
    status: "approved",
    decision: "approved",
    decidedAt: now,
    requiredReleaseApprovals: options.requiredReleaseApprovals ?? null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gateId;
}

describe("canonical release receipt v1", () => {
  test("is deterministic and binds both its content address and exact report bytes", async () => {
    const owner = await seedOwner();
    const scanId = await seedCompleted(owner, {
      summary: {
        intentEnvelope: {
          tier: "declared",
          repository: "https://github.com/octo/release",
          signals: [{ kind: "manifest-repository", detail: "package manifest repository" }],
        },
        stagedPublish: {
          artifactIntegrity: {
            algorithm: "sha1",
            status: "verified",
            declared: "a".repeat(40),
            computed: "a".repeat(40),
          },
        },
      },
    });
    const app = appFor(owner);
    const first = await request(app, scanId, "release-receipt.json");
    const bytes = await first.text();
    const second = await request(app, scanId, "release-receipt.json");
    expect(await second.text()).toBe(bytes);

    const document = JSON.parse(bytes) as any;
    expect(document.schema).toBe("drydock.release-receipt.v1");
    expect(document.address.value).toBe(await sha256Hex(canonicalJson(document.content)));
    expect(first.headers.get("x-drydock-receipt-sha256")).toBe(await sha256Hex(bytes));
    expect(first.headers.get("etag")).toBe(`"sha256:${await sha256Hex(bytes)}"`);

    const report = await request(app, scanId, "report.json");
    expect(document.content.report).toEqual({
      schema: "drydock.report.v2",
      digest: { algorithm: "sha256", value: await sha256Hex(await report.text()) },
    });
  });

  test("keeps staged controls distinct from registry observation", async () => {
    const owner = await seedOwner();
    const scanId = await seedCompleted(owner, {
      summary: {
        intentEnvelope: { tier: "absent", repository: null, signals: [] },
        stagedPublish: {
          artifactIntegrity: {
            algorithm: "sha1",
            status: "verified",
            declared: "b".repeat(40),
            computed: "b".repeat(40),
          },
        },
      },
    });
    const db = createDb(env.DB);
    await db
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: owner.userId,
        decidedAt: new Date("2026-08-03T00:00:00.000Z"),
        registryVersionStatus: "published",
        registryVersionStatusAt: new Date("2026-08-04T00:00:00.000Z"),
      })
      .where(eq(schema.scans.id, scanId));

    const response = await request(appFor(owner), scanId, "release-receipt.json");
    const receipt = (await response.json()) as any;
    expect(receipt.content.release).toMatchObject({
      mode: "staged_publish",
      source: "manual",
      control: { classification: "advisory", scope: "registry_stage_observation" },
      decision: {
        outcome: "publish",
        decidedAt: "2026-08-03T00:00:00.000Z",
        reviewer: { kind: "drydock_user", id: owner.userId },
      },
    });
    expect(receipt.content.evidence.status).toBe("complete");
    expect(receipt.content.evidence.workflowGate).toEqual({
      status: "not_applicable",
      identity: null,
      decision: null,
      callback: null,
    });
    expect(receipt.content.evidence.registryOutcome).toEqual({
      status: "complete",
      observation: { status: "published", observedAt: "2026-08-04T00:00:00.000Z" },
    });
  });

  test("binds workflow identity and durable decision without claiming callback delivery", async () => {
    const owner = await seedOwner();
    const gateId = await seedGate(owner);
    const provenance = {
      ecosystem: "pypi",
      mode: "workflow_gate",
      artifacts: [
        { path: "dist/example-2.0.0.whl", kind: "wheel", sha256: "c".repeat(64) },
        { path: "dist/example-2.0.0.tar.gz", kind: "sdist", sha256: "d".repeat(64) },
      ],
    };
    const scanId = await seedCompleted(owner, {
      source: "workflow_gate",
      gateId,
      summary: {
        intentEnvelope: {
          tier: "attested",
          repository: "https://github.com/octo/release",
          signals: [{ kind: "workflow-gate", detail: "octo/release run 987654 production" }],
        },
        stagedPublish: { provenance },
      },
    });
    await createDb(env.DB)
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: owner.userId,
        decidedAt: new Date("2026-08-02T00:00:00.000Z"),
      })
      .where(eq(schema.scans.id, scanId));
    const receipt = (await (
      await request(appFor(owner), scanId, "release-receipt.json")
    ).json()) as any;

    expect(receipt.content.release.mode).toBe("workflow_gate");
    expect(receipt.content.release.control).toEqual({
      classification: "workflow_enforced",
      scope: "configured_publish_workflow",
    });
    expect(receipt.content.evidence.reviewedArtifacts).toEqual({
      status: "complete",
      provenance,
      stagedArtifactIntegrity: null,
    });
    expect(receipt.content.evidence.workflowGate).toEqual({
      status: "complete",
      identity: { repository: "octo/release", runId: 987654, environment: "production" },
      decision: {
        status: "approved",
        outcome: "approved",
        decidedAt: "2026-08-02T00:00:00.000Z",
      },
      callback: { outcome: "unknown", observedAt: null },
    });
    expect(receipt.content.evidence.registryOutcome).toEqual({
      status: "unknown",
      observation: null,
    });
  });

  test("marks pending gates and malformed artifact digests as incomplete evidence", async () => {
    const owner = await seedOwner();
    const gateId = await seedGate(owner);
    const db = createDb(env.DB);
    await db
      .update(schema.githubWorkflowGates)
      .set({ status: "pending", decision: null, decidedAt: null })
      .where(eq(schema.githubWorkflowGates.id, gateId));
    const scanId = await seedCompleted(owner, {
      source: "workflow_gate",
      gateId,
      summary: {
        intentEnvelope: {
          tier: "attested",
          repository: "https://github.com/octo/release",
          signals: [],
        },
        stagedPublish: {
          provenance: {
            ecosystem: "pypi",
            mode: "workflow_gate",
            artifacts: [{ path: "dist/example.whl", kind: "wheel", sha256: "not-a-digest" }],
          },
        },
      },
    });

    const receipt = (await (
      await request(appFor(owner), scanId, "release-receipt.json")
    ).json()) as any;
    expect(receipt.content.evidence.status).toBe("conflicting");
    expect(receipt.content.evidence.reviewedArtifacts.status).toBe("conflicting");
    expect(receipt.content.evidence.workflowGate.status).toBe("partial");
    expect(receipt.content.evidence.releaseDecision.status).toBe("unknown");
  });

  test("keeps incomplete and cross-organization scans outside the receipt boundary", async () => {
    const owner = await seedOwner();
    const outsider = await seedOwner();
    const completeScanId = await seedCompleted(owner);
    expect((await request(appFor(outsider), completeScanId, "release-receipt.json")).status).toBe(
      404,
    );

    const pendingScanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(createDb(env.DB), {
      id: pendingScanId,
      stageId: `stage_${crypto.randomUUID()}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    expect((await request(appFor(owner), pendingScanId, "release-receipt.json")).status).toBe(409);
  });

  test("uses explicit unknowns and partial completeness for legacy missing evidence", async () => {
    const owner = await seedOwner();
    const scanId = await seedCompleted(owner);
    const receipt = (await (
      await request(appFor(owner), scanId, "release-receipt.json")
    ).json()) as any;
    expect(receipt.content.evidence.status).toBe("partial");
    expect(receipt.content.evidence.reviewedArtifacts).toEqual({
      status: "unknown",
      provenance: null,
      stagedArtifactIntegrity: null,
    });
    expect(receipt.content.evidence.intentBinding).toEqual({ status: "unknown", envelope: null });
    expect(receipt.content.evidence.registryOutcome).toEqual({
      status: "unknown",
      observation: null,
    });
  });
});

describe("release receipt multi-party approvals", () => {
  async function recordVote(
    scanId: string,
    organizationId: string,
    userId: string,
    decision: "publish" | "no_publish",
    votedAt: Date,
  ) {
    await createDb(env.DB).insert(schema.scanApprovals).values({
      id: crypto.randomUUID(),
      scanId,
      organizationId,
      userId,
      decision,
      reason: null,
      createdAt: votedAt,
      updatedAt: votedAt,
    });
  }

  test("single-approver receipts omit the roster and keep pre-approval bytes", async () => {
    const owner = await seedOwner();
    const scanId = await seedCompleted(owner);
    await recordVote(scanId, owner.organizationId, owner.userId, "publish", new Date());
    await createDb(env.DB)
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: owner.userId,
        decidedAt: new Date("2026-08-05T00:00:00.000Z"),
      })
      .where(eq(schema.scans.id, scanId));

    const app = appFor(owner);
    const bytes = await (await request(app, scanId, "release-receipt.json")).text();
    expect(await (await request(app, scanId, "release-receipt.json")).text()).toBe(bytes);
    expect(bytes).not.toContain('"approvals"');
    const receipt = JSON.parse(bytes) as any;
    expect(receipt.content.release.decision).toEqual({
      outcome: "publish",
      decidedAt: "2026-08-05T00:00:00.000Z",
      reviewer: { kind: "drydock_user", id: owner.userId },
    });
  });

  test("embeds the bar and roster under a multi-party policy, keeping reviewer decisive", async () => {
    const owner = await seedOwner();
    const second = await seedOwner();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: second.userId,
      role: "member",
    });
    await db
      .update(schema.organizations)
      .set({ requiredReleaseApprovals: 2 })
      .where(eq(schema.organizations.id, owner.organizationId));

    const scanId = await seedCompleted(owner);
    await recordVote(
      scanId,
      owner.organizationId,
      owner.userId,
      "publish",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    await recordVote(
      scanId,
      owner.organizationId,
      second.userId,
      "publish",
      new Date("2026-08-05T01:00:00.000Z"),
    );
    await db
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: second.userId,
        decidedAt: new Date("2026-08-05T01:00:00.000Z"),
      })
      .where(eq(schema.scans.id, scanId));

    const app = appFor(owner);
    const bytes = await (await request(app, scanId, "release-receipt.json")).text();
    const receipt = JSON.parse(bytes) as any;
    expect(receipt.content.release.decision.reviewer).toEqual({
      kind: "drydock_user",
      id: second.userId,
    });
    expect(receipt.content.release.decision.approvals).toEqual({
      required: 2,
      votes: [
        {
          voter: { kind: "drydock_user", id: owner.userId },
          decision: "publish",
          votedAt: "2026-08-05T00:00:00.000Z",
        },
        {
          voter: { kind: "drydock_user", id: second.userId },
          decision: "publish",
          votedAt: "2026-08-05T01:00:00.000Z",
        },
      ],
    });
    expect(bytes).not.toContain("Receipt tester");
    expect(bytes).not.toContain("@example.com");
    expect(receipt.address.value).toBe(await sha256Hex(canonicalJson(receipt.content)));

    // The decided roster is historical: a voter leaving the organization later
    // must not change what the release receipt asserts.
    await removeOrganizationMember(db, owner.organizationId, second.userId);
    expect(await (await request(app, scanId, "release-receipt.json")).text()).toBe(bytes);
  });

  test("completed gates use their policy snapshot, not the live organization bar", async () => {
    const owner = await seedOwner();
    const db = createDb(env.DB);
    const snapshotGateId = await seedGate(owner, { requiredReleaseApprovals: 2 });
    const snapshotScanId = await seedCompleted(owner, {
      source: "workflow_gate",
      gateId: snapshotGateId,
    });
    await recordVote(
      snapshotScanId,
      owner.organizationId,
      owner.userId,
      "publish",
      new Date("2026-08-05T00:00:00.000Z"),
    );

    // The snapshot governs even though the live policy is the default of one.
    const snapshotReceipt = (await (
      await request(appFor(owner), snapshotScanId, "release-receipt.json")
    ).json()) as any;
    expect(snapshotReceipt.content.release.decision.approvals).toEqual({
      required: 2,
      votes: [
        {
          voter: { kind: "drydock_user", id: owner.userId },
          decision: "publish",
          votedAt: "2026-08-05T00:00:00.000Z",
        },
      ],
    });

    // A legacy completed gate has no snapshot and decided under a one-approval
    // bar, so a later policy raise adds nothing to its receipt.
    const legacyOwner = await seedOwner();
    const legacyGateId = await seedGate(legacyOwner);
    const legacyScanId = await seedCompleted(legacyOwner, {
      source: "workflow_gate",
      gateId: legacyGateId,
    });
    await db
      .update(schema.organizations)
      .set({ requiredReleaseApprovals: 3 })
      .where(eq(schema.organizations.id, legacyOwner.organizationId));
    const legacyBytes = await (
      await request(appFor(legacyOwner), legacyScanId, "release-receipt.json")
    ).text();
    expect(legacyBytes).not.toContain('"approvals"');

    // Same for a staged verdict without a vote roster: the raised bar never
    // governed that pre-approval decision, so the receipt must not claim it did.
    const legacyStagedScanId = await seedCompleted(legacyOwner);
    await db
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: legacyOwner.userId,
        decidedAt: new Date("2026-08-05T00:00:00.000Z"),
      })
      .where(eq(schema.scans.id, legacyStagedScanId));
    const legacyStagedBytes = await (
      await request(appFor(legacyOwner), legacyStagedScanId, "release-receipt.json")
    ).text();
    expect(legacyStagedBytes).not.toContain('"approvals"');
  });
});
