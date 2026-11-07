import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { chunkForD1 } from "../../server/db/d1-chunk";
import {
  DEPENDENCY_REVIEW_RETENTION_DAYS,
  REPLACED_DEPENDENCY_REVIEW_RETENTION_DAYS,
  pruneDependencyReviews,
} from "../../server/db/dependency-reviews";
import * as schema from "../../server/db/schema";
import worker from "../../server";
import { seedDependencyReviewOrg, sha } from "./helpers/dependency-review";

const DAY_MS = 24 * 60 * 60 * 1000;

type Org = Awaited<ReturnType<typeof seedDependencyReviewOrg>>;

interface SeedReviewOptions {
  pullNumber: number;
  repositoryId?: number;
  ageDays: number;
  // Days since the last claim, completion, or approval; defaults to ageDays.
  updatedDaysAgo?: number;
}

let shaCounter = 0;

function reviewRow(org: Org, options: SeedReviewOptions, now: number) {
  shaCounter += 1;
  const at = new Date(now - options.ageDays * DAY_MS);
  const updated = new Date(now - (options.updatedDaysAgo ?? options.ageDays) * DAY_MS);
  return {
    id: crypto.randomUUID(),
    organizationId: org.organizationId,
    installationRowId: org.installation.id,
    repositoryId: options.repositoryId ?? 1,
    repositoryFullName: "octo/app",
    pullNumber: options.pullNumber,
    headSha: sha(String(shaCounter).padStart(4, "0")),
    authorLogin: "renovate[bot]",
    status: "completed" as const,
    conclusion: "clear" as const,
    bumpsJson: "[]",
    createdAt: at,
    updatedAt: updated,
    completedAt: updated,
  };
}

async function seedReview(org: Org, options: SeedReviewOptions, now: number): Promise<string> {
  const row = reviewRow(org, options, now);
  await org.db.insert(schema.dependencyReviews).values(row);
  return row.id;
}

async function remaining(ids: string[]): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ id: schema.dependencyReviews.id })
    .from(schema.dependencyReviews)
    .where(inArray(schema.dependencyReviews.id, ids));
  return rows.map((row) => row.id).sort();
}

function scheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/15 * * * *",
    noRetry() {},
  } as unknown as ScheduledController;
}

