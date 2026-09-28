import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { buildTestApp } from "./helpers/app";
import { persistScanWithArtifacts } from "./helpers/persist-scan";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  deleteNpmConnection,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import {
  createOrganization,
  deleteOrganization,
  ensurePersonalOrganization,
} from "../../server/db/organizations";
import { addOrganizationMember } from "../../server/db/invitations";
import { PackageClaimConflictError } from "../../server/db/package-claims";
import {
  createScanJob,
  deleteFailedScan,
  deletePendingScanJob,
  discardScanAttempt,
  markScanFailed,
  readNpmPackageClaimAvailability,
} from "../../server/db/scan-jobs";
import { publicationWatchOwnershipConflict } from "../../server/db/publication-watches";
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
  test("deleting one of several historical scans adds no reservation that mutes the others", async () => {
    const a = await owner();
    const packageName = `kept-${crypto.randomUUID()}`;
    const historical = (id: string) => ({
      id,
      stageId: `stage-${id}`,
      organizationId: a.organizationId,
      ownerUserId: a.userId,
      packageName,
      registryPackageName: packageName,
      registryUrl: REGISTRY,
      source: "manual" as const,
      status: "failed" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(schema.scans).values([historical(first), historical(second)]);
    const claims = () =>
      db
        .select()
        .from(schema.npmPackageClaims)
        .where(eq(schema.npmPackageClaims.packageName, packageName));
    const state = async () => {
      const [row] = await db.all<{ conflict: number }>(
        sql`select ${publicationWatchOwnershipConflict(REGISTRY, packageName, a.organizationId)} as conflict`,
      );
      return {
        availability: await readNpmPackageClaimAvailability(db, {
          registryUrl: REGISTRY,
          packageName,
          organizationId: a.organizationId,
        }),
        conflict: row?.conflict,
      };
    };
    await deleteFailedScan(db, first, a.organizationId);
    expect(await claims()).toEqual([]);
    expect(await state()).toEqual({ availability: "claimable", conflict: 0 });
    await deleteFailedScan(db, second, a.organizationId);
    expect(await claims()).toMatchObject([{ registryUrl: REGISTRY, organizationId: null }]);
    // With no staged history left, the reservation blocks claims but not watching.
    expect(await state()).toEqual({ availability: "unavailable", conflict: 0 });
  });

  test("unknown-registry history and reservations block only public npm", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const custom = "https://registry.example.test";
    const [historyName, reservedName] = [
      `legacy-${crypto.randomUUID()}`,
      `star-${crypto.randomUUID()}`,
    ];
    await db.insert(schema.scans).values({
      id: crypto.randomUUID(),
      stageId: `stage-${crypto.randomUUID()}`,
      organizationId: a.organizationId,
      ownerUserId: a.userId,
      packageName: historyName,
      source: "manual",
      status: "complete",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.npmPackageClaims).values({
      registryUrl: "*",
      ecosystem: "npm",
      packageName: reservedName,
      organizationId: null,
      firstStageId: "deleted-stage",
      claimedAt: new Date(),
    });
    for (const packageName of [historyName, reservedName]) {
      const availability = (registryUrl: string) =>
        readNpmPackageClaimAvailability(db, {
          registryUrl,
          packageName,
          organizationId: b.organizationId,
        });
      expect(await availability(REGISTRY)).toBe("unavailable");
      expect(await availability(custom)).toBe("claimable");
      await expect(createScanJob(db, scanInput(b, packageName))).rejects.toBeInstanceOf(
        PackageClaimConflictError,
      );
      await expect(
        createScanJob(db, { ...scanInput(b, packageName), registryUrl: custom }),
      ).resolves.toBeTruthy();
    }
  });

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
    "an organization's own pre-claim history does not block its next verified scan (legacy=%s)",
    async (legacy) => {
      const [a, b] = await Promise.all([owner(), owner()]);
      const input = scanInput(a, `historical-${crypto.randomUUID()}`);
      await seedHistoricalScan(a, input.packageName, legacy ? null : REGISTRY);
      await expect(createScanJob(db, scanInput(b, input.packageName))).rejects.toBeInstanceOf(
        PackageClaimConflictError,
      );
      expect(await createScanJob(db, input)).not.toBeNull();
      expect(
        await db
          .select({ organizationId: schema.npmPackageClaims.organizationId })
          .from(schema.npmPackageClaims)
          .where(eq(schema.npmPackageClaims.packageName, input.packageName)),
      ).toEqual([{ organizationId: a.organizationId }]);
    },
  );

  test("unrelated pre-claim history still waits for an audited owner", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const input = scanInput(a, `contested-${crypto.randomUUID()}`);
    await seedHistoricalScan(a, input.packageName, REGISTRY);
    await seedHistoricalScan(b, input.packageName, null);
    for (const org of [a, b]) {
      await expect(createScanJob(db, scanInput(org, input.packageName))).rejects.toBeInstanceOf(
        PackageClaimConflictError,
      );
      expect(
        await readNpmPackageClaimAvailability(db, {
          registryUrl: REGISTRY,
          packageName: input.packageName,
          organizationId: org.organizationId,
        }),
      ).toBe("own_history");
    }
  });

  test("a team claims past its members' personal history, never the reverse", async () => {
    const [member, outsider] = await Promise.all([owner(), owner()]);
    const team = await createOrganization(db, {
      ownerUserId: member.userId,
      name: "Release team",
    });
    const teamOrg = { ...member, organizationId: team };
    const handoff = `handoff-${crypto.randomUUID()}`;
    await seedHistoricalScan(member, handoff, null);
    await seedHistoricalScan(teamOrg, handoff, REGISTRY);
    await expect(createScanJob(db, scanInput(member, handoff))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
    expect(await createScanJob(db, scanInput(teamOrg, handoff))).not.toBeNull();
    const [claim] = await db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, handoff));
    expect(claim).toMatchObject({ organizationId: team, managementConfirmedAt: expect.any(Date) });

    const unrelated = `unrelated-${crypto.randomUUID()}`;
    await seedHistoricalScan(outsider, unrelated, REGISTRY);
    await expect(createScanJob(db, scanInput(teamOrg, unrelated))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
  });

  test("a team without its own history gets no say over a member's personal package", async () => {
    const [member, teamOwner] = await Promise.all([owner(), owner()]);
    const team = await createOrganization(db, {
      ownerUserId: teamOwner.userId,
      name: "Other team",
    });
    await addOrganizationMember(db, {
      organizationId: team,
      userId: member.userId,
      role: "member",
    });
    const teamOrg = { ...teamOwner, organizationId: team };
    const name = `personal-${crypto.randomUUID()}`;
    await seedHistoricalScan(member, name, null);
    const availability = () =>
      readNpmPackageClaimAvailability(db, {
        registryUrl: REGISTRY,
        packageName: name,
        organizationId: team,
      });
    expect(await availability()).toBe("unavailable");
    await expect(createScanJob(db, scanInput(teamOrg, name))).rejects.toBeInstanceOf(
      PackageClaimConflictError,
    );
    // With its own history, a plain member's personal history no longer blocks it.
    await seedHistoricalScan(teamOrg, name, REGISTRY);
    expect(await availability()).toBe("claimable");
    expect(await createScanJob(db, scanInput(teamOrg, name))).not.toBeNull();
  });

  test("two teams with their own history of a member's package stay contested", async () => {
    const member = await owner();
    const teams = await Promise.all(
      ["First team", "Second team"].map((name) =>
        createOrganization(db, { ownerUserId: member.userId, name }),
      ),
    );
    const name = `contested-${crypto.randomUUID()}`;
    await seedHistoricalScan(member, name, REGISTRY);
    for (const team of teams)
      await seedHistoricalScan({ ...member, organizationId: team }, name, REGISTRY);
    for (const team of teams) {
      await expect(
        createScanJob(db, scanInput({ ...member, organizationId: team }, name)),
      ).rejects.toBeInstanceOf(PackageClaimConflictError);
    }
  });

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
      // A complete stage record with an unreviewable name is permanent; the
      // other cases may resolve on retry.
      expect(result.response.status).toBe(identity === "invalid" ? 422 : 503);
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

