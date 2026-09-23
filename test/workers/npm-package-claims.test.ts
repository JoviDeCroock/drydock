import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers/app";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  deleteNpmConnection,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { deleteOrganization, ensurePersonalOrganization } from "../../server/db/organizations";
import { PackageClaimConflictError } from "../../server/db/package-claims";
import {
  createScanJob,
  deleteFailedScan,
  deletePendingScanJob,
  discardScanAttempt,
  markScanFailed,
} from "../../server/db/scan-jobs";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import { scansRoutes } from "../../server/routes/scans";
import { stagedPublishesRoutes } from "../../server/routes/staged-publishes";
import type { Bindings } from "../../server/types";

const REGISTRY = "https://registry.npmjs.org";
const db = createDb(env.DB);

async function owner() {
  const userId = crypto.randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    name: "Maintainer",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const organizationId = (await ensurePersonalOrganization(db, { userId }))!;
  return { userId, organizationId };
}

type Owner = Awaited<ReturnType<typeof owner>>;

function scanInput(org: Owner, packageName: string) {
  return {
    id: crypto.randomUUID(),
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId: org.organizationId,
    ownerUserId: org.userId,
    registryUrl: REGISTRY,
    packageName,
    stagedVersion: "1.0.0",
    stageAccessStatus: 206,
  };
}

