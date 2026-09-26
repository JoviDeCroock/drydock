import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createOrganization } from "../../server/db/organizations";
import {
  manageNpmPackageClaim,
  npmPackageClaimMatches,
  npmPackageManagementAllowed,
  PackageManagementAuthorizationError,
  PackageManagementConflictError,
  readNpmPackageManagement,
} from "../../server/db/package-claims";
import { createScanJob } from "../../server/db/scan-jobs";
import { getScan } from "../../server/db/scan-detail";
import * as schema from "../../server/db/schema";
import { publicationWatchOwnershipConflict } from "../../server/db/publication-watches";
import { npmPackageClaimRoutes } from "../../server/routes/npm-package-claims";
import { buildTestApp, call } from "./helpers/app";
import { seedUser, type SeededUser } from "./helpers/seed";

const registryUrl = "https://registry.npmjs.org";
async function fixture() {
  const owner = await seedUser();
  const packageName = `claim-${crypto.randomUUID()}`;
  const scanId = crypto.randomUUID();
  await createScanJob(owner.db, {
    id: scanId,
    stageId: `stage-${scanId}`,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageName,
    stagedVersion: "1.0.0",
    registryUrl,
    stageAccessStatus: 206,
  });
  return { ...owner, packageName, scanId };
}
function input(
  owner: Awaited<ReturnType<typeof fixture>>,
  targetOrganizationId = owner.organizationId,
) {
  return {
    registryUrl,
    packageName: owner.packageName,
    organizationId: owner.organizationId,
    userId: owner.userId,
    targetOrganizationId,
  };
}
async function allowed(
  owner: Awaited<ReturnType<typeof fixture>>,
  organizationId = owner.organizationId,
) {
  return owner.db.all<{ scan: number; management: number }>(sql`select
    ${npmPackageClaimMatches(registryUrl, owner.packageName, organizationId)} as scan,
    ${npmPackageManagementAllowed(registryUrl, owner.packageName, organizationId)} as management`);
}
async function team(owner: SeededUser) {
  return createOrganization(owner.db, { ownerUserId: owner.userId, name: "Shared destination" });
}
function app(owner: SeededUser) {
  return buildTestApp(
    (app) => app.route("/api/v1/npm-package-claims", npmPackageClaimRoutes),
    owner,
  );
}

