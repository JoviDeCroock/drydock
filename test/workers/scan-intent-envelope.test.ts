import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import type { IntentEnvelope } from "../../server/lib/intent-envelope";
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

async function fetchJson(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`, { method: "GET" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(
  owner: SeededUser,
  intentEnvelope: IntentEnvelope | undefined,
): Promise<string> {
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
      report: {
        version: 1,
        digest: "abc123",
        digestAlgorithm: "sha256",
        generatedAt: "2026-01-01T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      diff: [{ path: "package.json", status: "modified" }],
      // Scans persisted before the envelope existed simply omit the key.
      ...(intentEnvelope ? { intentEnvelope } : {}),
    },
    ai: null,
    files: [{ path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" }],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [],
    report: { version: 1, digest: "abc123" },
  });
  return scanId;
}

describe("scan intent envelope persistence and readers", () => {
  const attestedEnvelope: IntentEnvelope = {
    tier: "attested",
    repository: "https://github.com/owner/repo",
    signals: [{ kind: "workflow-gate", detail: "repo owner/repo, run 123, environment release" }],
  };

  test("the scan detail endpoint returns the persisted envelope in summaryJson", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, attestedEnvelope);

    const res = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan: { summaryJson: { intentEnvelope?: unknown } };
    };
    expect(body.scan.summaryJson.intentEnvelope).toEqual(attestedEnvelope);
  });

  test("the report export includes the envelope as an additive field", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, attestedEnvelope);

    const app = buildTestApp(owner);
    const res = await fetchJson(app, `/api/v1/scans/${scanId}/report.json`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { schema: string; intentEnvelope: unknown };
    expect(body.schema).toBe("drydock.report.v3");
    expect(body.intentEnvelope).toEqual(attestedEnvelope);

    // Stable serialization still holds with the new field present.
    const again = await fetchJson(app, `/api/v1/scans/${scanId}/report.json`);
    expect(await again.text()).toBe(text);
  });

  test("readers tolerate scans persisted before the envelope existed", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, undefined);
    const app = buildTestApp(owner);

    const detail = await fetchJson(app, `/api/v1/scans/${scanId}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      scan: { summaryJson: { intentEnvelope?: unknown } };
    };
    expect(detailBody.scan.summaryJson.intentEnvelope).toBeUndefined();

    const report = await fetchJson(app, `/api/v1/scans/${scanId}/report.json`);
    expect(report.status).toBe(200);
    const reportBody = (await report.json()) as { intentEnvelope: unknown };
    expect(reportBody.intentEnvelope).toBeNull();
  });

  test("a malformed persisted envelope exports as null instead of partial data", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, {
      tier: "verified",
      repository: 42,
      signals: "nope",
    } as unknown as IntentEnvelope);

    const report = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}/report.json`);
    expect(report.status).toBe(200);
    const body = (await report.json()) as { intentEnvelope: unknown };
    expect(body.intentEnvelope).toBeNull();
  });

  test("an evidence-free persisted attested tier exports as null", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, {
      tier: "attested",
    } as unknown as IntentEnvelope);

    const report = await fetchJson(buildTestApp(owner), `/api/v1/scans/${scanId}/report.json`);
    expect(report.status).toBe(200);
    const body = (await report.json()) as { intentEnvelope: unknown };
    expect(body.intentEnvelope).toBeNull();
  });
});
