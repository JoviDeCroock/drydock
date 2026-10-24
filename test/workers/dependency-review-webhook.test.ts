import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createDependencyReview,
  setDependencyReviewCheckRun,
} from "../../server/db/dependency-reviews";
import * as schema from "../../server/db/schema";
import {
  checkRunPayload,
  pullRequestPayload,
  seedDependencyReviewOrg,
  sha,
  uniqueInstallationId,
  webhookHarness,
} from "./helpers/dependency-review";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";

async function reviewRows(organizationId: string) {
  return createDb(env.DB)
    .select()
    .from(schema.dependencyReviews)
    .where(eq(schema.dependencyReviews.organizationId, organizationId));
}

// A review with a check run, as the job leaves it, so check_run events have
// something to route to.
async function seedReviewWithCheckRun(
  seeded: Awaited<ReturnType<typeof seedDependencyReviewOrg>>,
  checkRunId: number,
  headSha = sha("b"),
) {
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
  await setDependencyReviewCheckRun(db, review.id, checkRunId);
  return review;
}

describe("pull_request deliveries", () => {
  test("a Dependabot PR in an enabled organization is recorded and enqueued once", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();

    const { res, json } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({ installationId: seeded.installationExternalId }),
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, result: "dependency_review_queued", created: true });
    const [row] = await reviewRows(seeded.organizationId);
    expect(row).toMatchObject({
      status: "queued",
      headSha: sha("b"),
      pullNumber: 42,
      repositoryId: 5151,
      authorLogin: "dependabot[bot]",
    });
    expect(sent).toEqual([
      { kind: "dependency_review", organizationId: seeded.organizationId, reviewId: row.id },
    ]);
  });

  test("renovate[bot] PRs are reviewed too", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();

    await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({
        installationId: seeded.installationExternalId,
        authorLogin: "renovate[bot]",
      }),
    });

    expect(sent).toHaveLength(1);
  });

  test("an organization-listed login is reviewed whatever its account type", async () => {
    const seeded = await seedDependencyReviewOrg({ extraBotLogins: ["self-hosted-renovate"] });
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({
        installationId: seeded.installationExternalId,
        authorLogin: "Self-Hosted-Renovate",
        authorType: "User",
      }),
    });

    expect(json.result).toBe("dependency_review_queued");
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["a human author", { authorLogin: "octocat", authorType: "User" }, false],
    [
      "dependabot[bot] as a User account",
      { authorLogin: "dependabot[bot]", authorType: "User" },
      false,
    ],
    [
      "a person's fork",
      { authorLogin: "octocat", authorType: "User", headRepositoryId: 9999 },
      true,
    ],
  ] as const)(
    "%s gets a skipped check instead of a review",
    async (_label, payloadOptions, fromFork) => {
      const seeded = await seedDependencyReviewOrg();
      const { sent, deliver } = webhookHarness();

      const { res, json } = await deliver({
        eventName: "pull_request",
        body: pullRequestPayload({
          installationId: seeded.installationExternalId,
          ...payloadOptions,
        }),
      });

      expect(res.status).toBe(200);
      expect(json.result).toBe("dependency_review_skipped");
      expect(sent).toEqual([
        {
          kind: "dependency_review",
          organizationId: seeded.organizationId,
          skip: {
            installationRowId: seeded.installation.id,
            repositoryId: 5151,
            repositoryFullName: "octo/example",
            headSha: sha("b"),
            fromFork,
            authorLogin: payloadOptions.authorLogin,
            senderLogin: payloadOptions.authorLogin,
          },
        },
      ]);
      expect(await reviewRows(seeded.organizationId)).toEqual([]);
    },
  );

  test.each([
    ["no settings row", { enabled: null }, {}, "dependency review is off"],
    ["settings turned off", { enabled: false }, {}, "dependency review is off"],
    ["a fork's head branch", {}, { headRepositoryId: 9999 }, "another repository"],
    ["a deleted fork (head.repo null)", {}, { headRepositoryId: null }, "another repository"],
    ["a suspended installation", { installationStatus: "suspended" }, {}, "not active"],
  ] as const)("ignores %s", async (_label, orgOptions, payloadOptions, reason) => {
    const seeded = await seedDependencyReviewOrg(orgOptions);
    const { sent, deliver } = webhookHarness();

    const { res, json } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({
        installationId: seeded.installationExternalId,
        ...payloadOptions,
      }),
    });

    expect(res.status).toBe(200);
    expect(json.result).toBe("ignored");
    expect(String(json.reason)).toContain(reason);
    expect(sent).toEqual([]);
    expect(await reviewRows(seeded.organizationId)).toEqual([]);
  });

  test("an installation Drydock never recorded is ignored", async () => {
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({ installationId: uniqueInstallationId() }),
    });

    expect(json).toMatchObject({ result: "ignored", reason: "installation not active" });
    expect(sent).toEqual([]);
  });

  test("a redelivered event re-enqueues a review that never finished, not one that did", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();
    const body = pullRequestPayload({ installationId: seeded.installationExternalId });

    const first = await deliver({ eventName: "pull_request", body });
    // Still queued: the first enqueue may have been lost.
    const second = await deliver({ eventName: "pull_request", body });
    const db = createDb(env.DB);
    await db
      .update(schema.dependencyReviews)
      .set({ status: "completed" })
      .where(eq(schema.dependencyReviews.id, String(first.json.reviewId)));
    const third = await deliver({ eventName: "pull_request", body });

    expect(first.json.created).toBe(true);
    expect(second.json).toMatchObject({
      result: "dependency_review_queued",
      created: false,
      reviewId: first.json.reviewId,
    });
    expect(third.json.created).toBe(false);
    expect(sent).toHaveLength(2);
    expect(await reviewRows(seeded.organizationId)).toHaveLength(1);
  });

  test("a running review past its claim lease is re-enqueued; a live one is not", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();
    const body = pullRequestPayload({ installationId: seeded.installationExternalId });
    const first = await deliver({ eventName: "pull_request", body });
    const setRunning = (updatedAt: Date) =>
      createDb(env.DB)
        .update(schema.dependencyReviews)
        .set({ status: "running", updatedAt })
        .where(eq(schema.dependencyReviews.id, String(first.json.reviewId)));

    await setRunning(new Date());
    await deliver({ eventName: "pull_request", body });
    await setRunning(new Date(Date.now() - 16 * 60 * 1000));
    await deliver({ eventName: "pull_request", body });

    expect(sent).toHaveLength(2);
  });

  test.each(["failed", "superseded"] as const)(
    "a reopened PR re-enqueues its %s review",
    async (status) => {
      const seeded = await seedDependencyReviewOrg();
      const { sent, deliver } = webhookHarness();
      const body = pullRequestPayload({ installationId: seeded.installationExternalId });
      const first = await deliver({ eventName: "pull_request", body });
      await createDb(env.DB)
        .update(schema.dependencyReviews)
        .set({ status })
        .where(eq(schema.dependencyReviews.id, String(first.json.reviewId)));

      await deliver({ eventName: "pull_request", body: { ...body, action: "reopened" } });

      expect(sent.map((message) => "reviewId" in message && message.reviewId)).toEqual([
        first.json.reviewId,
        first.json.reviewId,
      ]);
    },
  );

  test("a push to the PR records a review of the new head and leaves the old one to the job", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();

    const first = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({ installationId: seeded.installationExternalId }),
    });
    const second = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({
        installationId: seeded.installationExternalId,
        action: "synchronize",
        headSha: sha("d"),
      }),
    });

    expect(sent.map((message) => "reviewId" in message && message.reviewId)).toEqual([
      first.json.reviewId,
      second.json.reviewId,
    ]);
    // Deliveries can arrive out of order, so only the job, which reads the
    // PR's head, decides which review is stale.
    const rows = await reviewRows(seeded.organizationId);
    expect(rows.map((row) => row.status)).toEqual(["queued", "queued"]);
  });

  test("a closed PR is acknowledged without work", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();

    const { res, json } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({ installationId: seeded.installationExternalId, action: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, ignored: "unsupported_action" });
    expect(sent).toEqual([]);
  });

  test.each([
    [
      "no head sha",
      (body: ReturnType<typeof pullRequestPayload>) => {
        body.pull_request.head.sha = "not-a-sha";
      },
    ],
    [
      "no author",
      (body: ReturnType<typeof pullRequestPayload>) => {
        (body.pull_request as { user: unknown }).user = null;
      },
    ],
    [
      "no repository",
      (body: ReturnType<typeof pullRequestPayload>) => {
        (body as { repository: unknown }).repository = null;
      },
    ],
  ])("rejects a malformed payload with %s", async (_label, mutate) => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();
    const body = pullRequestPayload({ installationId: seeded.installationExternalId });
    mutate(body);

    const { res } = await deliver({ eventName: "pull_request", body });

    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
    expect(await reviewRows(seeded.organizationId)).toEqual([]);
  });

  // A budget without a native tier would put a D1 write on every PR event in
  // every installed repository.
  test("pull_request deliveries are bounded by a native rate-limit tier", async () => {
    const { overrides, limiter } = exhaustedRateLimitBindings();
    const seeded = await seedDependencyReviewOrg();
    const { deliver } = webhookHarness(overrides);

    const { res } = await deliver({
      eventName: "pull_request",
      body: pullRequestPayload({ installationId: seeded.installationExternalId }),
    });

    expect(limiter.keys).toEqual([`github-webhook:pull_request:${seeded.installationExternalId}`]);
    expect(res.status).toBe(429);
  });
});

