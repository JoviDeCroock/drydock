import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { claimScanForRun, createScanJob, getScan } from "../../server/db/scans";
import { PERSIST_CLAIM_DIGEST_PREFIX } from "../../server/lib/scan/artifacts";
import { persistScanWithArtifacts } from "./helpers/persist-scan";
import * as schema from "../../server/db/schema";
import { createPackageDiff } from "../../server/lib/review";
import { scanArtifactPrefix } from "../../server/lib/scan/artifacts/keys";
import { eq } from "drizzle-orm";

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

    const stalePersistPromise = persistScanWithArtifacts(parkedWriterDb, {
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
    });

    // The first completion has prepared its atomic batch but has not committed
    // anything yet. A duplicate delivery can still complete the scan.
    await reachedSignal.promise;
    const duplicate = await persistScanWithArtifacts(readerDb, {
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
    });
    expect(duplicate.persisted).toBe(true);

    gate.resolve();
    const staleResult = await stalePersistPromise;
    expect(staleResult.persisted).toBe(false);

    const finalDetail = await getScan(readerDb, scanId, organizationId, env.ARTIFACTS);
    expect(finalDetail?.scan.status).toBe("complete");
    expect(finalDetail?.scan.reportDigest).toBe(duplicate.reportDigest);
    expect(finalDetail?.findings.map((finding) => finding.ruleId)).toEqual([
      "install-script.implicit-node-gyp",
    ]);
  });
  // Two completion attempts for the same scan both write an artifact set. Before
  // per-run key prefixes they addressed the same four objects, so a loser that
  // wrote R2 after the winner's D1 batch committed left the row pointing at
  // digests that no longer matched the stored bytes — the detail read then failed
  // closed to metadata forever. The interleaving is the plain sequential one: the
  // loser only learns it lost *after* its R2 write.
  test("a stale attempt's artifact write cannot strand the winner's detail read", async () => {
    const { userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = "stage-atomicity-000002";

    const db = createDb(env.DB);
    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);

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
    const seed = (ruleId: string, reason: string) => ({
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
          reason,
          ruleId,
        },
      ],
    });

    const winner = await persistScanWithArtifacts(
      db,
      seed("install-script.implicit-node-gyp", "package builds a native addon on install"),
    );
    expect(winner.persisted).toBe(true);

    // A different ruleId means different report bytes and a different digest, so
    // a shared key would overwrite the winner's report with a mismatching one.
    const loser = await persistScanWithArtifacts(
      db,
      seed("stale.finding", "stale completion should not survive"),
    );
    expect(loser).toMatchObject({ persisted: false, reason: "already_terminal" });

    const detail = await getScan(db, scanId, organizationId, env.ARTIFACTS);
    expect(detail?.scan.reportDigest).toBe(winner.reportDigest);
    expect(detail?.findings.map((finding) => finding.ruleId)).toEqual([
      "install-script.implicit-node-gyp",
    ]);

    // Each attempt owns its own prefix, so both manifests coexist and neither is
    // addressable by the other.
    expect(loser.artifacts.artifactRunPrefix).not.toBe(winner.artifacts.artifactRunPrefix);
    const stored = await env.ARTIFACTS.list({ prefix: scanArtifactPrefix(organizationId, scanId) });
    expect(stored.objects.filter((object) => object.key.endsWith("/manifest.json"))).toHaveLength(
      2,
    );
  });
  // `persistScan` parks a claim token in `scans.report_digest` for the length of
  // its atomic D1 batch. A reader should never see it — D1 applies a batch as one
  // transaction — but if one ever does, it must degrade as a transient
  // `persist_in_flight`, not as `report_digest_mismatch`. That keeps the mismatch
  // reason an unambiguous corruption signal.
  test("a parked persist claim token degrades as persist_in_flight, not a digest mismatch", async () => {
    const { userId, organizationId } = await seedUserAndOrg();
    const scanId = `scan_${crypto.randomUUID()}`;
    const stageId = "stage-atomicity-000003";

    const db = createDb(env.DB);
    await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId: userId });
    await claimScanForRun(db, scanId, organizationId);
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId,
      organizationId,
      ownerUserId: userId,
      packageJson: { name: "demo", version: "1.0.0" },
      previousPackageJson: null,
      risk: "low",
      status: "complete",
      summary: { ok: true },
      ai: null,
      files: [],
      diff: [],
      findings: [],
    });

    await db
      .update(schema.scans)
      .set({ reportDigest: `${PERSIST_CLAIM_DIGEST_PREFIX}${crypto.randomUUID()}` })
      .where(eq(schema.scans.id, scanId));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const detail = await getScan(db, scanId, organizationId, env.ARTIFACTS);

    expect(detail?.findings).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      "scan.artifacts.fallback_read",
      expect.objectContaining({ reason: "persist_in_flight" }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
