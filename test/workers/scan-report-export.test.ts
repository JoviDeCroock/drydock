import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDb,
  createOrganization,
  createScanJob,
  ensurePersonalOrganization,
  persistScan,
} from "../../server/db";
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

async function getScanDetail(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  scanId: string,
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://test.local/api/v1/scans/${scanId}`, { method: "GET" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser): Promise<string> {
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
      stagedPublish: {
        manifest: {
          artifacts: [
            {
              path: "dist/demo-1.1.0-py3-none-any.whl",
              kind: "wheel",
              sha256: "a".repeat(64),
            },
            {
              path: "dist/demo-1.1.0.tar.gz",
              kind: "sdist",
              sha256: "b".repeat(64),
            },
          ],
        },
      },
      packageJsonDiff: {
        name: "@org/pkg",
        previousVersion: "1.0.0",
        stagedVersion: "1.1.0",
        scripts: [{ key: "postinstall", status: "added", staged: "node install.js" }],
        dependencies: [],
        entrypointsChanged: false,
      },
      diff: [{ path: "package.json", status: "modified" }],
    },
    ai: null,
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
      provenance: {
        report: { digest: string | null; rulesVersion: string | null };
        package: { name: string | null; stagedVersion: string | null };
        artifacts: Array<{ path: string; kind: string | null; digest: string; source: string }>;
        review: { limitations: string[] };
      };
      packageJsonDiff: unknown;
      findings: Array<{ ruleId: string | null; severity: string }>;
    };
    expect(body.schema).toBe("drydock.report.v1");
    expect(body.report?.digest).toBe("abc123");
    expect(body.report?.rulesVersion).toBe("1.8.0");
    expect(body.scan.id).toBe(scanId);
    expect(body.package.name).toBe("@org/pkg");
    expect(body.package.stagedVersion).toBe("1.1.0");
    expect(body.provenance.report.digest).toBe("abc123");
    expect(body.provenance.report.rulesVersion).toBe("1.8.0");
    expect(body.provenance.package.name).toBe("@org/pkg");
    expect(body.provenance.package.stagedVersion).toBe("1.1.0");
    expect(body.provenance.artifacts).toEqual([
      expect.objectContaining({
        path: "dist/demo-1.1.0-py3-none-any.whl",
        kind: "wheel",
        digest: "a".repeat(64),
        source: "staged_publish",
      }),
      expect.objectContaining({
        path: "dist/demo-1.1.0.tar.gz",
        kind: "sdist",
        digest: "b".repeat(64),
        source: "staged_publish",
      }),
    ]);
    expect(body.provenance.review.limitations.length).toBeGreaterThan(0);
    expect(body.packageJsonDiff).toBeTruthy();
    expect(body.findings).toEqual([
      expect.objectContaining({ ruleId: "install-script.lifecycle", severity: "high" }),
    ]);

    // Stable serialization: a re-export of the same evidence is byte-identical.
    const again = await getReport(buildTestApp(owner), scanId);
    expect(await again.text()).toBe(text);
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

  test("returns normalized provenance on scan detail", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);

    const res = await getScanDetail(buildTestApp(owner), scanId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provenance: {
        report: { digest: string | null; rulesVersion: string | null };
        scan: { id: string; stageId: string | null };
        artifacts: Array<{ digestAlgorithm: string; digest: string }>;
      };
    };
    expect(body.provenance.report.digest).toBe("abc123");
    expect(body.provenance.report.rulesVersion).toBe("1.8.0");
    expect(body.provenance.scan.id).toBe(scanId);
    expect(body.provenance.artifacts.map((artifact) => artifact.digest)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(
      body.provenance.artifacts.every((artifact) => artifact.digestAlgorithm === "sha256"),
    ).toBe(true);
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