async function connection(org: Owner) {
  await upsertNpmConnection(db, {
    organizationId: org.organizationId,
    createdByUserId: org.userId,
    registryUrl: REGISTRY,
    label: "npm",
    ...(await encryptNpmToken(env, "npm_claim_test_token")),
  });
  await updateNpmConnectionValidation(db, {
    organizationId: org.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
}

function app(org: Owner) {
  return buildTestApp((result) => {
    result.route("/api/v1/scans", scansRoutes);
    result.route("/api/v1/staged-publishes", stagedPublishesRoutes);
  }, org);
}

async function request(org: Owner, path: string, stageId?: string) {
  const queue = { send: vi.fn(async () => undefined) };
  const ctx = createExecutionContext();
  const response = await app(org).fetch(
    new Request(`https://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId }),
    }),
    { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, queue };
}

afterEach(() => vi.unstubAllGlobals());

describe("npm package claim admission", () => {
  test.each(["failed", "pending", "discard", "organization"] as const)(
    "%s deletion preserves reservations for authoritative and unknown legacy registries",
    async (deletion) => {
      const [a, b] = await Promise.all([owner(), owner()]);
      for (const legacy of [false, true]) {
        const input = scanInput(a, `deleted-${crypto.randomUUID()}`);
        await db.insert(schema.scans).values({
          id: input.id,
          stageId: input.stageId,
          organizationId: a.organizationId,
          ownerUserId: a.userId,
          packageName: input.packageName,
          registryPackageName: legacy ? null : input.packageName,
          registryUrl: legacy ? null : `${REGISTRY}/`,
          source: "manual",
          status: deletion === "pending" ? "pending" : "failed",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await expect(createScanJob(db, scanInput(b, input.packageName))).rejects.toBeInstanceOf(
          PackageClaimConflictError,
        );
        if (deletion === "failed") await deleteFailedScan(db, input.id, a.organizationId);
        else if (deletion === "pending") await deletePendingScanJob(db, input.id, a.organizationId);
        else if (deletion === "discard") await discardScanAttempt(db, input.id, a.organizationId);
        else await deleteOrganization(db, a.organizationId);
        expect(
          await db.select().from(schema.scans).where(eq(schema.scans.id, input.id)),
        ).toHaveLength(0);
        const [reservation] = await db
          .select()
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.packageName, input.packageName));
        expect(reservation).toMatchObject({
          registryUrl: legacy ? "*" : REGISTRY,
          organizationId: null,
          firstStageId: input.stageId,
        });
        await expect(createScanJob(db, scanInput(b, input.packageName))).rejects.toBeInstanceOf(
          PackageClaimConflictError,
        );
        if (deletion === "organization" && !legacy) {
          await ensurePersonalOrganization(db, { userId: a.userId });
        }
      }
    },
  );
  test("concurrent first scans from different orgs admit one canonical owner", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const name = `race-${crypto.randomUUID()}`;
    const attempts = [scanInput(a, name), scanInput(b, name)];
    attempts[1].registryUrl = `${REGISTRY}/`;
    const result = await Promise.allSettled(attempts.map((input) => createScanJob(db, input)));
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(result.find((entry) => entry.status === "rejected")).toMatchObject({
      reason: expect.any(PackageClaimConflictError),
    });
    const [claim] = await db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, name));
    const admitted = await db
      .select()
      .from(schema.scans)
      .where(eq(schema.scans.registryPackageName, name));
    expect(admitted).toHaveLength(1);
    expect(claim).toMatchObject({
      registryUrl: REGISTRY,
      organizationId: admitted[0].organizationId,
      firstStageId: admitted[0].stageId,
    });
  });

  test("same owner supersedes a stage; another org cannot mutate that history", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const first = scanInput(a, `supersession-${crypto.randomUUID()}`);
    await createScanJob(db, first);
    await expect(createScanJob(db, scanInput(b, first.packageName))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
    const readFirst = async () =>
      (await db.select().from(schema.scans).where(eq(schema.scans.id, first.id)))[0];
    expect((await readFirst()).registryStatusSupersededAt).toBeNull();
    await createScanJob(db, scanInput(a, first.packageName));
    expect((await readFirst()).registryStatusSupersededAt).toBeInstanceOf(Date);
    const [claim] = await db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, first.packageName));
    expect(claim.firstStageId).toBe(first.stageId);
  });

  test("failed scan and token removal retain claim; org deletion leaves a tombstone", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    await connection(a);
    const input = scanInput(a, `durable-${crypto.randomUUID()}`);
    await createScanJob(db, input);
    await markScanFailed(db, input.id, a.organizationId, { message: "failed" });
    await deleteFailedScan(db, input.id, a.organizationId);
    await deleteNpmConnection(db, a.organizationId);
    await expect(createScanJob(db, scanInput(b, input.packageName))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
    await deleteOrganization(db, a.organizationId);
    expect(
      (
        await db
          .select()
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.packageName, input.packageName))
      )[0].organizationId,
    ).toBeNull();
    await expect(createScanJob(db, scanInput(b, input.packageName))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
  });

  test.each([false, true])(
    "historical identity stays pending audit (legacy=%s)",
    async (legacy) => {
      const a = await owner();
      const input = scanInput(a, `historical-${crypto.randomUUID()}`);
      await db.insert(schema.scans).values({
        id: crypto.randomUUID(),
        stageId: `stage-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        ownerUserId: a.userId,
        packageName: input.packageName,
        registryUrl: legacy ? null : REGISTRY,
        registryPackageName: legacy ? null : input.packageName,
        source: "manual",
        status: "complete",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(createScanJob(db, input)).rejects.toBeInstanceOf(PackageClaimConflictError);
      expect(
        await db
          .select()
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.packageName, input.packageName)),
      ).toHaveLength(0);
      await db.insert(schema.npmPackageClaims).values({
        registryUrl: REGISTRY,
        ecosystem: "npm",
        packageName: input.packageName,
        organizationId: a.organizationId,
        firstStageId: "audited-historical-stage",
        claimedAt: new Date(),
      });
      expect(await createScanJob(db, input)).not.toBeNull();
    },
  );

  test("failed atomic scan insert rolls back the proposed claim", async () => {
    const a = await owner();
    const first = scanInput(a, `existing-${crypto.randomUUID()}`);
    await createScanJob(db, first);
    const conflict = { ...scanInput(a, `rollback-${crypto.randomUUID()}`), id: first.id };
    await expect(createScanJob(db, conflict)).rejects.toThrow();
    expect(
      await db
        .select()
        .from(schema.npmPackageClaims)
        .where(eq(schema.npmPackageClaims.packageName, conflict.packageName)),
    ).toHaveLength(0);
  });

  test("published and workflow-gate scans cannot claim names", async () => {
    const a = await owner();
    for (const source of ["published", "workflow_gate"] as const) {
      const input = { ...scanInput(a, `untrusted-${crypto.randomUUID()}`), source };
      await createScanJob(db, input);
      expect(
        await db
          .select()
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.packageName, input.packageName)),
      ).toHaveLength(0);
    }
  });

  test("manual cross-org conflict is generic and queues nothing; discovery skips it", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    await connection(b);
    const input = scanInput(a, `routes-${crypto.randomUUID()}`);
    await createScanJob(db, input);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/tarball")) return new Response("", { status: 206 });
        const stage = {
          id: input.stageId,
          packageName: input.packageName,
          version: "1.0.0",
          access: "public",
        };
        return Response.json(
          String(url).includes("?perPage") ? { items: [stage], total: 1 } : stage,
        );
      }),
    );
    const manual = await request(b, "/api/v1/scans", input.stageId);
    expect(manual.response.status).toBe(409);
    expect(JSON.stringify(await manual.response.json())).not.toContain(a.organizationId);
    expect(manual.queue.send).not.toHaveBeenCalled();
    const discovery = await request(b, "/api/v1/staged-publishes/scan");
    expect(discovery.response.status).toBe(202);
    expect(await discovery.response.json()).toMatchObject({ found: 1, created: 0, skipped: 1 });
    expect(discovery.queue.send).not.toHaveBeenCalled();
  });

  test("uncertain stage access cannot establish a claim or enqueue", async () => {
    const a = await owner();
    await connection(a);
    const input = scanInput(a, `uncertain-${crypto.randomUUID()}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 400 })),
    );
    const result = await request(a, "/api/v1/scans", input.stageId);
    expect(result.response.status).toBe(503);
    expect(result.queue.send).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(schema.npmPackageClaims)
        .where(eq(schema.npmPackageClaims.packageName, input.packageName)),
    ).toHaveLength(0);
  });

  test.each(["missing", "invalid", "wrong_stage"] as const)(
    "%s registry identity cannot establish a claim despite positive stage access",
    async (identity) => {
      const a = await owner();
      await connection(a);
      const input = scanInput(a, `identity-${crypto.randomUUID()}`);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          if (String(url).endsWith("/tarball")) return new Response("", { status: 206 });
          return Response.json({
            id: identity === "wrong_stage" ? `stage-${crypto.randomUUID()}` : input.stageId,
            packageName:
              identity === "missing"
                ? null
                : identity === "invalid"
                  ? "../invalid"
                  : input.packageName,
            version: "1.0.0",
          });
        }),
      );
      const result = await request(a, "/api/v1/scans", input.stageId);
      expect(result.response.status).toBe(503);
      expect(result.queue.send).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.organizationId, a.organizationId)),
      ).toHaveLength(0);
    },
  );
});
