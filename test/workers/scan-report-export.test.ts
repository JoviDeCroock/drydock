import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { createOrganization, ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
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
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function getReport(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  scanId: string,
  options: { organizationId?: string } = {},
) {
  const ctx = createExecutionContext();
  const query = options.organizationId
    ? `?organizationId=${encodeURIComponent(options.organizationId)}`
    : "";
  const res = await app.fetch(
    new Request(`http://test.local/api/v1/scans/${scanId}/report.json${query}`, { method: "GET" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser): Promise<string> {
  return seedCompletedScanWithAi(owner, null);
}

async function seedCompletedScanWithAi(owner: SeededUser, ai: unknown): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@org/pkg", version: "1.1.0" },
    risk: "high",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: "abc123",
        digestAlgorithm: "sha256",
        generatedAt: "2026-01-01T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      baseline: { kind: "registry", version: "1.0.0" },
      safety: { outboundPolicy: "gateway-only" },
      packageJsonDiff: {
        name: "@org/pkg",
        previousVersion: "1.0.0",
        stagedVersion: "1.1.0",
        scripts: [{ key: "postinstall", status: "added", staged: "node install.js" }],
        dependencies: [],
        entrypointsChanged: false,
      },
      diff: [{ path: "package.json", status: "modified" }],
      stagedPublish: {
        tarballIntegrity: {
          algorithm: "sha1",
          status: "unverified",
          declared: "a".repeat(40),
          computed: null,
          reason: "computed-digest-unavailable",
        },
      },
    },
    ai,
    files: [{ path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" }],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall: node install.js",
        reason: "install lifecycle hooks execute on consumer machines",
        ruleId: "install-script.lifecycle",
        ruleVersion: "1.8.0",
      },
    ],
    report: { version: 1, digest: "abc123" },
  });
  return scanId;
}

