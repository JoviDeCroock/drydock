import { seedLegacyScanJob } from "./helpers/seed-scan-job";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { getPriorApprovedScanFindings } from "../../server/db/release-memory";
import { recordScanDecision } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  computeReleaseConsistency,
  type ReleaseConsistency,
} from "../../server/lib/scan/release-memory";
import { resolveReleaseConsistency } from "../../server/lib/scan/pipeline-phases";
import type { Finding } from "../../server/lib/review";
import { scansRoutes } from "../../server/routes/scans";
import { persistScanWithArtifacts } from "./helpers/persist-scan";
import { buildTestApp, type TestApp } from "./helpers/app";
import { type SeededUser, seedUser } from "./helpers/seed";
import { type ScanOwner, seedCompletedScan } from "./helpers/seed";

async function seedMemoryScan(owner: ScanOwner, options: SeedScanOptions = {}) {
  const packageName = options.packageName ?? "tape";
  const version = options.version ?? "5.7.4";
  const scanId = await seedCompletedScan(owner, {
    packageJson: { name: packageName, version },
    risk: "high",
    summary: { diff: [{ path: "index.js", status: "modified" }], ...options.summaryExtra },
    files: [{ path: "index.js", size: 10, sha256: "a", flags: [], textSample: "x" }],
    diff: [{ path: "index.js", status: "modified", flags: [] }],
    findings: options.findings ?? [spawnFinding("test/spawn.js")],
  });
  if (options.decision) {
    await recordScanDecision(createDb(env.DB), {
      scanId,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      decision: options.decision,
    });
  }
  return { scanId, packageName, version };
}

const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

