import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, recordRegistryVersionStatus } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { packagesRoutes } from "../../server/routes/packages";
import type { Bindings, Variables } from "../../server/types";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(name = "Tester"): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

interface SeedReleaseOptions {
  version: string;
  tag?: string | null;
  source?: "manual" | "auto_discovery" | "workflow_gate" | "published";
  ecosystem?: string;
  decision?: "publish" | "no_publish" | null;
  registryStatus?: string | null;
  baseline?: { version: string | null; source: string; tag: string | null };
  createdAt?: Date;
}

async function seedRelease(owner: SeededUser, packageName: string, options: SeedReleaseOptions) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const source = options.source ?? "manual";
  const staged = source === "manual" || source === "auto_discovery";
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source,
    packageName,
    stagedVersion: options.version,
    registryUrl: staged ? "https://registry.npmjs.org/" : undefined,
  });
  const stagedPublish =
    source === "workflow_gate"
      ? { provenance: { ecosystem: options.ecosystem ?? "npm" } }
      : source === "published"
        ? { ecosystem: options.ecosystem ?? "npm" }
        : { id: stageId, tag: options.tag ?? "latest" };
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: packageName, version: options.version },
    previousPackageJson: options.baseline?.version
      ? { name: packageName, version: options.baseline.version }
      : null,
    risk: "low",
    status: "complete",
    summary: {
      stagedPublish,
      baseline: options.baseline
        ? { ...options.baseline, distTagVersion: null, reason: options.baseline.source }
        : undefined,
    },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    report: { version: 1, digest: "digest" },
  });
  const patch: Partial<typeof schema.scans.$inferInsert> = {};
  if (options.decision) {
    patch.decision = options.decision;
    patch.decidedByUserId = owner.userId;
    patch.decidedAt = new Date("2026-09-02T10:00:00Z");
  }
  if (options.createdAt) patch.createdAt = options.createdAt;
  if (Object.keys(patch).length) {
    await db.update(schema.scans).set(patch).where(eq(schema.scans.id, scanId));
  }
  if (options.registryStatus) {
    await recordRegistryVersionStatus(db, {
      scanId,
      organizationId: owner.organizationId,
      status: options.registryStatus,
      checkedAt: new Date("2026-09-03T08:00:00Z"),
    });
  }
  return scanId;
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/packages", packagesRoutes);
  return app;
}

