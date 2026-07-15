import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  listOrganizationMilestones,
  reconcileOrganizationMilestones,
  recordOrganizationMilestone,
} from "../../server/db/organization-milestones";
import { organizations, scans, user } from "../../server/db/schema";

const db = createDb(env.DB);
const userId = `milestone-user-${crypto.randomUUID()}`;
const organizationId = `milestone-org-${crypto.randomUUID()}`;

afterEach(async () => {
  await db.delete(scans).where(eq(scans.organizationId, organizationId));
  await db.delete(organizations).where(eq(organizations.id, organizationId));
  await db.delete(user).where(eq(user.id, userId));
});

describe("organization milestone projection", () => {
  test("keeps exact first/last timestamps and an idempotent bounded row", async () => {
    const createdAt = new Date("2026-07-15T08:00:00.000Z");
    await db.insert(user).values({
      id: userId,
      name: "Milestone Test",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(organizations).values({
      id: organizationId,
      name: "Milestones",
      ownerUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });

    await recordOrganizationMilestone(
      db,
      organizationId,
      "protected_release_completed",
      new Date("2026-07-15T10:00:00.000Z"),
    );
    await recordOrganizationMilestone(
      db,
      organizationId,
      "protected_release_completed",
      new Date("2026-07-15T12:00:00.000Z"),
    );

    const rows = await listOrganizationMilestones(db, organizationId);
    expect(rows).toEqual([
      {
        milestone: "protected_release_completed",
        firstAt: new Date("2026-07-15T10:00:00.000Z"),
        lastAt: new Date("2026-07-15T12:00:00.000Z"),
        count: 2,
      },
    ]);
  });

  test("reconciles existing durable organization, review, and decision state", async () => {
    const createdAt = new Date("2026-07-14T08:00:00.000Z");
    const completedAt = new Date("2026-07-15T10:00:00.000Z");
    await db.insert(user).values({
      id: userId,
      name: "Milestone Test",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(organizations).values({
      id: organizationId,
      name: "Milestones",
      ownerUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(scans).values({
      id: `scan-${crypto.randomUUID()}`,
      stageId: "@scope/pkg@1.0.0",
      organizationId,
      ownerUserId: userId,
      status: "complete",
      source: "manual",
      risk: "low",
      decision: "publish",
      decidedAt: completedAt,
      completedAt,
      createdAt,
      updatedAt: completedAt,
    });

    await reconcileOrganizationMilestones(db);

    const milestones = await listOrganizationMilestones(db, organizationId);
    expect(milestones).toHaveLength(4);
    expect(milestones).toEqual(
      expect.arrayContaining([
        {
          milestone: "organization_created",
          firstAt: createdAt,
          lastAt: createdAt,
          count: 1,
        },
        {
          milestone: "artifact_observed",
          firstAt: completedAt,
          lastAt: completedAt,
          count: 1,
        },
        {
          milestone: "review_completed",
          firstAt: completedAt,
          lastAt: completedAt,
          count: 1,
        },
        {
          milestone: "protected_release_completed",
          firstAt: completedAt,
          lastAt: completedAt,
          count: 1,
        },
      ]),
    );
  });
});
