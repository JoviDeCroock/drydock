import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { IntentEnvelope } from "../../server/lib/intent-envelope";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { type ScanOwner, seedCompletedScan } from "./helpers/seed";

function seedEnvelopeScan(owner: ScanOwner, intentEnvelope: IntentEnvelope | undefined) {
  return seedCompletedScan(owner, {
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
  });
}

const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

async function fetchJson(app: TestApp, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`, { method: "GET" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("scan intent envelope persistence and readers", () => {
  const attestedEnvelope: IntentEnvelope = {
    tier: "attested",
    repository: "https://github.com/owner/repo",
    signals: [{ kind: "workflow-gate", detail: "repo owner/repo, run 123, environment release" }],
  };

  test("the scan detail endpoint returns the persisted envelope in summaryJson", async () => {
    const owner = await seedUser();
    const scanId = await seedEnvelopeScan(owner, attestedEnvelope);

    const res = await fetchJson(buildTestApp(mountScans, owner), `/api/v1/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan: { summaryJson: { intentEnvelope?: unknown } };
    };
    expect(body.scan.summaryJson.intentEnvelope).toEqual(attestedEnvelope);
  });

  test("the report export includes the envelope as an additive field", async () => {
    const owner = await seedUser();
    const scanId = await seedEnvelopeScan(owner, attestedEnvelope);

    const app = buildTestApp(mountScans, owner);
    const res = await fetchJson(app, `/api/v1/scans/${scanId}/report.json`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { schema: string; intentEnvelope: unknown };
    expect(body.schema).toBe("drydock.report.v2");
    expect(body.intentEnvelope).toEqual(attestedEnvelope);

    // Stable serialization still holds with the new field present.
    const again = await fetchJson(app, `/api/v1/scans/${scanId}/report.json`);
    expect(await again.text()).toBe(text);
  });

  test("readers tolerate scans persisted before the envelope existed", async () => {
    const owner = await seedUser();
    const scanId = await seedEnvelopeScan(owner, undefined);
    const app = buildTestApp(mountScans, owner);

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
    const scanId = await seedEnvelopeScan(owner, {
      tier: "verified",
      repository: 42,
      signals: "nope",
    } as unknown as IntentEnvelope);

    const report = await fetchJson(
      buildTestApp(mountScans, owner),
      `/api/v1/scans/${scanId}/report.json`,
    );
    expect(report.status).toBe(200);
    const body = (await report.json()) as { intentEnvelope: unknown };
    expect(body.intentEnvelope).toBeNull();
  });

  test("an evidence-free persisted attested tier exports as null", async () => {
    const owner = await seedUser();
    const scanId = await seedEnvelopeScan(owner, {
      tier: "attested",
    } as unknown as IntentEnvelope);

    const report = await fetchJson(
      buildTestApp(mountScans, owner),
      `/api/v1/scans/${scanId}/report.json`,
    );
    expect(report.status).toBe(200);
    const body = (await report.json()) as { intentEnvelope: unknown };
    expect(body.intentEnvelope).toBeNull();
  });
});
