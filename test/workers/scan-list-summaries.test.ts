import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { type ScanOwner, seedCompletedScan } from "./helpers/seed";

function seedDenormalizedScan(owner: ScanOwner) {
  return seedCompletedScan(owner, {
    packageJson: { name: "@org/denormalized", version: "1.2.3" },
    risk: "high",
    summary: {
      diff: [
        { path: "package.json", status: "modified" },
        { path: "README.md", status: "unchanged" },
        { path: "OLD.md", status: "removed" },
      ],
    },
    files: [
      { path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" },
      { path: "README.md", size: 20, sha256: "b", flags: [], textSample: "docs" },
    ],
    diff: [
      { path: "package.json", status: "modified", flags: [] },
      { path: "README.md", status: "unchanged", flags: [] },
      { path: "OLD.md", status: "removed", flags: [] },
    ],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall",
        reason: "install lifecycle hook changed",
      },
    ],
  });
}

const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

async function fetchScans(app: TestApp) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://test.local/api/v1/scans?filter=all", { method: "GET" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("denormalized scan list summaries", () => {
  test("persistScan writes changed_file_count, finding_count, and risk_summary_json", async () => {
    const owner = await seedUser();
    const scanId = await seedDenormalizedScan(owner);
    const db = createDb(env.DB);

    const [row] = await db
      .select({
        changedFileCount: schema.scans.changedFileCount,
        findingCount: schema.scans.findingCount,
        riskSummaryJson: schema.scans.riskSummaryJson,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);

    expect(row?.changedFileCount).toBe(2);
    expect(row?.findingCount).toBe(1);
    expect(row?.riskSummaryJson).toMatchObject({
      artifactRisk: "high",
      releaseFindingCount: expect.any(Number),
      contextFindingCount: expect.any(Number),
      unknownFindingCount: expect.any(Number),
    });
  });

  test("listScans renders counts and risk summary even when the artifacts are gone", async () => {
    const owner = await seedUser();
    const scanId = await seedDenormalizedScan(owner);

    const listed = await env.ARTIFACTS.list();
    await env.ARTIFACTS.delete(listed.objects.map((object) => object.key));

    const res = await fetchScans(buildTestApp(mountScans, owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scans: Array<{
        id: string;
        changedFileCount: number;
        findingCount: number;
        riskSummary: { artifactRisk: string } | null;
      }>;
    };
    const row = body.scans.find((scan) => scan.id === scanId);
    expect(row).toBeTruthy();
    expect(row?.changedFileCount).toBe(2);
    expect(row?.findingCount).toBe(1);
    expect(row?.riskSummary?.artifactRisk).toBe("high");
  });
});