async function fetchWithSession(app: TestApp, path: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://test.local${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The `tape` shape from prod ops data: a test runner whose suite legitimately
// spawns processes, flagged identically on every release.
const spawnFinding = (file: string, severity: Finding["severity"] = "high"): Finding => ({
  severity,
  file,
  evidence: "spawn('node', [bin])",
  reason: "spawns a child process",
  line: 12,
  ruleId: "code.child-process",
  ruleVersion: "1.0.0",
});

interface SeedScanOptions {
  packageName?: string;
  version?: string;
  findings?: Finding[];
  decision?: "publish" | "no_publish" | null;
  summaryExtra?: Record<string, unknown>;
}

async function setScanCreatedAt(scanId: string, createdAt: Date) {
  const db = createDb(env.DB);
  await db.update(schema.scans).set({ createdAt }).where(eq(schema.scans.id, scanId));
}

function consistencyFor(
  owner: SeededUser,
  packageName: string,
  ruleFindings: Finding[],
): Promise<ReleaseConsistency> {
  return resolveReleaseConsistency({
    db: createDb(env.DB),
    env: env as unknown as Cloudflare.Env,
    identity: {
      scanId: `scan_${crypto.randomUUID()}`,
      stageId: "stage-current",
      organizationId: owner.organizationId,
    },
    packageName,
    ruleFindings,
  });
}

describe("release memory (prior-release consistency)", () => {
  test("matches the prior approved scan for the same org + package", async () => {
    const owner = await seedUser();
    const prior = await seedMemoryScan(owner, {
      findings: [spawnFinding("test/spawn.js"), spawnFinding("bin/tape.js")],
      decision: "publish",
    });

    // Same profile, different line/evidence — those never enter the profile.
    const current = [
      { ...spawnFinding("bin/tape.js"), line: 99, evidence: "spawn('node')" },
      spawnFinding("test/spawn.js"),
    ];
    const out = await consistencyFor(owner, "tape", current);

    expect(out.status).toBe("match");
    expect(out.priorScanId).toBe(prior.scanId);
    expect(out.priorVersion).toBe("5.7.4");
    expect(out.decidedAt).toEqual(expect.any(String));
    expect(out.currentFindingCount).toBe(2);
    expect(out.priorFindingCount).toBe(2);
    expect(out.newFindings).toEqual([]);
  });

  test("does not match another organization's identical package history", async () => {
    const ownerA = await seedUser();
    await seedMemoryScan(ownerA, { decision: "publish" });

    const ownerB = await seedUser();
    const out = await consistencyFor(ownerB, "tape", [spawnFinding("test/spawn.js")]);

    expect(out.status).toBe("none");
    expect(out.priorScanId).toBeNull();
  });

  test("returns none without an approved prior (undecided or no_publish)", async () => {
    const owner = await seedUser();
    await seedMemoryScan(owner, { decision: null });
    await seedMemoryScan(owner, { decision: "no_publish" });

    const out = await consistencyFor(owner, "tape", [spawnFinding("test/spawn.js")]);
    expect(out.status).toBe("none");
  });

  test("diverges with the new findings when the profile grew", async () => {
    const owner = await seedUser();
    await seedMemoryScan(owner, {
      findings: [spawnFinding("test/spawn.js")],
      decision: "publish",
    });

    const out = await consistencyFor(owner, "tape", [
      spawnFinding("test/spawn.js"),
      { ...spawnFinding("lib/exfil.js"), ruleId: "code.network" },
    ]);

    expect(out.status).toBe("diverged");
    expect(out.newFindingCount).toBe(1);
    expect(out.newFindings).toEqual([
      { ruleId: "code.network", severity: "high", file: "lib/exfil.js" },
    ]);
  });

  test("compares against the most recent approved scan", async () => {
    const owner = await seedUser();
    const older = await seedMemoryScan(owner, {
      version: "5.7.3",
      findings: [spawnFinding("test/spawn.js")],
      decision: "publish",
    });
    const newer = await seedMemoryScan(owner, {
      version: "5.7.4",
      findings: [spawnFinding("test/spawn.js"), spawnFinding("bin/tape.js")],
      decision: "publish",
    });
    await setScanCreatedAt(older.scanId, new Date("2026-06-01T00:00:00.000Z"));
    await setScanCreatedAt(newer.scanId, new Date("2026-07-01T00:00:00.000Z"));

    const out = await consistencyFor(owner, "tape", [spawnFinding("test/spawn.js")]);
    expect(out.priorScanId).toBe(newer.scanId);
    expect(out.priorVersion).toBe("5.7.4");
    // One of the two approved findings is gone → strict multiset subset.
    expect(out.status).toBe("subset");
  });

  test("reads the prior profile from the report artifact", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    const ruleFindings = [spawnFinding("test/spawn.js")];
    await seedLegacyScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "tape", version: "5.7.4" },
      risk: "high",
      status: "complete",
      summary: {},
      ai: null,
      files: [{ path: "index.js", size: 10, sha256: "a", flags: [], textSample: "x" }],
      diff: [{ path: "index.js", status: "modified", flags: [] }],
      findings: ruleFindings,
    });
    await recordScanDecision(db, {
      scanId,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      decision: "publish",
    });

    const out = await consistencyFor(owner, "tape", [spawnFinding("test/spawn.js")]);
    expect(out.status).toBe("match");
    expect(out.priorScanId).toBe(scanId);
    expect(out.priorFindingCount).toBe(1);
  });

  test("degrades to none when an artifact-backed prior's report cannot be read", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = `stage-${scanId.slice(-12)}`;
    const ruleFindings = [spawnFinding("test/spawn.js")];
    await seedLegacyScanJob(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageJson: { name: "tape", version: "5.7.4" },
      risk: "high",
      status: "complete",
      summary: {},
      ai: null,
      files: [{ path: "index.js", size: 10, sha256: "a", flags: [], textSample: "x" }],
      diff: [{ path: "index.js", status: "modified", flags: [] }],
      findings: ruleFindings,
    });
    await recordScanDecision(db, {
      scanId,
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      decision: "publish",
    });

    const withoutBucket = await getPriorApprovedScanFindings(db, {
      organizationId: owner.organizationId,
      packageName: "tape",
      excludeScanId: "scan_current",
    });
    expect(withoutBucket).toBeNull();

    const withBucket = await getPriorApprovedScanFindings(
      db,
      {
        organizationId: owner.organizationId,
        packageName: "tape",
        excludeScanId: "scan_current",
      },
      env.ARTIFACTS,
    );
    expect(withBucket?.scanId).toBe(scanId);
    expect(withBucket?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);
  });

  test("db helper is org-scoped and feeds computeReleaseConsistency", async () => {
    const owner = await seedUser();
    const prior = await seedMemoryScan(owner, { decision: "publish" });
    const db = createDb(env.DB);

    const found = await getPriorApprovedScanFindings(
      db,
      {
        organizationId: owner.organizationId,
        packageName: "tape",
        excludeScanId: "scan_current",
      },
      env.ARTIFACTS,
    );
    expect(found?.scanId).toBe(prior.scanId);
    expect(found?.findings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "test/spawn.js" },
    ]);

    // Excluding the prior scan's own id (a re-run of the same scan) hides it.
    const excluded = await getPriorApprovedScanFindings(
      db,
      {
        organizationId: owner.organizationId,
        packageName: "tape",
        excludeScanId: prior.scanId,
      },
      env.ARTIFACTS,
    );
    expect(excluded).toBeNull();

    const out = computeReleaseConsistency([spawnFinding("test/spawn.js")], found);
    expect(out.status).toBe("match");
  });
});

