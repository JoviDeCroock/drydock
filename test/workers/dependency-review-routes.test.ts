import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  completeDependencyReview,
  createDependencyReview,
  getDependencyReview,
  supersedeDependencyReview,
  getDependencyReviewSettings,
} from "../../server/db/dependency-reviews";
import { addOrganizationMember } from "../../server/db/invitations";
import * as schema from "../../server/db/schema";
import { DEFAULT_DEPENDENCY_REVIEW_POLICY } from "../../server/lib/dependency-review/types";
import { dependencyReviewRoutes } from "../../server/routes/dependency-reviews";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { callWorker } from "./helpers/auth-http";
import { seedDependencyReviewOrg, sha } from "./helpers/dependency-review";
import { seedUser } from "./helpers/seed";

const BASE = "/api/v1/dependency-reviews";
const mount = (app: TestApp) => app.route(BASE, dependencyReviewRoutes);

type Seeded = Awaited<ReturnType<typeof seedDependencyReviewOrg>>;

async function seedTeammate(seeded: Seeded, role: "admin" | "member") {
  const user = await seedUser();
  await addOrganizationMember(createDb(env.DB), {
    organizationId: seeded.organizationId,
    userId: user.userId,
    role,
  });
  return user;
}

async function seedCompletedReview(seeded: Seeded, headSha = sha("b")) {
  const db = createDb(env.DB);
  const { review } = await createDependencyReview(db, {
    organizationId: seeded.organizationId,
    installationRowId: seeded.installation.id,
    repositoryId: 5151,
    repositoryFullName: "octo/example",
    pullNumber: 42,
    headSha,
    authorLogin: "dependabot[bot]",
  });
  await completeDependencyReview(db, review.id, {
    conclusion: "clear",
    bumps: [
      {
        bump: {
          ecosystem: "npm",
          name: "left-pad",
          fromVersion: "1.0.0",
          toVersion: "1.0.1",
          direct: true,
          lockfilePath: "package-lock.json",
        },
        verdict: { status: "new-package" },
        approved: false,
      },
    ],
    coverage: { unreadLockfiles: [], listingComplete: true },
  });
  return review;
}

async function settingsEvents(organizationId: string) {
  return createDb(env.DB)
    .select()
    .from(schema.scanEvents)
    .where(
      and(
        eq(schema.scanEvents.organizationId, organizationId),
        eq(schema.scanEvents.type, "dependency_review.settings_updated"),
      ),
    );
}

const VALID_SETTINGS = {
  enabled: true,
  policy: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdAtReleaseRisk: "critical" },
  extraBotLogins: ["My-Renovate[bot]"],
};

