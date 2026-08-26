import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { claimScanForRun, createScanJob, getScan, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createPackageDiff } from "../../server/lib/review";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Wrap a D1Database so the first atomic D1 batch blocks before it executes.
// This lets a duplicate completion finish first; when the parked batch resumes,
// it must not delete or replace the completed scan's findings.
function gateFirstBatch(d1: D1Database, reached: () => void, gate: Promise<void>): D1Database {
  let parked = false;
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!parked) {
            parked = true;
            reached();
            await gate;
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedUserAndOrg() {
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

describe("scan completion atomicity", () => {
  test("D1 fallback persists more files and findings than Workerd's compound-select limit", async () => {
    const { userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = "stage-compound-select-000001";
    const db = createDb(env.DB);
    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `file-${index}.js`,
      size: 16,
      sha256: `sha-${index}`,
      flags: [],
      textSample: `export const value${index} = ${index};\n`,
    }));
    const findings = files.map((file, index) => ({
      severity: "medium" as const,
      file: file.path,
      evidence: `value${index}`,
      reason: "regression fixture",
      ruleId: `fixture.rule-${index}`,
    }));

    const persisted = await persistScan(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      previousPackageJson: null,
      risk: "medium",
      status: "complete",
      summary: { ok: true },
      ai: null,
      files,
      diff: createPackageDiff([], files),
      findings,
      report: { version: 1, digest: "digest-compound-select" },
    });

    expect(persisted.persisted).toBe(true);
    const detail = await getScan(db, scanId, organizationId);
    expect(detail?.files).toHaveLength(7);
    expect(detail?.findings).toHaveLength(7);
  });

  // A duplicate Queue delivery may finish while an earlier completion attempt
  // is still parked before its D1 batch. The stale batch must not clear or
  // replace the detail rows written by the successful completion.
  test("stale completion batch cannot clobber findings from a duplicate completion", async () => {
    const { userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = "stage-atomicity-000001";

    const readerDb = createDb(env.DB);
    await createScanJob(readerDb, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(readerDb, scanId, organizationId);

    const files = [
      {
        path: "binding.gyp",
        size: 64,
        sha256: "abc",
        flags: [],
        textSample: '{ "targets": [] }\n',
      },
    ];
    const diff = createPackageDiff([], files);

    const reachedSignal = deferred();
    const gate = deferred();
    const parkedWriterDb = createDb(gateFirstBatch(env.DB, reachedSignal.resolve, gate.promise));

    const stalePersistPromise = persistScan(parkedWriterDb, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      previousPackageJson: null,
      risk: "high",
      status: "complete",
      summary: { ok: true },
      ai: null,
      files,
      diff,
      findings: [
        {
          severity: "high",
          file: "binding.gyp",
          evidence: "implicit install: node-gyp rebuild",
          reason: "stale completion should not survive",
          ruleId: "stale.finding",
        },
      ],
      report: { version: 1, digest: "digest-stale" },
    });

    // The first completion has prepared its atomic batch but has not committed
    // anything yet. A duplicate delivery can still complete the scan.
    await reachedSignal.promise;
    const duplicate = await persistScan(readerDb, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      previousPackageJson: null,
      risk: "high",
      status: "complete",
      summary: { ok: true },
      ai: null,
      files,
      diff,
      findings: [
        {
          severity: "high",
          file: "binding.gyp",
          evidence: "implicit install: node-gyp rebuild",
          reason: "package builds a native addon on install",
          ruleId: "install-script.implicit-node-gyp",
        },
      ],
      report: { version: 1, digest: "digest-atomicity" },
    });
    expect(duplicate.persisted).toBe(true);

    gate.resolve();
    const staleResult = await stalePersistPromise;
    expect(staleResult.persisted).toBe(false);

    const finalDetail = await getScan(readerDb, scanId, organizationId);
    expect(finalDetail?.scan.status).toBe("complete");
    expect(finalDetail?.findings.map((finding) => finding.ruleId)).toEqual([
      "install-script.implicit-node-gyp",
    ]);
  });
});