describe("release memory exposure (API + report export)", () => {
  test("the scan detail API returns the persisted summary blob", async () => {
    const owner = await seedUser();
    const releaseConsistency = {
      status: "match",
      priorScanId: "scan_prior",
      priorVersion: "5.7.3",
      decidedAt: "2026-07-01T00:00:00.000Z",
      currentFindingCount: 1,
      priorFindingCount: 1,
      newFindingCount: 0,
      newFindings: [],
    };
    const seeded = await seedMemoryScan(owner, { summaryExtra: { releaseConsistency } });

    const res = await fetchWithSession(
      buildTestApp(mountScans, owner),
      `/api/v1/scans/${seeded.scanId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { summaryJson: Record<string, unknown> } };
    expect(body.scan.summaryJson.releaseConsistency).toEqual(releaseConsistency);
  });

  test("report export exposes releaseConsistency, null for scans that predate it", async () => {
    const owner = await seedUser();
    const releaseConsistency = {
      status: "diverged",
      priorScanId: "scan_prior",
      priorVersion: "5.7.3",
      decidedAt: "2026-07-01T00:00:00.000Z",
      currentFindingCount: 2,
      priorFindingCount: 1,
      newFindingCount: 1,
      newFindings: [{ ruleId: "code.network", severity: "high", file: "lib/exfil.js" }],
    };
    const withField = await seedMemoryScan(owner, { summaryExtra: { releaseConsistency } });
    const withoutField = await seedMemoryScan(owner, { packageName: "other-pkg" });

    const app = buildTestApp(mountScans, owner);
    const res = await fetchWithSession(app, `/api/v1/scans/${withField.scanId}/report.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releaseConsistency: unknown };
    // The export strips priorScanId and decidedAt — both describe a prior scan
    // the org never chose to share, and these bytes are served verbatim on the
    // public share route.
    const {
      priorScanId: _priorScanId,
      decidedAt: _decidedAt,
      ...exportedShape
    } = releaseConsistency;
    expect(body.releaseConsistency).toEqual(exportedShape);

    const legacy = await fetchWithSession(app, `/api/v1/scans/${withoutField.scanId}/report.json`);
    expect(legacy.status).toBe(200);
    const legacyBody = (await legacy.json()) as { releaseConsistency: unknown };
    expect(legacyBody.releaseConsistency).toBeNull();
  });
});
