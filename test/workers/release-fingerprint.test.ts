import { seedLegacyScanJob } from "./helpers/seed-scan-job";
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import type { ScanSource, ScanStatus } from "../../server/db/enums";
import { loadReleaseFingerprintHistory } from "../../server/db/release-fingerprint";
import { claimScanForRun, getScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import type { PackageAdapter } from "../../server/lib/ecosystems/package-adapter";
import { RELEASE_PROCESS_FINDING_FILE } from "../../server/lib/release-fingerprint";
import { runScanPipeline } from "../../server/lib/scan/pipeline";
import { seedUser } from "./helpers/seed";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface SeedScanOptions {
  organizationId: string;
  ownerUserId: string;
  packageName: string;
  createdAt: Date;
  status?: ScanStatus;
  source?: ScanSource;
  gateId?: string | null;
  summaryJson?: unknown;
}

// The summary fields each non-staged path persists and `scanEcosystemSql`
// reads back; staged sources (`manual`, `auto_discovery`) are npm by source.
const gateSummary = (ecosystem: string) => ({ stagedPublish: { provenance: { ecosystem } } });
const publishedPairSummary = (ecosystem: string) => ({
  stagedPublish: { mode: "published_pair", ecosystem },
});

async function seedScan(db: ReturnType<typeof createDb>, options: SeedScanOptions) {
  const id = `scan_${crypto.randomUUID()}`;
  await db.insert(schema.scans).values({
    id,
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId: options.organizationId,
    ownerUserId: options.ownerUserId,
    gateId: options.gateId ?? null,
    packageName: options.packageName,
    risk: "low",
    status: options.status ?? "complete",
    source: options.source ?? "manual",
    summaryJson: options.summaryJson ?? null,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
  return id;
}

async function seedGateChain(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  repositoryFullName: string,
  environment: string,
) {
  const now = new Date();
  const installationRowId = `ghi_${crypto.randomUUID()}`;
  await db.insert(schema.githubAppInstallations).values({
    id: installationRowId,
    organizationId,
    installationId: `${Math.floor(Math.random() * 1_000_000)}`,
    accountLogin: "octo",
    accountType: "Organization",
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const releaseTargetId = `grt_${crypto.randomUUID()}`;
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId,
    installationRowId,
    repositoryId: 12345,
    repositoryFullName,
    environment,
    createdAt: now,
    updatedAt: now,
  });
  const gateId = `gate_${crypto.randomUUID()}`;
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId,
    releaseTargetId,
    deliveryId: `delivery_${crypto.randomUUID()}`,
    repositoryId: 12345,
    repositoryFullName,
    environment,
    runId: 42,
    deploymentCallbackUrl: "https://api.github.com/example/callback",
    eventAction: "requested",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gateId;
}

interface FakeInput {
  packageName: string;
  version: string;
}

// Minimal credential-free adapter: the release-fingerprint rules only need the
// staged manifest identity, so the artifact is a single synthetic package.json.
// Its id stands in for npm's: the pipeline scopes history by adapter id.
const fakeAdapter: PackageAdapter<FakeInput> = {
  id: "npm",
  codePatternSet: "javascript",
  parseInput(raw) {
    const input = raw as Partial<FakeInput>;
    return { packageName: input.packageName ?? "pkg", version: input.version ?? "1.0.0" };
  },
  createBroker() {
    return { dispose() {} };
  },
  async acquireStaged(_ctx, input) {
    return {
      artifact: {
        files: [
          {
            path: "package.json",
            size: 64,
            sha256: "aa".repeat(32),
            flags: [],
            textSample: JSON.stringify({ name: input.packageName, version: input.version }),
          },
        ],
        manifest: { name: input.packageName, version: input.version },
      },
      details: null,
    };
  },
  async acquireBaseline() {
    return {
      artifact: null,
      baseline: {
        version: null,
        tag: null,
        source: "none",
        distTagVersion: null,
        reason: "no published baseline",
      },
    };
  },
  runFindings() {
    return [];
  },
  describe({ input }) {
    return {
      name: input.packageName,
      stagedVersion: input.version,
      stagedTag: null,
      previousVersion: null,
    };
  },
  summarizeDetails() {
    return null;
  },
};

async function runFakeScan(args: {
  db: ReturnType<typeof createDb>;
  organizationId: string;
  userId: string;
  packageName: string;
  ecosystem?: string;
  source?: ScanSource;
  gateId?: string;
}) {
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${crypto.randomUUID()}`;
  await seedLegacyScanJob(args.db, {
    id: scanId,
    stageId,
    organizationId: args.organizationId,
    ownerUserId: args.userId,
    source: args.source,
    gateId: args.gateId,
  });
  await claimScanForRun(args.db, scanId, args.organizationId);
  const result = await runScanPipeline(
    {
      env: env as unknown as Cloudflare.Env,
      executionCtx: createExecutionContext(),
      db: args.db,
      session: { userId: args.userId },
    },
    { ...fakeAdapter, id: args.ecosystem ?? fakeAdapter.id },
    {
      scanId,
      stageId,
      organizationId: args.organizationId,
      packageName: args.packageName,
      version: "2.0.0",
    },
  );
  return { scanId, result };
}

describe("release-process fingerprint (workers)", () => {
  test("a monorepo release train emits no release-process findings", async () => {
    // Regression guard for the removed `release.burst-anomaly` rule: staging
    // many distinct packages inside one window is a normal release train, and
    // must never raise release risk (which would reject a workflow gate).
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    for (let index = 0; index < 8; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: `train-pkg-${index}`,
        status: "running",
        createdAt: new Date(now.getTime() - (index + 1) * MINUTE_MS),
      });
    }

    const { result } = await runFakeScan({
      db,
      organizationId,
      userId,
      packageName: "train-pkg-current",
    });

    expect(result.ruleFindings.filter((finding) => finding.ruleId?.startsWith("release."))).toEqual(
      [],
    );
    expect(result.risk).toBe("low");
    expect(result.riskSummary.releaseRisk).toBe("low");
  });

  test("gate-to-manual source drift fires high with the gate repo/env from the join", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(db, organizationId, "octo/release-repo", "release");
    for (let index = 0; index < 3; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "gated-pkg",
        source: "workflow_gate",
        gateId,
        summaryJson: gateSummary("npm"),
        createdAt: new Date(now.getTime() - (index + 1) * DAY_MS),
      });
    }

    const { scanId, result } = await runFakeScan({
      db,
      organizationId,
      userId,
      packageName: "gated-pkg",
    });

    const finding = result.ruleFindings.find((item) => item.ruleId === "release.source-drift");
    expect(finding).toMatchObject({ severity: "high", file: RELEASE_PROCESS_FINDING_FILE });
    expect(finding?.evidence).toContain("octo/release-repo");
    expect(finding?.evidence).toContain("release");
    expect(result.risk).toBe("high");
    expect(result.riskSummary.releaseRisk).toBe("high");

    const persisted = await getScan(db, scanId, organizationId, env.ARTIFACTS);
    expect(
      persisted?.findings.find((item) => item.ruleId === "release.source-drift"),
    ).toMatchObject({ releaseDelta: true });
  });

  test("mixed release-path history stays silent", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(db, organizationId, "octo/release-repo", "release");
    for (let index = 0; index < 2; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "mixed-pkg",
        source: "workflow_gate",
        gateId,
        summaryJson: gateSummary("npm"),
        createdAt: new Date(now.getTime() - (index + 1) * DAY_MS),
      });
    }
    await seedScan(db, {
      organizationId,
      ownerUserId: userId,
      packageName: "mixed-pkg",
      source: "manual",
      createdAt: new Date(now.getTime() - 3 * DAY_MS),
    });

    const { result } = await runFakeScan({
      db,
      organizationId,
      userId,
      packageName: "mixed-pkg",
    });

    expect(result.ruleFindings.filter((finding) => finding.ruleId?.startsWith("release."))).toEqual(
      [],
    );
  });

  test("history helper scopes every query to the organization", async () => {
    const orgA = await seedUser();
    const orgB = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(orgB.db, orgB.organizationId, "octo/other", "release");
    await seedScan(orgB.db, {
      organizationId: orgB.organizationId,
      ownerUserId: orgB.userId,
      packageName: "shared-name",
      source: "workflow_gate",
      gateId,
      summaryJson: gateSummary("npm"),
      createdAt: new Date(now.getTime() - DAY_MS),
    });

    const history = await loadReleaseFingerprintHistory(orgA.db, {
      organizationId: orgA.organizationId,
      scanId: "scan_missing",
      packageName: "shared-name",
      ecosystem: "npm",
    });
    expect(history.packageHistory).toEqual([]);
    expect(history.currentScan).toBeNull();
  });

  test("a same-name PyPI gate history does not make an npm staged release drift", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(db, organizationId, "acme/sdk-py", "pypi");
    for (let index = 0; index < 3; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "acme-sdk",
        source: "workflow_gate",
        gateId,
        summaryJson: gateSummary("pypi"),
        createdAt: new Date(now.getTime() - (index + 1) * DAY_MS),
      });
    }

    const { result } = await runFakeScan({ db, organizationId, userId, packageName: "acme-sdk" });

    expect(result.ruleFindings.filter((finding) => finding.ruleId?.startsWith("release."))).toEqual(
      [],
    );
    expect(result.riskSummary.releaseRisk).toBe("low");
  });

  test("a same-name npm staged history does not make a PyPI gate release drift", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    for (let index = 0; index < 3; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "acme-sdk",
        source: "manual",
        createdAt: new Date(now.getTime() - (index + 1) * DAY_MS),
      });
    }
    const gateId = await seedGateChain(db, organizationId, "acme/sdk-py", "pypi");

    const { result } = await runFakeScan({
      db,
      organizationId,
      userId,
      packageName: "acme-sdk",
      ecosystem: "pypi",
      source: "workflow_gate",
      gateId,
    });

    expect(result.ruleFindings.filter((finding) => finding.ruleId?.startsWith("release."))).toEqual(
      [],
    );
  });

  test("interleaved PyPI releases do not mask npm gate-to-staged drift", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const npmGateId = await seedGateChain(db, organizationId, "acme/sdk-js", "npm");
    for (let index = 0; index < 3; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "acme-sdk",
        source: "workflow_gate",
        gateId: npmGateId,
        summaryJson: gateSummary("npm"),
        createdAt: new Date(now.getTime() - (2 * index + 1) * DAY_MS),
      });
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "acme-sdk",
        source: "published",
        summaryJson: publishedPairSummary("pypi"),
        createdAt: new Date(now.getTime() - (2 * index + 2) * DAY_MS),
      });
    }

    const { result } = await runFakeScan({ db, organizationId, userId, packageName: "acme-sdk" });

    const finding = result.ruleFindings.find((item) => item.ruleId === "release.source-drift");
    expect(finding).toMatchObject({ severity: "high", file: RELEASE_PROCESS_FINDING_FILE });
    expect(finding?.evidence).toContain("all 3 prior completed scans");
    expect(finding?.evidence).toContain("acme/sdk-js");
  });

  test("completed gate rows without a recorded ecosystem never count as history", async () => {
    // Legacy gate summaries that predate the provenance snapshot cannot say
    // which registry they reviewed; `scanEcosystemSql` reads them as null.
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(db, organizationId, "octo/release-repo", "release");
    for (let index = 0; index < 3; index += 1) {
      await seedScan(db, {
        organizationId,
        ownerUserId: userId,
        packageName: "legacy-pkg",
        source: "workflow_gate",
        gateId,
        createdAt: new Date(now.getTime() - (index + 1) * DAY_MS),
      });
    }

    const { result } = await runFakeScan({ db, organizationId, userId, packageName: "legacy-pkg" });

    expect(result.ruleFindings.filter((finding) => finding.ruleId?.startsWith("release."))).toEqual(
      [],
    );
  });

  test("history helper keeps only the requested ecosystem across every scan source", async () => {
    const { db, userId, organizationId } = await seedUser();
    const now = new Date();
    const gateId = await seedGateChain(db, organizationId, "acme/sdk", "release");
    const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const base = { organizationId, ownerUserId: userId, packageName: "acme-sdk" };
    const npmManual = await seedScan(db, { ...base, source: "manual", createdAt: at(1) });
    const npmDiscovery = await seedScan(db, {
      ...base,
      source: "auto_discovery",
      createdAt: at(2),
    });
    const npmGate = await seedScan(db, {
      ...base,
      source: "workflow_gate",
      gateId,
      summaryJson: gateSummary("npm"),
      createdAt: at(3),
    });
    const npmPublished = await seedScan(db, {
      ...base,
      source: "published",
      summaryJson: publishedPairSummary("npm"),
      createdAt: at(4),
    });
    const pypiGate = await seedScan(db, {
      ...base,
      source: "workflow_gate",
      gateId,
      summaryJson: gateSummary("pypi"),
      createdAt: at(5),
    });
    const pypiPublished = await seedScan(db, {
      ...base,
      source: "published",
      summaryJson: publishedPairSummary("pypi"),
      createdAt: at(6),
    });
    const vscodeGate = await seedScan(db, {
      ...base,
      source: "workflow_gate",
      gateId,
      summaryJson: gateSummary("vscode"),
      createdAt: at(7),
    });
    await seedScan(db, { ...base, source: "workflow_gate", gateId, createdAt: at(8) });
    await seedScan(db, {
      ...base,
      source: "published",
      summaryJson: { stagedPublish: { mode: "published_pair" } },
      createdAt: at(9),
    });

    const historyIds = async (ecosystem: string) =>
      (
        await loadReleaseFingerprintHistory(db, {
          organizationId,
          scanId: "scan_current",
          packageName: "acme-sdk",
          ecosystem,
        })
      ).packageHistory.map((row) => row.id);

    expect(await historyIds("npm")).toEqual([npmManual, npmDiscovery, npmGate, npmPublished]);
    expect(await historyIds("pypi")).toEqual([pypiGate, pypiPublished]);
    expect(await historyIds("vscode")).toEqual([vscodeGate]);
  });
});
