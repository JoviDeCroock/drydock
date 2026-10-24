import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  completeDependencyReview,
  createDependencyReview,
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
    await supersedeDependencyReview(createDb(env.DB), queued.id);

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
    };
    expect(body.review).toMatchObject({ id: review.id, conclusion: "clear" });
    expect(body.bumps.map((b) => b.bump.name)).toEqual(["left-pad"]);
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
