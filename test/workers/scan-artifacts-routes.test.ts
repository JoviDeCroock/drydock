import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  getScan,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import {
  DETERMINISTIC_RULES_VERSION,
  createPackageDiff,
  redactJson,
  summarizePackageJsonDiff,
} from "../../server/lib/review";
import type { ScanRiskBreakdown } from "../../server/lib/risk";
import {
  SCAN_ARTIFACT_WRITE_ATTEMPTS,
  maybeWriteScanArtifacts,
  writeScanArtifacts,
} from "../../server/lib/scan-artifacts";
import { sha256Hex, stableJson } from "../../server/lib/stable-json";
import { parsePackageJson } from "../../server/lib/tar-parser.js";
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
    name: "Artifact Tester",
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

async function fetchJsonWithSession(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  options: RequestInit = {},
) {
  const ctx = createExecutionContext();
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      ...options,
      headers,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const disabledAi = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

const safety = {
  tokenExposedToSandbox: false,
  directSandboxNetwork: false,
  outboundPolicy: "test outbound policy",
  aiInputPolicy: "test AI policy",
  fileExplorerPolicy: "test file policy",
};

function createFlakyArtifactBucket(options: { failFirstPuts?: number; failAllPuts?: boolean }) {
  const objects = new Map<string, string>();
  let putCalls = 0;
  const bucket = {
    async put(key: string, body: string) {
      putCalls += 1;
      if (options.failAllPuts || putCalls <= (options.failFirstPuts ?? 0)) {
        throw new Error("simulated R2 write failure");
      }
      objects.set(key, body);
      return {};
    },
    async get(key: string) {
      const body = objects.get(key);
      if (body === undefined) return null;
      return {
        async arrayBuffer() {
          return new TextEncoder().encode(body).buffer;
        },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, putCalls: () => putCalls };
}

async function buildArtifactWriteInput(owner: SeededUser) {
  const scanId = `scan_${crypto.randomUUID()}`;
  const diff = [
    {
      path: "index.js",
      status: "added" as const,
      stagedSize: 18,
      stagedSha256: "index-sha",
      flags: [],
    },
  ];
  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId: "stage-artifact-write",
    package: {
      name: "@org/artifact-write",
      stagedVersion: "1.0.0",
      stagedTag: "latest",
      previousVersion: null,
    },
    baseline: null,
    fileCount: 1,
    previousFileCount: 0,
    packageJson: null,
    packageJsonDiff: {},
    diff,
    ruleFindings: [],
    findingAnnotations: [],
    aiFindings: disabledAi,
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    },
    safety,
  };
  const reportJson = stableJson(reportPayload);
  return {
    organizationId: owner.organizationId,
    scanId,
    reportJson,
    reportDigest: await sha256Hex(reportJson),
    files: [
      {
        path: "index.js",
        size: 18,
        sha256: "index-sha",
        flags: [],
        textSample: "console.log('ok');\n",
      },
    ],
    diff,
    generatedAt: "2026-06-08T00:00:00.000Z",
  };
}

async function seedDigestMatchedLegacyScan(
  owner: SeededUser,
  options: { artifactBacked?: boolean } = {},
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${crypto.randomUUID().slice(0, 12)}`;
  const packageName = "@org/artifact-backfill";
  const packageText = JSON.stringify({
    name: packageName,
    version: "1.0.0",
    scripts: { postinstall: "node index.js" },
    dependencies: { leftpad: "^1.3.0" },
  });
  const files = [
    {
      path: "package.json",
      size: packageText.length,
      sha256: "pkg-sha",
      flags: [],
      textSample: packageText,
    },
    {
      path: "index.js",
      size: 39,
      sha256: "index-sha",
      flags: [],
      textSample: "console.log(process.env.npm_config_user_agent);\n",
    },
  ];
  const packageJson = redactJson(parsePackageJson(files)!);
  const diff = createPackageDiff([], files);
  const packageJsonDiff = redactJson(summarizePackageJsonDiff(null, packageJson));
  const stagedPublish = {
    id: stageId,
    packageName,
    version: "1.0.0",
    tag: "latest",
    access: "public",
  };
  const baseline = {
    version: null,
    tag: "latest",
    source: "none",
    distTagVersion: null,
    reason: "no previous version",
  };
  const findings = [
    {
      severity: "high" as const,
      file: "index.js",
      line: 1,
      evidence: "environment access",
      reason: "install-time script reads npm environment",
      ruleId: "code.credential-access",
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
  const risk: ScanRiskBreakdown = {
    artifactRisk: "high",
    releaseRisk: "high",
    contextRisk: "low",
    releaseFindingCount: 1,
    contextFindingCount: 0,
    unknownFindingCount: 0,
  };
  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId,
    stagedPublish,
    package: {
      name: packageName,
      stagedVersion: "1.0.0",
      stagedTag: "latest",
      previousVersion: null,
    },
    baseline,
    fileCount: files.length,
    previousFileCount: 0,
    packageJson,
    packageJsonDiff,
    diff,
    ruleFindings: findings,
    findingAnnotations: [{ findingIndex: 0, diffStatus: "added", releaseDelta: true }],
    aiFindings: disabledAi,
    risk,
    safety,
  };
  const reportJson = stableJson(reportPayload);
  const digest = await sha256Hex(reportJson);
  const artifacts = options.artifactBacked
    ? await writeScanArtifacts(env.ARTIFACTS, {
        organizationId: owner.organizationId,
        scanId,
        reportJson,
        reportDigest: digest,
        files,
        diff,
        generatedAt: "2026-06-08T00:00:00.000Z",
      })
    : null;

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
    packageJson,
    risk: "high",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest,
        digestAlgorithm: "sha256",
        generatedAt: "2026-06-08T00:00:00.000Z",
        rulesVersion: DETERMINISTIC_RULES_VERSION,
      },
      packageJsonDiff,
      diff,
      risk,
      stagedPublish,
      baseline,
      safety,
    },
    ai: disabledAi,
    files,
    diff,
    findings,
    riskSummary: risk,
    report: { version: 1, digest },
    artifacts,
  });
  return { db, scanId };
}

describe("scan artifact backfill route", () => {
  test("retries transient artifact write failures before marking a scan backed", async () => {
    const owner = await seedUser();
    const input = await buildArtifactWriteInput(owner);
    const fake = createFlakyArtifactBucket({ failFirstPuts: 2 });

    const metadata = await maybeWriteScanArtifacts(fake.bucket, input);

    expect(metadata?.artifactStorageVersion).toBe(1);
    expect(metadata?.artifactManifestKey).toContain(`/scans/${input.scanId}/v1/manifest.json`);
    expect(fake.putCalls()).toBe(6);
  });

  test("exhausted artifact write failures fall back to D1-backed scans", async () => {
    const owner = await seedUser();
    const input = await buildArtifactWriteInput(owner);
    const fake = createFlakyArtifactBucket({ failAllPuts: true });

    const metadata = await maybeWriteScanArtifacts(fake.bucket, input);

    expect(metadata).toBeNull();
    expect(fake.putCalls()).toBe(SCAN_ARTIFACT_WRITE_ATTEMPTS);
  });

  test("new artifact-backed scans keep D1 file rows compact", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const { db, scanId } = await seedDigestMatchedLegacyScan(owner, { artifactBacked: true });

    const d1Rows = await db
      .select({
        path: schema.scanFiles.path,
        textSample: schema.scanFiles.textSample,
      })
      .from(schema.scanFiles)
      .where(eq(schema.scanFiles.scanId, scanId));
    expect(d1Rows.length).toBeGreaterThan(0);
    expect(d1Rows.every((row) => row.textSample === null)).toBe(true);

    const d1Only = await getScan(db, scanId, owner.organizationId);
    expect(d1Only?.files.find((file) => file.path === "index.js")?.textSample).toBeNull();

    const detailRes = await fetchJsonWithSession(app, `/api/v1/scans/${scanId}`, {
      method: "GET",
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      files: Array<{ path: string; textSample: string | null }>;
    };
    expect(detail.files.find((file) => file.path === "index.js")?.textSample).toContain(
      "npm_config_user_agent",
    );
  });

  test("backfills legacy scan artifacts and detail reads survive D1 sample compaction", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const { db, scanId } = await seedDigestMatchedLegacyScan(owner);

    const res = await fetchJsonWithSession(app, "/api/v1/scans/artifacts/backfill", {
      method: "POST",
      body: JSON.stringify({ limit: 1 }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      scanned: 1,
      backfilled: 1,
      digestMismatch: 0,
      failed: 0,
      nextCursor: null,
    });

    const [scanRow] = await db
      .select({
        artifactStorageVersion: schema.scans.artifactStorageVersion,
        artifactManifestKey: schema.scans.artifactManifestKey,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);
    expect(scanRow?.artifactStorageVersion).toBe(1);
    expect(scanRow?.artifactManifestKey).toContain(`/scans/${scanId}/v1/manifest.json`);

    await db
      .update(schema.scanFiles)
      .set({ textSample: null })
      .where(eq(schema.scanFiles.scanId, scanId));

    const d1Only = await getScan(db, scanId, owner.organizationId);
    expect(d1Only?.files.find((file) => file.path === "index.js")?.textSample).toBeNull();

    const detailRes = await fetchJsonWithSession(app, `/api/v1/scans/${scanId}`, {
      method: "GET",
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      files: Array<{ path: string; textSample: string | null }>;
    };
    expect(detail.files.find((file) => file.path === "index.js")?.textSample).toContain(
      "npm_config_user_agent",
    );

    const second = await fetchJsonWithSession(app, "/api/v1/scans/artifacts/backfill", {
      method: "POST",
      body: JSON.stringify({ limit: 1 }),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ scanned: 0, backfilled: 0 });
  });

  test("skips legacy rows whose reconstructed report digest does not match", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const { db, scanId } = await seedDigestMatchedLegacyScan(owner);
    await db
      .update(schema.scans)
      .set({ reportDigest: "0".repeat(64) })
      .where(eq(schema.scans.id, scanId));

    const res = await fetchJsonWithSession(app, "/api/v1/scans/artifacts/backfill", {
      method: "POST",
      body: JSON.stringify({ limit: 1 }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      scanned: 1,
      backfilled: 0,
      digestMismatch: 1,
      failed: 0,
    });

    const [scanRow] = await db
      .select({ artifactStorageVersion: schema.scans.artifactStorageVersion })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);
    expect(scanRow?.artifactStorageVersion).toBeNull();
  });
});