describe("dependency review routes", () => {
  test("a review stored as a prefix keeps its real totals", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    const db = createDb(env.DB);
    const { bumps } = await getStoredBumps(review.id);
    // A PR past the stored-bump limit: the row keeps the full count, so the
    // page can say it shows only the first part.
    await completeDependencyReview(db, review.id, {
      conclusion: "held",
      bumps,
      bumpCount: 900,
      heldCount: 3,
      coverage: { unreadLockfiles: [], listingComplete: true },
    });
    const stored = await getDependencyReview(db, seeded.organizationId, review.id);
    expect(stored).toMatchObject({ bumpCount: 900, heldCount: 3 });
  });

  test("the detail says whether the check offers Approve, as the approval handler decides", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    const db = createDb(env.DB);
    const read = async () => {
      const res = await call(buildTestApp(mount, seeded), "GET", `${BASE}/${review.id}`);
      return ((await res.json()) as { approvable: boolean }).approvable;
    };
    expect(await read()).toBe(true);
    const { bumps } = await getStoredBumps(review.id);
    await completeDependencyReview(db, review.id, {
      conclusion: "held",
      bumps,
      coverage: { unreadLockfiles: [], listingComplete: false },
    });
    expect(await read()).toBe(false);
  });

  test("an older commit's review names the newer one and offers no Approve", async () => {
    const seeded = await seedDependencyReviewOrg();
    const older = await seedCompletedReview(seeded, sha("1"));
    const newer = await seedCompletedReview(seeded, sha("2"));
    // Both rows can land in the same millisecond; order them explicitly.
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.dependencyReviews.id, older.id));
    const read = async (id: string) => {
      const res = await call(buildTestApp(mount, seeded), "GET", `${BASE}/${id}`);
      return (await res.json()) as { approvable: boolean; newerReviewId: string | null };
    };
    expect(await read(older.id)).toMatchObject({ approvable: false, newerReviewId: newer.id });
    expect(await read(newer.id)).toMatchObject({ approvable: true, newerReviewId: null });
  });

  test("the API requires a session", async () => {
    const { res } = await callWorker("GET", BASE);
    expect(res.status).toBe(401);
  });

  test("a member can list the organization's reviews and settings but not manage them", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    const member = await seedTeammate(seeded, "member");

    const res = await call(buildTestApp(mount, member), "GET", BASE, {
      activeOrganizationId: seeded.organizationId,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      settings: { enabled: boolean };
      githubAppInstalled: boolean;
      reviews: Array<{ id: string }>;
      viewer: { canManage: boolean };
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.githubAppInstalled).toBe(true);
    expect(body.reviews.map((r) => r.id)).toEqual([review.id]);
    expect(body.viewer.canManage).toBe(false);
  });

  test("superseded reviews are left out of the list", async () => {
    const seeded = await seedDependencyReviewOrg();
    await seedCompletedReview(seeded, sha("1"));
    const { review: queued } = await createDependencyReview(createDb(env.DB), {
      organizationId: seeded.organizationId,
      installationRowId: seeded.installation.id,
      repositoryId: 5151,
      repositoryFullName: "octo/example",
      pullNumber: 43,
      headSha: sha("2"),
      authorLogin: "dependabot[bot]",
    });
    await createDependencyReview(createDb(env.DB), {
      organizationId: seeded.organizationId,
      installationRowId: seeded.installation.id,
      repositoryId: 5151,
      repositoryFullName: "octo/example",
      pullNumber: 43,
      headSha: sha("3"),
      authorLogin: "dependabot[bot]",
    });
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ checkRunId: 7 })
      .where(eq(schema.dependencyReviews.id, queued.id));
    await supersedeDependencyReview(createDb(env.DB), queued.id, 7);

    const res = await call(buildTestApp(mount, seeded), "GET", BASE);

    const body = (await res.json()) as { reviews: Array<{ id: string }> };
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews.map((r) => r.id)).not.toContain(queued.id);
  });

  test("a member cannot change settings", async () => {
    const seeded = await seedDependencyReviewOrg({ enabled: false });
    const member = await seedTeammate(seeded, "member");

    const res = await call(buildTestApp(mount, member), "PUT", `${BASE}/settings`, {
      activeOrganizationId: seeded.organizationId,
      body: VALID_SETTINGS,
    });

    expect(res.status).toBe(403);
    expect(
      (await getDependencyReviewSettings(createDb(env.DB), seeded.organizationId)).enabled,
    ).toBe(false);
    expect(await settingsEvents(seeded.organizationId)).toEqual([]);
  });

  test("an admin's settings persist and are audited", async () => {
    const seeded = await seedDependencyReviewOrg({ enabled: null });
    const admin = await seedTeammate(seeded, "admin");

    const res = await call(buildTestApp(mount, admin), "PUT", `${BASE}/settings`, {
      activeOrganizationId: seeded.organizationId,
      body: VALID_SETTINGS,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: {
        enabled: true,
        policy: VALID_SETTINGS.policy,
        extraBotLogins: ["my-renovate[bot]"],
      },
    });
    const stored = await getDependencyReviewSettings(createDb(env.DB), seeded.organizationId);
    expect(stored).toMatchObject({
      enabled: true,
      policy: VALID_SETTINGS.policy,
      extraBotLogins: ["my-renovate[bot]"],
    });
    const [event] = await settingsEvents(seeded.organizationId);
    expect(event).toMatchObject({ actorUserId: admin.userId });
    expect(event.metadataJson).toMatchObject({ enabled: true, extraBotLoginCount: 1 });

    const listed = await call(buildTestApp(mount, admin), "GET", BASE, {
      activeOrganizationId: seeded.organizationId,
    });
    const body = (await listed.json()) as { viewer: { canManage: boolean } };
    expect(body.viewer.canManage).toBe(true);
  });

  test("unknown or invalid policy fields fall back to the defaults", async () => {
    const seeded = await seedDependencyReviewOrg({ enabled: null });

    const res = await call(buildTestApp(mount, seeded), "PUT", `${BASE}/settings`, {
      body: {
        enabled: true,
        policy: {
          holdOnInstallScripts: "no",
          holdAtReleaseRisk: "extreme",
          holdOnNewPackages: true,
        },
      },
    });

    expect(res.status).toBe(200);
    const stored = await getDependencyReviewSettings(createDb(env.DB), seeded.organizationId);
    expect(stored.policy).toEqual({ ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdOnNewPackages: true });
  });

  test.each([
    ["a login with spaces", ["not a login"]],
    ["a non-string entry", [42]],
    ["a duplicate login", ["bot-a", "BOT-A"]],
    ["more than ten logins", Array.from({ length: 11 }, (_, i) => `bot-${i}`)],
  ])("rejects %s in extraBotLogins", async (_label, extraBotLogins) => {
    const seeded = await seedDependencyReviewOrg({ enabled: false });

    const res = await call(buildTestApp(mount, seeded), "PUT", `${BASE}/settings`, {
      body: { ...VALID_SETTINGS, extraBotLogins },
    });

    expect(res.status).toBe(400);
    const stored = await getDependencyReviewSettings(createDb(env.DB), seeded.organizationId);
    expect(stored).toMatchObject({ enabled: false, extraBotLogins: [] });
    expect(await settingsEvents(seeded.organizationId)).toEqual([]);
  });

  test.each([
    ["no enabled flag", { policy: {} }],
    ["a non-object policy", { enabled: true, policy: "strict" }],
  ])("rejects settings with %s", async (_label, body) => {
    const seeded = await seedDependencyReviewOrg({ enabled: false });

    const res = await call(buildTestApp(mount, seeded), "PUT", `${BASE}/settings`, { body });

    expect(res.status).toBe(400);
  });

  test("a review is readable by its organization with its bumps", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    const member = await seedTeammate(seeded, "member");

    const res = await call(buildTestApp(mount, member), "GET", `${BASE}/${review.id}`, {
      activeOrganizationId: seeded.organizationId,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review: { id: string; conclusion: string };
      bumps: Array<{ bump: { name: string } }>;
      coverage: { unreadLockfiles: string[]; listingComplete: boolean };
    };
    expect(body.review).toMatchObject({ id: review.id, conclusion: "clear" });
    expect(body.bumps.map((b) => b.bump.name)).toEqual(["left-pad"]);
    expect(body.coverage).toEqual({ unreadLockfiles: [], listingComplete: true });
  });

  test("a member can read why a review with no recognized bumps was held", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    await completeDependencyReview(createDb(env.DB), review.id, {
      conclusion: "held",
      bumps: [],
      coverage: { unreadLockfiles: ["nested/package.json"], listingComplete: false },
    });
    const member = await seedTeammate(seeded, "member");

    const res = await call(buildTestApp(mount, member), "GET", `${BASE}/${review.id}`, {
      activeOrganizationId: seeded.organizationId,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      review: { id: review.id, conclusion: "held", bumpCount: 0 },
      bumps: [],
      coverage: { unreadLockfiles: ["nested/package.json"], listingComplete: false },
    });
  });

  test("another organization's review id is not found", async () => {
    const victim = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(victim);
    const outsider = await seedDependencyReviewOrg();

    const own = await call(buildTestApp(mount, outsider), "GET", `${BASE}/${review.id}`);
    // Naming the victim's organization without membership falls back to the
    // caller's own organization, so the id still does not resolve.
    const spoofed = await call(buildTestApp(mount, outsider), "GET", `${BASE}/${review.id}`, {
      activeOrganizationId: victim.organizationId,
    });

    expect(own.status).toBe(404);
    expect(spoofed.status).toBe(404);
  });
});