describe("personal npm package management", () => {
  test("unclaimed personal package choices include owned teams without disclosing a foreign claim", async () => {
    const owner = await fixture();
    const destination = await team(owner);
    const unclaimed = { ...input(owner), packageName: "never-claimed" };
    expect(await readNpmPackageManagement(owner.db, unclaimed)).toEqual({
      claim: null,
      destinations: [{ id: destination, name: "Shared destination" }],
    });
    const foreign = await seedUser();
    await owner.db
      .update(schema.npmPackageClaims)
      .set({ organizationId: foreign.organizationId })
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    expect(await readNpmPackageManagement(owner.db, input(owner))).toEqual({
      claim: null,
      destinations: [{ id: destination, name: "Shared destination" }],
    });
    const sharedSource = await readNpmPackageManagement(owner.db, {
      ...unclaimed,
      organizationId: destination,
    });
    expect(sharedSource).toEqual({ claim: null, destinations: [] });
  });

  test("server configured local registry is the default selector and enrolls its transferred watch", async () => {
    const owner = await fixture();
    const destination = await team(owner);
    const localRegistry = "http://127.0.0.1:4873";
    await owner.db
      .update(schema.npmPackageClaims)
      .set({ registryUrl: localRegistry })
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    const envOverride = { ALLOW_INSECURE_LOCAL_REGISTRY: "true", NPM_REGISTRY: localRegistry };
    const read = await call(app(owner), "GET", `/api/v1/npm-package-claims/${owner.packageName}`, {
      envOverride,
    });
    expect(((await read.json()) as { claim: unknown }).claim).not.toBeNull();
    const response = await call(
      app(owner),
      "POST",
      `/api/v1/npm-package-claims/${owner.packageName}`,
      {
        body: { targetOrganizationId: destination },
        envOverride,
      },
    );
    expect(response.status).toBe(200);
    const watches = await owner.db
      .select()
      .from(schema.publicationWatches)
      .where(eq(schema.publicationWatches.packageName, owner.packageName));
    expect(watches.map((w) => w.organizationId)).toEqual([destination]);
  });

  test("shared admin can receive management and a personal destination cannot even with admin membership", async () => {
    const owner = await fixture();
    const foreign = await seedUser();
    const destination = await team(foreign);
    await owner.db.insert(schema.organizationMembers).values(
      [destination, foreign.organizationId].map((organizationId) => ({
        id: crypto.randomUUID(),
        organizationId,
        userId: owner.userId,
        role: "admin" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    await expect(
      manageNpmPackageClaim(owner.db, input(owner, foreign.organizationId)),
    ).rejects.toBeInstanceOf(PackageManagementAuthorizationError);
    await manageNpmPackageClaim(owner.db, input(owner, destination));
    expect(await allowed(owner, destination)).toEqual([{ scan: 1, management: 1 }]);
  });

  test("rechecks actual personal owner after preflight before mutation", async () => {
    const owner = await fixture();
    const foreign = await seedUser();
    const originalBatch = owner.db.batch.bind(owner.db);
    const interception = vi.spyOn(owner.db, "batch").mockImplementationOnce(async (queries) => {
      await owner.db
        .update(schema.organizations)
        .set({ ownerUserId: foreign.userId })
        .where(eq(schema.organizations.id, owner.organizationId));
      return originalBatch(queries);
    });
    try {
      await expect(manageNpmPackageClaim(owner.db, input(owner))).rejects.toBeInstanceOf(
        PackageManagementConflictError,
      );
    } finally {
      interception.mockRestore();
    }
    const [claim] = await owner.db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    expect(claim?.managementConfirmedAt).toBeNull();
  });

  test("private registry management does not enroll a public npm watch", async () => {
    const owner = await fixture();
    const privateRegistry = "https://registry.example.com";
    await owner.db
      .update(schema.npmPackageClaims)
      .set({ registryUrl: privateRegistry })
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    const response = await call(
      app(owner),
      "POST",
      `/api/v1/npm-package-claims/${owner.packageName}`,
      {
        body: { targetOrganizationId: owner.organizationId, registryUrl: privateRegistry + "/" },
      },
    );
    expect(response.status).toBe(200);
    expect(
      await owner.db
        .select()
        .from(schema.publicationWatches)
        .where(eq(schema.publicationWatches.packageName, owner.packageName)),
    ).toEqual([]);
  });

  test("rechecks destination membership after authorization and before mutation", async () => {
    const owner = await fixture();
    const destination = await team(owner);
    const originalBatch = owner.db.batch.bind(owner.db);
    const interception = vi.spyOn(owner.db, "batch").mockImplementationOnce(async (queries) => {
      await owner.db
        .delete(schema.organizationMembers)
        .where(
          and(
            eq(schema.organizationMembers.organizationId, destination),
            eq(schema.organizationMembers.userId, owner.userId),
          ),
        );
      return originalBatch(queries);
    });
    try {
      await expect(
        manageNpmPackageClaim(owner.db, input(owner, destination)),
      ).rejects.toBeInstanceOf(PackageManagementConflictError);
    } finally {
      interception.mockRestore();
    }
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 0 }]);
    expect(
      await owner.db
        .select()
        .from(schema.publicationWatches)
        .where(eq(schema.publicationWatches.packageName, owner.packageName)),
    ).toEqual([]);
  });

  test("personal admission reserves review but explicit confirmation enables management and enrolls a watch", async () => {
    const owner = await fixture();
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 0 }]);
    const response = await call(
      app(owner),
      "POST",
      `/api/v1/npm-package-claims/${owner.packageName}`,
      {
        body: { targetOrganizationId: owner.organizationId },
      },
    );
    expect(response.status).toBe(200);
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 1 }]);
    const watches = await owner.db
      .select()
      .from(schema.publicationWatches)
      .where(eq(schema.publicationWatches.organizationId, owner.organizationId));
    expect(watches.map((w) => w.packageName)).toEqual([owner.packageName]);
    const read = await readNpmPackageManagement(owner.db, input(owner));
    expect(read.claim).toEqual({ kind: "personal", managementConfirmed: true, canManage: true });
  });

  test("transfer keeps private history and source watch in place and cannot transfer again from shared org", async () => {
    const owner = await fixture();
    const destination = await team(owner);
    await manageNpmPackageClaim(owner.db, input(owner));
    await manageNpmPackageClaim(owner.db, input(owner, destination));
    expect(await allowed(owner)).toEqual([{ scan: 0, management: 0 }]);
    expect(await allowed(owner, destination)).toEqual([{ scan: 1, management: 1 }]);
    expect(await getScan(owner.db, owner.scanId, owner.organizationId)).not.toBeNull();
    expect(await getScan(owner.db, owner.scanId, destination)).toBeNull();
    const watches = await owner.db
      .select()
      .from(schema.publicationWatches)
      .where(eq(schema.publicationWatches.packageName, owner.packageName));
    expect(watches.map((w) => w.organizationId).sort()).toEqual(
      [owner.organizationId, destination].sort(),
    );
    const receipts = await owner.db
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, destination));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.metadataJson).toEqual({
      packageName: owner.packageName,
      registryUrl,
      sourceOrganizationId: owner.organizationId,
      destinationOrganizationId: destination,
      destinationOrganizationName: "Shared destination",
    });
    expect(receipts[0]?.scanId).toBeNull();
    const [sourceWatch] = await owner.db.all<{ conflict: number }>(sql`select
      ${publicationWatchOwnershipConflict(registryUrl, owner.packageName, owner.organizationId)} as conflict`);
    expect(sourceWatch?.conflict).toBe(1);
    await expect(
      manageNpmPackageClaim(owner.db, { ...input(owner), organizationId: destination }),
    ).rejects.toBeInstanceOf(PackageManagementAuthorizationError);
    expect((await readNpmPackageManagement(owner.db, input(owner))).claim).toBeNull();
  });

  test("confirming twice keeps the original confirmation and audit trail", async () => {
    const owner = await fixture();
    expect(await manageNpmPackageClaim(owner.db, input(owner))).toEqual({ changed: true });
    const [first] = await owner.db
      .select({ confirmedAt: schema.npmPackageClaims.managementConfirmedAt })
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await manageNpmPackageClaim(owner.db, input(owner))).toEqual({ changed: false });
    const [second] = await owner.db
      .select({ confirmedAt: schema.npmPackageClaims.managementConfirmedAt })
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    expect(second?.confirmedAt).toEqual(first?.confirmedAt);
    const events = await owner.db
      .select()
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "npm_package.management_confirmed"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  test("the management route maps foreign and full destinations", async () => {
    const owner = await fixture();
    const path = `/api/v1/npm-package-claims/${owner.packageName}`;
    const stranger = await seedUser();
    const strangersTeam = await team(stranger);
    const forbidden = await call(app(owner), "POST", path, {
      body: { targetOrganizationId: strangersTeam },
    });
    expect(forbidden.status).toBe(403);
    const destination = await team(owner);
    await owner.db.insert(schema.publicationWatches).values(
      Array.from({ length: 20 }, (_, index) => ({
        id: crypto.randomUUID(),
        organizationId: destination,
        packageName: `occupied-${index}-${crypto.randomUUID()}`,
        source: "manual" as const,
        createdAt: new Date(),
      })),
    );
    const full = await call(app(owner), "POST", path, {
      body: { targetOrganizationId: destination },
    });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toContain("limit of 20");
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 0 }]);
  });

  test("simultaneous transfers admit one destination and enroll only its watch", async () => {
    const owner = await fixture();
    const destinations = await Promise.all([team(owner), team(owner)]);
    const results = await Promise.allSettled(
      destinations.map((destination) => manageNpmPackageClaim(owner.db, input(owner, destination))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const watches = await owner.db
      .select()
      .from(schema.publicationWatches)
      .where(eq(schema.publicationWatches.packageName, owner.packageName));
    expect(watches).toHaveLength(1);
    expect(await allowed(owner, watches[0]!.organizationId)).toEqual([{ scan: 1, management: 1 }]);
  });

  test("rejects member, nonmember, another personal destination, and shared source", async () => {
    const owner = await fixture();
    const foreign = await seedUser();
    const destination = await team(foreign);
    await expect(manageNpmPackageClaim(owner.db, input(owner, destination))).rejects.toBeInstanceOf(
      PackageManagementAuthorizationError,
    );
    await owner.db.insert(schema.organizationMembers).values({
      id: crypto.randomUUID(),
      organizationId: destination,
      userId: owner.userId,
      role: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(manageNpmPackageClaim(owner.db, input(owner, destination))).rejects.toBeInstanceOf(
      PackageManagementAuthorizationError,
    );
    await expect(
      manageNpmPackageClaim(owner.db, input(owner, foreign.organizationId)),
    ).rejects.toBeInstanceOf(PackageManagementAuthorizationError);
    const read = await readNpmPackageManagement(owner.db, input(owner));
    expect(read.destinations).toEqual([]);
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 0 }]);
  });

  test("fresh admin membership permits transfer; revoked membership and stale personal owner do not", async () => {
    const owner = await fixture();
    const foreign = await seedUser();
    const destination = await team(foreign);
    const memberId = crypto.randomUUID();
    await owner.db.insert(schema.organizationMembers).values({
      id: memberId,
      organizationId: destination,
      userId: owner.userId,
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(
      (await readNpmPackageManagement(owner.db, input(owner))).destinations.map((d) => d.id),
    ).toEqual([destination]);
    await owner.db
      .delete(schema.organizationMembers)
      .where(eq(schema.organizationMembers.id, memberId));
    await expect(manageNpmPackageClaim(owner.db, input(owner, destination))).rejects.toBeInstanceOf(
      PackageManagementAuthorizationError,
    );
    await owner.db
      .update(schema.organizations)
      .set({ ownerUserId: foreign.userId })
      .where(eq(schema.organizations.id, owner.organizationId));
    await expect(manageNpmPackageClaim(owner.db, input(owner))).rejects.toBeInstanceOf(
      PackageManagementAuthorizationError,
    );
  });

  test("capacity failure does not change claim, create audit receipts, or enroll candidates", async () => {
    const owner = await fixture();
    const destination = await team(owner);
    await owner.db.insert(schema.publicationWatches).values(
      Array.from({ length: 20 }, (_, i) => ({
        id: crypto.randomUUID(),
        organizationId: destination,
        packageName: `full-${i}`,
        source: "manual" as const,
        createdAt: new Date(),
      })),
    );
    await expect(manageNpmPackageClaim(owner.db, input(owner, destination))).rejects.toBeInstanceOf(
      PackageManagementConflictError,
    );
    expect(await allowed(owner)).toEqual([{ scan: 1, management: 0 }]);
    expect(
      await owner.db
        .select()
        .from(schema.scanEvents)
        .where(eq(schema.scanEvents.organizationId, destination)),
    ).toEqual([]);
    expect(
      await owner.db
        .select()
        .from(schema.publicationWatchCandidates)
        .where(eq(schema.publicationWatchCandidates.organizationId, destination)),
    ).toEqual([]);
  });

  test("GET never discloses another organization claim and validates coordinates", async () => {
    const owner = await fixture();
    const foreign = await seedUser();
    const response = await call(
      app(foreign),
      "GET",
      `/api/v1/npm-package-claims/${owner.packageName}`,
    );
    expect(await response.json()).toEqual({ claim: null, destinations: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (
        await call(app(owner), "POST", `/api/v1/npm-package-claims/${owner.packageName}`, {
          body: { targetOrganizationId: owner.organizationId, registryUrl: "file:///tmp" },
        })
      ).status,
    ).toBe(400);
  });

  test("team admissions are management confirmed and personal confirmation does not change first stage evidence", async () => {
    const owner = await fixture();
    const before = await owner.db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    await manageNpmPackageClaim(owner.db, input(owner));
    const after = await owner.db
      .select()
      .from(schema.npmPackageClaims)
      .where(eq(schema.npmPackageClaims.packageName, owner.packageName));
    expect(after[0]?.firstStageId).toBe(before[0]?.firstStageId);
    expect(after[0]?.claimedAt).toEqual(before[0]?.claimedAt);
    const destination = await team(owner);
    const name = `team-${crypto.randomUUID()}`;
    await createScanJob(owner.db, {
      id: crypto.randomUUID(),
      stageId: `stage-${crypto.randomUUID()}`,
      organizationId: destination,
      ownerUserId: owner.userId,
      packageName: name,
      stagedVersion: "1",
      registryUrl,
      stageAccessStatus: 200,
    });
    const [claim] = await owner.db
      .select()
      .from(schema.npmPackageClaims)
      .where(
        and(
          eq(schema.npmPackageClaims.packageName, name),
          eq(schema.npmPackageClaims.organizationId, destination),
        ),
      );
    expect(claim?.managementConfirmedAt).toBeInstanceOf(Date);
  });
});