function stubStage(stage: { id: string; packageName: string }) {
  const accessChecks = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/tarball")) {
        accessChecks();
        return new Response("", { status: 206 });
      }
      const record = { ...stage, version: "1.0.0", access: "public" };
      return Response.json(
        String(url).includes("?perPage") ? { items: [record], total: 1 } : record,
      );
    }),
  );
  return accessChecks;
}

async function seedHistoricalScan(org: Owner, packageName: string, registryUrl: string | null) {
  await db.insert(schema.scans).values({
    id: crypto.randomUUID(),
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId: org.organizationId,
    ownerUserId: org.userId,
    packageName,
    registryUrl,
    registryPackageName: registryUrl ? packageName : null,
    source: "manual",
    status: "complete",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("npm package claim edge cases", () => {
  test("a legacy mixed-case name npm reports is admitted and claimed case-sensitively", async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    await connection(a);
    const input = scanInput(a, `JSONStream-${crypto.randomUUID()}`);
    stubStage({ id: input.stageId, packageName: input.packageName });
    const manual = await request(a, "/api/v1/scans", input.stageId);
    expect(manual.response.status).toBe(202);
    expect(manual.queue.send).toHaveBeenCalledOnce();
    const [claim] = await db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, input.packageName));
    expect(claim).toMatchObject({ registryUrl: REGISTRY, organizationId: a.organizationId });
    // npm treats the lowercase spelling as a different package.
    expect(await createScanJob(db, scanInput(b, input.packageName.toLowerCase()))).not.toBeNull();
  });

  test("manual conflict on the caller's contested pre-claim history says it awaits support", async () => {
    const [a, b, c] = await Promise.all([owner(), owner(), owner()]);
    await Promise.all([connection(a), connection(b)]);
    const input = scanInput(a, `own-history-${crypto.randomUUID()}`);
    await seedHistoricalScan(a, input.packageName, `${REGISTRY}/`);
    await seedHistoricalScan(c, input.packageName, REGISTRY);
    stubStage({ id: input.stageId, packageName: input.packageName });
    const own = await request(a, "/api/v1/scans", input.stageId);
    expect(own.response.status).toBe(409);
    expect(((await own.response.json()) as { error: string }).error).toMatch(
      /earlier reviews of this package/,
    );
    expect(own.queue.send).not.toHaveBeenCalled();
    const other = await request(b, "/api/v1/scans", input.stageId);
    expect(other.response.status).toBe(409);
    expect(((await other.response.json()) as { error: string }).error).toBe(
      new PackageClaimConflictError().message,
    );
  });

  test.each(["other_claim", "own_history", "legacy_reservation"] as const)(
    "discovery skips a %s stage before the credentialed access check and reports it",
    async (blocker) => {
      const [a, b] = await Promise.all([owner(), owner()]);
      await connection(b);
      const name = `blocked-${crypto.randomUUID()}`;
      if (blocker === "other_claim") await createScanJob(db, scanInput(a, name));
      else if (blocker === "own_history") {
        await seedHistoricalScan(b, name, REGISTRY);
        await seedHistoricalScan(a, name, REGISTRY);
      } else await seedHistoricalScan(a, name, null);
      const stageId = `stage-${crypto.randomUUID()}`;
      const accessChecks = stubStage({ id: stageId, packageName: name });
      const log = vi.spyOn(console, "log");
      const discovery = await request(b, "/api/v1/staged-publishes/scan");
      const body = await discovery.response.json();
      expect(body).toMatchObject({ found: 1, created: 0, skipped: 1 });
      expect(body).not.toHaveProperty("claimBlocked");
      expect(accessChecks).not.toHaveBeenCalled();
      expect(discovery.queue.send).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "staged_publishes.claim_blocked",
        expect.objectContaining({ organizationId: b.organizationId, count: 1 }),
      );
      log.mockRestore();
    },
  );

  test("discovery admits a stage whose only pre-claim history is the organization's own", async () => {
    const b = await owner();
    await connection(b);
    const name = `own-legacy-${crypto.randomUUID()}`;
    await seedHistoricalScan(b, name, null);
    const stageId = `stage-${crypto.randomUUID()}`;
    stubStage({ id: stageId, packageName: name });
    const discovery = await request(b, "/api/v1/staged-publishes/scan");
    expect(await discovery.response.json()).toMatchObject({ found: 1, created: 1, skipped: 0 });
    expect(discovery.queue.send).toHaveBeenCalledOnce();
  });

  test("supersession matches a same-owner legacy row stored with a trailing slash", async () => {
    const a = await owner();
    const first = scanInput(a, `slash-${crypto.randomUUID()}`);
    await createScanJob(db, first);
    await db
      .update(schema.scans)
      .set({ registryUrl: `${REGISTRY}/` })
      .where(eq(schema.scans.id, first.id));
    await createScanJob(db, scanInput(a, first.packageName));
    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, first.id));
    expect(row.registryStatusSupersededAt).toBeInstanceOf(Date);
  });

  test("persisting a scan whose job row vanished creates no row that reserves its name", async () => {
    const a = await owner();
    const id = crypto.randomUUID();
    const packageName = `vanished-${crypto.randomUUID()}`;
    const result = await persistScanWithArtifacts(db, {
      id,
      stageId: `stage-${crypto.randomUUID()}`,
      organizationId: a.organizationId,
      ownerUserId: a.userId,
      packageJson: { name: packageName, version: "1.0.0" },
      risk: "low",
      status: "complete",
      summary: {},
      ai: null,
      files: [],
      diff: [],
      findings: [],
    });
    expect(result).toMatchObject({ persisted: false, reason: "missing" });
    expect(await db.select().from(schema.scans).where(eq(schema.scans.id, id))).toHaveLength(0);
    const b = await owner();
    expect(await createScanJob(db, scanInput(b, packageName))).not.toBeNull();
  });
});