async function fetchReleases(owner: SeededUser, path: string) {
  const ctx = createExecutionContext();
  const res = await buildTestApp(owner).fetch(
    new Request(`http://test.local${path}`, { method: "GET" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

interface ReleasesBody {
  package: { name: string; ecosystem: string };
  summary: {
    totalReviews: number;
    channels: Array<{ tag: string | null; reviews: number }>;
    lastRelease: { id: string; version: string | null; tag: string | null } | null;
    publishedWithoutDecision: number;
    publishedDespiteBlock: number;
  };
  releases: Array<{
    id: string;
    stagedVersion: string | null;
    tag: string | null;
    decision: string | null;
    decidedByName: string | null;
    registryVersionStatus: string | null;
    registryReleaseOutcome: string | null;
    baseline: { version: string | null; source: string | null; tag: string | null } | null;
    previousVersion: string | null;
  }>;
  nextCursor: string | null;
}

describe("GET /api/v1/packages/:name/releases", () => {
  test("lists only the caller's organization's reviews of the package", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const name = `@org/pkg-${crypto.randomUUID().slice(0, 8)}`;
    const ownedId = await seedRelease(owner, name, { version: "1.0.0" });
    await seedRelease(intruder, name, { version: "9.9.9" });

    const res = await fetchReleases(owner, `/api/v1/packages/${name}/releases`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReleasesBody;
    expect(body.package).toEqual({ name, ecosystem: "npm" });
    expect(body.releases.map((row) => row.id)).toEqual([ownedId]);
    expect(body.summary.totalReviews).toBe(1);

    const intruderRes = await fetchReleases(intruder, `/api/v1/packages/${name}/releases`);
    const intruderBody = (await intruderRes.json()) as ReleasesBody;
    expect(intruderBody.releases.map((row) => row.id)).not.toContain(ownedId);
    expect(intruderBody.summary.totalReviews).toBe(1);
  });

  test("round-trips a scoped name with its slash in the path", async () => {
    const owner = await seedUser();
    const name = `@scope/name-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedRelease(owner, name, { version: "2.0.0" });

    for (const path of [
      `/api/v1/packages/${name}/releases`,
      `/api/v1/packages/%40scope/${name.slice(7)}/releases`,
    ]) {
      const res = await fetchReleases(owner, path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReleasesBody;
      expect(body.package.name).toBe(name);
      expect(body.releases[0]?.id).toBe(scanId);
    }
  });

  test("carries channel, decision author, npm outcome, and the baseline rule per row", async () => {
    const owner = await seedUser("Ada Reviewer");
    const name = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const beta = await seedRelease(owner, name, {
      version: "2.0.0-beta.2",
      tag: "beta",
      decision: "publish",
      registryStatus: "published",
      baseline: { version: "2.0.0-beta.1", source: "dist-tag", tag: "beta" },
    });

    const res = await fetchReleases(owner, `/api/v1/packages/${name}/releases`);
    const body = (await res.json()) as ReleasesBody;
    const row = body.releases.find((release) => release.id === beta);
    expect(row).toMatchObject({
      tag: "beta",
      decision: "publish",
      decidedByName: "Ada Reviewer",
      registryVersionStatus: "published",
      registryReleaseOutcome: "published",
      previousVersion: "2.0.0-beta.1",
      baseline: { version: "2.0.0-beta.1", source: "dist-tag", tag: "beta" },
    });
    expect(body.summary.channels).toEqual([{ tag: "beta", reviews: 1 }]);
    expect(body.summary.lastRelease).toMatchObject({
      id: beta,
      version: "2.0.0-beta.2",
      tag: "beta",
    });
  });

  test("counts npm-published releases without a decision and those published over a block", async () => {
    const owner = await seedUser();
    const name = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedRelease(owner, name, {
      version: "1.0.0",
      decision: "publish",
      registryStatus: "published",
    });
    await seedRelease(owner, name, { version: "1.0.1", registryStatus: "published" });
    await seedRelease(owner, name, {
      version: "1.0.2",
      decision: "no_publish",
      registryStatus: "published",
    });
    await seedRelease(owner, name, { version: "1.0.3", registryStatus: "blocked" });
    await seedRelease(owner, name, { version: "1.0.4" });

    const res = await fetchReleases(owner, `/api/v1/packages/${name}/releases`);
    const body = (await res.json()) as ReleasesBody;
    expect(body.summary.totalReviews).toBe(5);
    expect(body.summary.publishedWithoutDecision).toBe(1);
    expect(body.summary.publishedDespiteBlock).toBe(1);
  });

  test("keeps workflow-gate reviews of another ecosystem off the npm page", async () => {
    const owner = await seedUser();
    const name = `shared-${crypto.randomUUID().slice(0, 8)}`;
    const npmId = await seedRelease(owner, name, { version: "1.0.0" });
    const pypiId = await seedRelease(owner, name, {
      version: "1.0.0",
      source: "workflow_gate",
      ecosystem: "pypi",
    });
    const npmGateId = await seedRelease(owner, name, {
      version: "1.1.0",
      source: "workflow_gate",
      ecosystem: "npm",
    });

    const npmRes = await fetchReleases(owner, `/api/v1/packages/${name}/releases`);
    const npmBody = (await npmRes.json()) as ReleasesBody;
    expect(new Set(npmBody.releases.map((row) => row.id))).toEqual(new Set([npmId, npmGateId]));
    expect(npmBody.summary.totalReviews).toBe(2);

    const pypiRes = await fetchReleases(owner, `/api/v1/packages/${name}/releases?ecosystem=pypi`);
    const pypiBody = (await pypiRes.json()) as ReleasesBody;
    expect(pypiBody.releases.map((row) => row.id)).toEqual([pypiId]);
    expect(pypiBody.package.ecosystem).toBe("pypi");
  });

  test("pages newest first with the shared cursor", async () => {
    const owner = await seedUser();
    const name = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const older = await seedRelease(owner, name, {
      version: "1.0.0",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const newer = await seedRelease(owner, name, {
      version: "1.1.0",
      createdAt: new Date("2026-09-02T00:00:00Z"),
    });

    const first = (await (
      await fetchReleases(owner, `/api/v1/packages/${name}/releases?limit=1`)
    ).json()) as ReleasesBody;
    expect(first.releases.map((row) => row.id)).toEqual([newer]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.summary.totalReviews).toBe(2);

    const second = (await (
      await fetchReleases(
        owner,
        `/api/v1/packages/${name}/releases?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as ReleasesBody;
    expect(second.releases.map((row) => row.id)).toEqual([older]);
    expect(second.nextCursor).toBeNull();
  });

  test("rejects malformed package names and unknown ecosystems", async () => {
    const owner = await seedUser();
    expect((await fetchReleases(owner, "/api/v1/packages/%20/releases")).status).toBe(400);
    expect(
      (await fetchReleases(owner, `/api/v1/packages/${"a".repeat(215)}/releases`)).status,
    ).toBe(400);
    expect(
      (await fetchReleases(owner, "/api/v1/packages/left-pad/releases?ecosystem=gem")).status,
    ).toBe(400);
  });
});