describe("dependency review rollout flag", () => {
  // Flagship serves the flag on only for the organizations a rule targets.
  const flagFor = (enabledOrganizationId: string | null) => ({
    FLAGS: {
      getBooleanValue: async (
        key: string,
        defaultValue: boolean,
        context?: { organizationId?: unknown },
      ) =>
        key === "dependency-review"
          ? context?.organizationId === enabledOrganizationId
          : defaultValue,
    } as unknown as Flagship,
  });

  test("an organization outside the flag gets 404 from every route", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedCompletedReview(seeded);
    const app = buildTestApp(mount, seeded);
    const envOverride = flagFor("org_someone_else");

    const list = await call(app, "GET", BASE, { envOverride });
    const detail = await call(app, "GET", `${BASE}/${review.id}`, { envOverride });
    const save = await call(app, "PUT", `${BASE}/settings`, { body: VALID_SETTINGS, envOverride });

    expect([list.status, detail.status, save.status]).toEqual([404, 404, 404]);
    expect(await settingsEvents(seeded.organizationId)).toHaveLength(0);
  });

  test("an organization the flag targets reads its reviews", async () => {
    const seeded = await seedDependencyReviewOrg();
    await seedCompletedReview(seeded);

    const res = await call(buildTestApp(mount, seeded), "GET", BASE, {
      envOverride: flagFor(seeded.organizationId),
    });

    expect(res.status).toBe(200);
  });

  test("a failed flag lookup reads as off", async () => {
    const seeded = await seedDependencyReviewOrg();
    const failing = {
      FLAGS: {
        getBooleanValue: async () => {
          throw new Error("flagship unavailable");
        },
      } as unknown as Flagship,
    };

    const res = await call(buildTestApp(mount, seeded), "GET", BASE, { envOverride: failing });

    expect(res.status).toBe(404);
  });
});

async function getStoredBumps(reviewId: string) {
  const [row] = await createDb(env.DB)
    .select({ bumpsJson: schema.dependencyReviews.bumpsJson })
    .from(schema.dependencyReviews)
    .where(eq(schema.dependencyReviews.id, reviewId));
  return { bumps: JSON.parse(row!.bumpsJson ?? "[]") };
}