describe("check_run deliveries", () => {
  test("Approve on Drydock's check enqueues an approval carrying the GitHub sender", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedReviewWithCheckRun(seeded, 777001);
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777001,
        sender: { login: "maintainer", id: 3141 },
      }),
    });

    expect(json).toMatchObject({
      result: "dependency_review_approval_requested",
      reviewId: review.id,
    });
    expect(sent).toEqual([
      {
        kind: "dependency_review",
        organizationId: seeded.organizationId,
        reviewId: review.id,
        approver: { login: "maintainer", githubId: 3141, checkRunId: 777001 },
      },
    ]);
  });

  test("a check run is matched to its review by external_id, not only the stored run id", async () => {
    const seeded = await seedDependencyReviewOrg();
    // A duplicate job created a second run; the review stored the other one.
    const review = await seedReviewWithCheckRun(seeded, 777010);
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777011,
        externalId: review.id,
        action: "rerequested",
      }),
    });

    expect(json).toMatchObject({ result: "dependency_review_rerequested", reviewId: review.id });
    expect(sent).toHaveLength(1);
  });

  test("Re-run on a skip a review replaced re-runs the review of that commit", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedReviewWithCheckRun(seeded, 777020);
    const { sent, deliver } = webhookHarness();

    const rerun = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777021,
        externalId: `skip:${sha("b")}`,
        action: "rerequested",
      }),
    });
    const approve = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777021,
        externalId: `skip:${sha("b")}`,
      }),
    });

    expect(rerun.json).toMatchObject({
      result: "dependency_review_rerequested",
      reviewId: review.id,
    });
    expect(approve.json.result).toBe("ignored");
    expect(sent).toHaveLength(1);
  });

  test("an external_id naming another installation's review is ignored", async () => {
    const seeded = await seedDependencyReviewOrg();
    const other = await seedDependencyReviewOrg();
    const foreign = await seedReviewWithCheckRun(other, 777012);
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777012,
        externalId: foreign.id,
      }),
    });

    expect(json.result).toBe("ignored");
    expect(sent).toEqual([]);
  });

  test("Re-run enqueues a plain re-review", async () => {
    const seeded = await seedDependencyReviewOrg();
    const review = await seedReviewWithCheckRun(seeded, 777002);
    const { sent, deliver } = webhookHarness();

    await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777002,
        action: "rerequested",
      }),
    });

    expect(sent).toEqual([
      {
        kind: "dependency_review",
        organizationId: seeded.organizationId,
        reviewId: review.id,
        rerun: true,
      },
    ]);
  });

  test.each([
    ["another app's check run", { appId: 99999 }, "another app"],
    ["an unknown check run", { checkRunId: 123456789 }, "no dependency review"],
    ["a check run on a different commit", { headSha: sha("e") }, "no dependency review"],
    ["an unknown action button", { identifier: "do-something-else" }, "unknown check run action"],
    ["an action with no sender id", { sender: { login: "maintainer", id: 0 } }, "no sender"],
  ] as const)("ignores %s", async (_label, overrides, reason) => {
    const seeded = await seedDependencyReviewOrg();
    await seedReviewWithCheckRun(seeded, 777003);
    const { sent, deliver } = webhookHarness();

    const { res, json } = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: seeded.installationExternalId,
        checkRunId: 777003,
        ...overrides,
      }),
    });

    expect(res.status).toBe(200);
    expect(json.result).toBe("ignored");
    expect(String(json.reason)).toContain(reason);
    expect(sent).toEqual([]);
  });

  test("another installation cannot reach a review through its check run id", async () => {
    const victim = await seedDependencyReviewOrg();
    await seedReviewWithCheckRun(victim, 777004);
    const attacker = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();

    const { json } = await deliver({
      eventName: "check_run",
      body: checkRunPayload({
        installationId: attacker.installationExternalId,
        checkRunId: 777004,
      }),
    });

    expect(json).toMatchObject({ result: "ignored" });
    expect(sent).toEqual([]);
  });

  test("a check_run payload without an app is rejected", async () => {
    const seeded = await seedDependencyReviewOrg();
    const { sent, deliver } = webhookHarness();
    const body = checkRunPayload({ installationId: seeded.installationExternalId, checkRunId: 1 });
    (body.check_run as { app: unknown }).app = null;

    const { res } = await deliver({ eventName: "check_run", body });

    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});