describe("dependency review retention", () => {
  // Pool workers share D1 across files and the sweep is global, so the
  // counts below only hold against an empty table.
  beforeEach(async () => {
    await createDb(env.DB).delete(schema.dependencyReviews);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("deletes a replaced head past the short window and keeps each PR's latest head", async () => {
    const org = await seedDependencyReviewOrg();
    const now = Date.now();
    const pastWindow = REPLACED_DEPENDENCY_REVIEW_RETENTION_DAYS + 1;

    const replacedOld = await seedReview(org, { pullNumber: 1, ageDays: pastWindow + 2 }, now);
    const replacedRecent = await seedReview(org, { pullNumber: 1, ageDays: 2 }, now);
    const latest = await seedReview(org, { pullNumber: 1, ageDays: 1 }, now);
    // Older than the window, but nothing replaced it: same PR number in
    // another repository does not count.
    const otherRepoHead = await seedReview(
      org,
      { pullNumber: 2, repositoryId: 2, ageDays: pastWindow + 5 },
      now,
    );
    await seedReview(org, { pullNumber: 2, repositoryId: 3, ageDays: 1 }, now);
    const idleHead = await seedReview(org, { pullNumber: 3, ageDays: pastWindow }, now);

    const pruned = await pruneDependencyReviews(org.db, new Date(now));

    expect(pruned).toEqual({ replaced: 1, expired: 0 });
    expect(await remaining([replacedOld, replacedRecent, latest, otherRepoHead, idleHead])).toEqual(
      [replacedRecent, latest, otherRepoHead, idleHead].sort(),
    );
  });

  test("ages a review from its last update, not its creation", async () => {
    const org = await seedDependencyReviewOrg();
    const now = Date.now();
    const oldButTouched = await seedReview(
      org,
      { pullNumber: 1, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS + 30, updatedDaysAgo: 1 },
      now,
    );
    const replacedButTouched = await seedReview(
      org,
      { pullNumber: 2, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS, updatedDaysAgo: 1 },
      now,
    );
    await seedReview(org, { pullNumber: 2, ageDays: 2 }, now);

    expect(await pruneDependencyReviews(org.db, new Date(now))).toEqual({
      replaced: 0,
      expired: 0,
    });
    expect(await remaining([oldButTouched, replacedButTouched])).toEqual(
      [oldButTouched, replacedButTouched].sort(),
    );
  });

  test("a newer review in another installation does not replace one", async () => {
    const org = await seedDependencyReviewOrg();
    const other = await seedDependencyReviewOrg();
    const now = Date.now();
    const head = await seedReview(
      org,
      { pullNumber: 1, ageDays: REPLACED_DEPENDENCY_REVIEW_RETENTION_DAYS + 5 },
      now,
    );
    await seedReview(other, { pullNumber: 1, ageDays: 1 }, now);

    expect((await pruneDependencyReviews(org.db, new Date(now))).replaced).toBe(0);
    expect(await remaining([head])).toEqual([head]);
  });

  test("deletes every review past the flat window and keeps its approvals", async () => {
    const org = await seedDependencyReviewOrg();
    const now = Date.now();
    const expired = await seedReview(
      org,
      { pullNumber: 1, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS + 1 },
      now,
    );
    const kept = await seedReview(
      org,
      { pullNumber: 2, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS - 1 },
      now,
    );
    const approvalId = crypto.randomUUID();
    await org.db.insert(schema.dependencyReviewApprovals).values({
      id: approvalId,
      organizationId: org.organizationId,
      repositoryId: 1,
      ecosystem: "npm",
      packageName: "left-pad",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      approvedByLogin: "octocat",
      approvedByGithubId: 1,
      reviewId: expired,
      approvedAt: new Date(now - (DEPENDENCY_REVIEW_RETENTION_DAYS + 1) * DAY_MS),
    });

    const pruned = await pruneDependencyReviews(org.db, new Date(now));

    expect(pruned).toEqual({ replaced: 0, expired: 1 });
    expect(await remaining([expired, kept])).toEqual([kept]);
    const [approval] = await org.db
      .select()
      .from(schema.dependencyReviewApprovals)
      .where(eq(schema.dependencyReviewApprovals.id, approvalId));
    expect(approval?.reviewId).toBeNull();
    expect(approval?.toVersion).toBe("1.0.1");
  });

  test("drains more than one batch in a tick", async () => {
    const org = await seedDependencyReviewOrg();
    const now = Date.now();
    const rows = Array.from({ length: 501 }, (_, index) =>
      reviewRow(org, { pullNumber: index + 1, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS + 1 }, now),
    );
    for (const chunk of chunkForD1(
      rows,
      Object.keys(getTableColumns(schema.dependencyReviews)).length,
    )) {
      await org.db.insert(schema.dependencyReviews).values(chunk);
    }

    const pruned = await pruneDependencyReviews(org.db, new Date(now));

    expect(pruned.expired).toBe(501);
    const left = await org.db
      .select({ id: schema.dependencyReviews.id })
      .from(schema.dependencyReviews)
      .where(eq(schema.dependencyReviews.organizationId, org.organizationId));
    expect(left).toEqual([]);
  });

  test("the age filter searches the updated_at index", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM dependency_reviews WHERE updated_at < ? LIMIT 500",
    )
      .bind(Date.now())
      .all<{ detail: string }>();

    expect(plan.results.map((step) => step.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /SEARCH dependency_reviews USING (?:COVERING )?INDEX dependency_reviews_updated_idx/,
        ),
      ]),
    );
  });

  test("the scheduled tick prunes reviews", async () => {
    const org = await seedDependencyReviewOrg();
    const now = Date.now();
    const expired = await seedReview(
      org,
      { pullNumber: 1, ageDays: DEPENDENCY_REVIEW_RETENTION_DAYS + 1 },
      now,
    );
    const kept = await seedReview(org, { pullNumber: 2, ageDays: 1 }, now);

    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(scheduledController(), env as Cloudflare.Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await remaining([expired, kept])).toEqual([kept]);
  });

  test("a prune failure is logged and never thrown", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.scheduled(
      scheduledController(),
      { ...env, DB: undefined } as unknown as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(errorSpy.mock.calls.some((call) => call[0] === "dependency_reviews.prune_failed")).toBe(
      true,
    );
  });
});