describe("scan report JSON export", () => {
  test("exports a canonical, downloadable report for a completed scan", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="drydock-@org-pkg-1.1.0.json"`,
    );

    const text = await res.text();
    const body = JSON.parse(text) as {
      schema: string;
      report: { digest: string; rulesVersion: string } | null;
      scan: { id: string; status: string };
      package: { name: string | null; stagedVersion: string | null };
      packageJsonDiff: unknown;
      tarballIntegrity: {
        algorithm: string;
        status: string;
        declared: string | null;
        computed: string | null;
        reason?: string;
      } | null;
      aiReview: unknown;
      findings: Array<{ ruleId: string | null; severity: string }>;
    };
    expect(body.schema).toBe("drydock.report.v1");
    expect(body.report?.digest).toBe("abc123");
    expect(body.report?.rulesVersion).toBe("1.8.0");
    expect(body.scan.id).toBe(scanId);
    expect(body.package.name).toBe("@org/pkg");
    expect(body.package.stagedVersion).toBe("1.1.0");
    expect(body.packageJsonDiff).toBeTruthy();
    expect(body.tarballIntegrity).toEqual({
      algorithm: "sha1",
      status: "unverified",
      declared: "a".repeat(40),
      computed: null,
      reason: "computed-digest-unavailable",
    });
    expect(body.aiReview).toBeNull();
    expect(body.findings).toEqual([
      expect.objectContaining({ ruleId: "install-script.lifecycle", severity: "high" }),
    ]);

    // Stable serialization: a re-export of the same evidence is byte-identical.
    const again = await getReport(buildTestApp(owner), scanId);
    expect(await again.text()).toBe(text);
  });

  test("surfaces reviewed-artifact provenance digests for a gate review", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    const provenance = {
      ecosystem: "pypi",
      mode: "workflow_gate",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", kind: "wheel", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", kind: "sdist", sha256: "b".repeat(64) },
      ],
    };
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "demo-package", version: "1.2.0" },
      risk: "low",
      status: "complete",
      summary: {
        report: {
          version: 1,
          digest: "abc123",
          digestAlgorithm: "sha256",
          generatedAt: "2026-01-01T00:00:00.000Z",
          rulesVersion: "1.8.0",
        },
        // The whole adapter snapshot is persisted here; only `provenance` is
        // promoted to a first-class export field, the rest stays opaque.
        stagedPublish: { provenance, manifest: { package: "demo-package" } },
      },
      ai: null,
      files: [],
      diff: [],
      findings: [],
      report: { version: 1, digest: "abc123" },
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provenance: typeof provenance | null };
    expect(body.provenance).toEqual(provenance);
  });

  test("exports a complete AI review with evidence and recommendations", async () => {
    const owner = await seedUser();
    const aiReview = {
      status: "complete",
      risk: "high",
      releaseAssessment: "suspicious",
      summary: "The release adds install-time execution and network access.",
      findings: [
        {
          severity: "critical",
          file: "package.json",
          evidence: "postinstall runs node install.js",
          reason: "consumer installs execute arbitrary code",
          recommendation: "remove the install hook or gate it behind a manual step",
        },
      ],
      requiresManualReview: true,
      model: "ai-review-1",
    } as const;

    const scanId = await seedCompletedScanWithAi(owner, aiReview);
    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      aiReview: {
        status: string;
        model: string | null;
        summary: string;
        risk: string | null;
        releaseAssessment: string | null;
        requiresManualReview: boolean;
        findings: Array<{
          severity: string;
          file: string;
          evidence: string;
          reason: string;
          recommendation: string;
        }>;
      } | null;
    };

    expect(body.aiReview).toEqual({
      status: "complete",
      model: "ai-review-1",
      summary: "The release adds install-time execution and network access.",
      risk: "high",
      releaseAssessment: "suspicious",
      requiresManualReview: true,
      findings: [
        {
          severity: "critical",
          file: "package.json",
          evidence: "postinstall runs node install.js",
          reason: "consumer installs execute arbitrary code",
          recommendation: "remove the install hook or gate it behind a manual step",
        },
      ],
    });

    // Stable serialization: a re-export of the same evidence is byte-identical.
    const again = await getReport(buildTestApp(owner), scanId);
    expect(await again.text()).toBe(text);
  });

  test("exports unavailable AI reviews without surfacing fallback low risk", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScanWithAi(owner, {
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review was unavailable.",
      findings: [],
      requiresManualReview: false,
      model: null,
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as {
      aiReview: {
        status: string;
        model: string | null;
        summary: string;
        risk: string | null;
        releaseAssessment: string | null;
        requiresManualReview: boolean;
        findings: unknown[];
      } | null;
    };

    expect(body.aiReview).toEqual({
      status: "unavailable",
      model: null,
      summary: "AI review was unavailable.",
      risk: null,
      releaseAssessment: null,
      requiresManualReview: false,
      findings: [],
    });
  });

  test("surfaces the reviewed VSIX digest for a VS Code gate review", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    const provenance = {
      ecosystem: "vscode",
      mode: "workflow_gate",
      artifacts: [
        { path: "dist/remote-text-fetcher-1.0.0.vsix", kind: "vsix", sha256: "c".repeat(64) },
      ],
    };
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "example.remote-text-fetcher", version: "1.0.0" },
      risk: "low",
      status: "complete",
      summary: {
        report: {
          version: 1,
          digest: "abc123",
          digestAlgorithm: "sha256",
          generatedAt: "2026-01-01T00:00:00.000Z",
          rulesVersion: "1.8.0",
        },
        stagedPublish: { provenance, manifest: { package: "example.remote-text-fetcher" } },
      },
      ai: null,
      files: [],
      diff: [],
      findings: [],
      report: { version: 1, digest: "abc123" },
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provenance: typeof provenance | null };
    expect(body.provenance).toEqual(provenance);
  });

  test("omits provenance when any artifact entry is malformed", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "demo-package", version: "1.2.0" },
      risk: "low",
      status: "complete",
      summary: {
        stagedPublish: {
          provenance: {
            ecosystem: "pypi",
            mode: "workflow_gate",
            artifacts: [
              {
                path: "dist/demo_package-1.2.0-py3-none-any.whl",
                kind: "wheel",
                sha256: "a".repeat(64),
              },
              { path: "dist/demo_package-1.2.0.tar.gz", kind: "sdist" },
            ],
          },
        },
      },
      ai: null,
      files: [],
      diff: [],
      findings: [],
      report: { version: 1, digest: "abc123" },
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provenance: unknown };
    expect(body.provenance).toBeNull();
  });

  test("omits an internally inconsistent staged-tarball verdict", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    await createScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await persistScan(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "@org/pkg", version: "1.1.0" },
      risk: "low",
      status: "complete",
      summary: {
        stagedPublish: {
          tarballIntegrity: {
            algorithm: "sha1",
            status: "verified",
            declared: "a".repeat(40),
            computed: "b".repeat(40),
          },
        },
      },
      ai: null,
      files: [],
      diff: [],
      findings: [],
      report: { version: 1, digest: "abc123" },
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tarballIntegrity: unknown };
    expect(body.tarballIntegrity).toBeNull();
  });

  test("omits provenance for a staged-publish scan with no gate details", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const res = await getReport(buildTestApp(owner), scanId);
    const body = (await res.json()) as { provenance: unknown };
    expect(body.provenance).toBeNull();
  });

  test("uses an organization query for native browser downloads", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const organizationId = await createOrganization(db, {
      ownerUserId: owner.userId,
      name: "Team workspace",
    });
    const scanId = await seedCompletedScan({ ...owner, organizationId });

    expect((await getReport(buildTestApp(owner), scanId)).status).toBe(404);

    const res = await getReport(buildTestApp(owner), scanId, { organizationId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      package: { name: "@org/pkg", stagedVersion: "1.1.0" },
    });
  });

  test("does not leak another organization's report", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const outsider = await seedUser();

    const res = await getReport(buildTestApp(outsider), scanId);
    expect(res.status).toBe(404);

    const queried = await getReport(buildTestApp(outsider), scanId, {
      organizationId: owner.organizationId,
    });
    expect(queried.status).toBe(404);
  });

  test("refuses export for a scan that has not completed", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });

    const res = await getReport(buildTestApp(owner), scanId);
    expect(res.status).toBe(409);
  });

  test("returns 404 for an unknown scan id", async () => {
    const owner = await seedUser();
    const res = await getReport(buildTestApp(owner), "scan_does_not_exist");
    expect(res.status).toBe(404);
  });
});
