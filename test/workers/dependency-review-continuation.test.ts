import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createDependencyReview,
  findApprovedChanges,
  isChangeApproved,
  recordDependencyApprovals,
  saveDependencyReviewSettings,
} from "../../server/db/dependency-reviews";
import * as schema from "../../server/db/schema";
import {
  DependencyReviewLeaseError,
  executeDependencyReviewJob,
} from "../../server/lib/dependency-review/job";
import { MAX_COLD_DIFFS_PER_PASS } from "../../server/lib/dependency-review/review-bumps";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type DependencyBump,
  type ReviewedBump,
} from "../../server/lib/dependency-review/types";
import type { DependencyReviewQueueMessage } from "../../server/lib/scan/job";
import {
  dependencyReviewJobEnv,
  fakePullRequest,
  npmLockfile,
  runDependencyReviewJob,
  seedDependencyReviewOrg,
  seedNpmDiff,
  sha,
  stubGithubApi,
  uniquePackageName,
  type FakePullRequest,
  type SeedDependencyReviewOrgOptions,
} from "./helpers/dependency-review";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY_MS = 24 * 60 * 60 * 1000;

interface SentMessage {
  body: DependencyReviewQueueMessage;
  options?: { delaySeconds?: number };
}

function capturingQueue() {
  const sent: SentMessage[] = [];
  const queue = {
    send: vi.fn(async (body: DependencyReviewQueueMessage, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    }),
  };
  return { sent, binding: queue as unknown as Queue };
}

async function readReview(reviewId: string) {
  const [row] = await createDb(env.DB)
    .select()
    .from(schema.dependencyReviews)
    .where(eq(schema.dependencyReviews.id, reviewId));
  return { ...row, bumps: JSON.parse(row.bumpsJson ?? "[]") as ReviewedBump[] };
}

function storedOutcomeCount(progressJson: string | null): number {
  if (!progressJson) return 0;
  const progress = JSON.parse(progressJson) as { bumps: Record<string, unknown> };
  return Object.keys(progress.bumps).length;
}

interface ScenarioOptions extends SeedDependencyReviewOrgOptions {
  before: Record<string, string>;
  after: Record<string, string>;
  pr?: Partial<FakePullRequest>;
}

async function scenario(options: ScenarioOptions) {
  const seeded = await seedDependencyReviewOrg(options);
  const pr = fakePullRequest(options.pr);
  pr.contents.set(`${pr.mergeBaseSha}:package-lock.json`, npmLockfile(options.before));
  pr.contents.set(`${pr.headSha}:package-lock.json`, npmLockfile(options.after));
  const api = stubGithubApi(pr);
  const { review } = await createDependencyReview(createDb(env.DB), {
    organizationId: seeded.organizationId,
    installationRowId: seeded.installation.id,
    repositoryId: 5151,
    repositoryFullName: `${pr.owner}/${pr.repo}`,
    pullNumber: pr.number,
    headSha: pr.headSha,
    authorLogin: "dependabot[bot]",
  });
  const queue = capturingQueue();
  const input = { organizationId: seeded.organizationId, reviewId: review.id };
  const run = (message: Omit<DependencyReviewQueueMessage, "kind"> = input) =>
    runDependencyReviewJob(message, { SCAN_QUEUE: queue.binding });
  return { seeded, pr, api, review, input, queue, run };
}

// `count` bumps 1.0.0 → 1.0.1 under one prefix; collect lists them by name.
function manyBumps(label: string, count: number) {
  const prefix = uniquePackageName(label);
  const names = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
  return {
    names,
    before: Object.fromEntries(names.map((name) => [name, "1.0.0"])),
    after: Object.fromEntries(names.map((name) => [name, "1.0.1"])),
  };
}

function registryNames(api: ReturnType<typeof stubGithubApi>, from = 0): string[] {
  return api.requests
    .slice(from)
    .filter((request) => request.host === "registry.npmjs.org")
    .map((request) => decodeURIComponent(new URL(request.url).pathname.slice(1)));
}

// Answers npm packument reads for `published` (name → version → publish
// time) and hands everything else to the GitHub double underneath.
function servePackuments(published: Record<string, Record<string, string>>) {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const versions = published[decodeURIComponent(url.pathname.slice(1))];
      if (url.host === "registry.npmjs.org" && versions) {
        return Response.json({
          name: decodeURIComponent(url.pathname.slice(1)),
          "dist-tags": { latest: Object.keys(versions).at(-1) },
          versions: Object.fromEntries(
            Object.keys(versions).map((version) => [
              version,
              { dist: { tarball: `https://registry.npmjs.org/x/-/x-${version}.tgz` } },
            ]),
          ),
          time: versions,
        });
      }
      return inner(input, init);
    }),
  );
}

describe("dependency review continuation", () => {
  test("a review over the cold-diff budget continues on the same in-progress run", async () => {
    const { names, before, after } = manyBumps("passes", MAX_COLD_DIFFS_PER_PASS + 5);
    const cached = manyBumps("cached", 10);
    for (const name of cached.names) await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    const { api, review, queue, run } = await scenario({
      before: { ...before, ...cached.before },
      after: { ...after, ...cached.after },
    });

    await run();

    // Cached pairs cost nothing; forty cold pairs spent the pass.
    expect(registryNames(api)).toHaveLength(MAX_COLD_DIFFS_PER_PASS);
    const between = await readReview(review.id);
    expect(between).toMatchObject({ status: "queued", conclusion: null });
    expect(storedOutcomeCount(between.progressJson)).toBe(MAX_COLD_DIFFS_PER_PASS + 10);
    expect(queue.sent).toEqual([
      {
        body: {
          kind: "dependency_review",
          organizationId: review.organizationId,
          reviewId: review.id,
          continuation: true,
        },
        options: { delaySeconds: 10 },
      },
    ]);
    expect(api.checkRunCreates).toHaveLength(1);
    const progress = api.lastCheckRunState();
    expect(progress).toMatchObject({
      status: "in_progress",
      output: {
        summary: expect.stringContaining(
          `Reviewed ${MAX_COLD_DIFFS_PER_PASS + 10} of ${MAX_COLD_DIFFS_PER_PASS + 15} updates so far`,
        ),
      },
    });
    // Nothing can be approved, and nothing completes, while passes remain.
    expect(progress).not.toHaveProperty("conclusion");
    expect(progress?.actions ?? []).toEqual([]);

    const sentBefore = api.requests.length;
    await run(queue.sent[0].body);

    // A not-found outcome is not cached by the public diff, but the stored
    // progress keeps the second pass from asking again, and the stored
    // collection keeps it from reading the lockfiles again.
    expect(registryNames(api, sentBefore).sort()).toEqual(names.slice(MAX_COLD_DIFFS_PER_PASS));
    expect(api.requests.slice(sentBefore).some((r) => r.url.includes("/contents/"))).toBe(false);
    const done = await readReview(review.id);
    expect(done).toMatchObject({
      status: "completed",
      conclusion: "held",
      bumpCount: MAX_COLD_DIFFS_PER_PASS + 15,
      heldCount: MAX_COLD_DIFFS_PER_PASS + 5,
      progressJson: null,
      checkRunId: api.checkRunCreates[0].id,
    });
    expect(api.checkRunCreates).toHaveLength(1);
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: api.checkRunCreates[0].id,
      body: { status: "completed", conclusion: "action_required" },
    });
    expect(queue.sent).toHaveLength(1);
  });

  test("a pass whose worker died resumes from the outcomes it stored", async () => {
    const { names, before, after } = manyBumps("resume", MAX_COLD_DIFFS_PER_PASS + 5);
    const { api, review, input, queue } = await scenario({ before, after });
    // Stall the first pass from its 8th cold diff on, as if the platform killed it there.
    let registryCalls = 0;
    let stalling = true;
    let reachedPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : String(request);
        if (url.startsWith("https://registry.npmjs.org/")) {
          registryCalls += 1;
          // From the 8th on every diff stalls; once all four workers are
          // stalled, the pass writes nothing more.
          if (stalling && registryCalls >= 8) {
            if (registryCalls === 11) reachedPause();
            await resumed;
          }
        }
        return inner(request, init);
      }),
    );
    const ctx = createExecutionContext();
    const original = executeDependencyReviewJob(
      dependencyReviewJobEnv({ SCAN_QUEUE: queue.binding }),
      ctx,
      input,
      { finalAttempt: true },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    await paused;

    // Each finished cold diff is written at once, not only at the pass's end.
    const midPass = await readReview(review.id);
    expect(storedOutcomeCount(midPass.progressJson)).toBeGreaterThanOrEqual(7);
    // Diffs the dead pass started but never finished are stored as started
    // (`coldStarts`) and may run again; finished ones never do.
    const midBumps = (
      JSON.parse(midPass.progressJson ?? "{}") as {
        bumps: Record<string, { evidence?: unknown; unreviewed?: unknown; coldStarts?: number }>;
      }
    ).bumps;
    const stored = Object.entries(midBumps)
      .filter(([, entry]) => entry.evidence || entry.unreviewed)
      .map(([key]) => key.split("\u0000")[1]);
    expect(Object.values(midBumps).some((entry) => entry.coldStarts && !entry.evidence)).toBe(true);
    const firstRun = api.checkRunCreates[0].id;
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ updatedAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(schema.dependencyReviews.id, review.id));

    stalling = false;
    // The queue's redelivery reclaims the expired lease and continues.
    const sentBefore = api.requests.length;
    await runDependencyReviewJob(input, { SCAN_QUEUE: queue.binding });
    const askedAgain = registryNames(api, sentBefore).filter((name) => stored.includes(name));
    expect(askedAgain).toEqual([]);
    expect(api.checkRunUpdates.find((run) => run.id === firstRun)?.body).toMatchObject({
      conclusion: "cancelled",
    });

    // The dead pass wakes up and finds a newer claim: it writes nothing more,
    // reopens no run, and queues nothing.
    const replacement = await readReview(review.id);
    const oldRunUpdates = api.checkRunUpdates.filter((run) => run.id === firstRun).length;
    const sends = queue.sent.length;
    resume();
    expect(await original).toBeNull();
    await waitOnExecutionContext(ctx);
    expect(api.checkRunUpdates.filter((run) => run.id === firstRun)).toHaveLength(oldRunUpdates);
    expect(queue.sent).toHaveLength(sends);
    const after2 = await readReview(review.id);
    expect(after2.attempt).toBe(replacement.attempt);
    expect(after2.progressJson).toBe(replacement.progressJson);
    expect(after2.status).toBe(replacement.status);
    expect(names).toHaveLength(MAX_COLD_DIFFS_PER_PASS + 5);
  });

  test("a pass that starts past the pass bound fails the review with a clear result", async () => {
    const { before, after } = manyBumps("bound", MAX_COLD_DIFFS_PER_PASS + 5);
    const { api, review, queue, run } = await scenario({ before, after });
    await run();
    const between = await readReview(review.id);
    // Every pass since was killed: the count reached the bound with no pass ending.
    const progress = JSON.parse(between.progressJson ?? "{}") as { passes: number };
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ progressJson: JSON.stringify({ ...progress, passes: 50 }) })
      .where(eq(schema.dependencyReviews.id, review.id));
    const sentBefore = api.requests.length;

    await run(queue.sent[0].body);

    expect(registryNames(api, sentBefore)).toEqual([]);
    expect(await readReview(review.id)).toMatchObject({
      status: "failed",
      failureReason: "DependencyReviewPassLimitError",
      progressJson: null,
    });
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: api.checkRunCreates[0].id,
      body: {
        status: "completed",
        conclusion: "failure",
        output: { summary: expect.stringContaining("passes kept ending before they finished") },
      },
    });
    expect(queue.sent).toHaveLength(1);
  });

  test("a pass on a commit that stopped being the head spends nothing and cancels its run", async () => {
    const { before, after } = manyBumps("rebased", MAX_COLD_DIFFS_PER_PASS + 5);
    const { pr, api, review, queue, run } = await scenario({ before, after });
    await run();
    const continuation = queue.sent[0].body;

    pr.headSha = sha("d");
    const sentBefore = api.requests.length;
    await run(continuation);

    expect(registryNames(api, sentBefore)).toEqual([]);
    expect(api.requests.slice(sentBefore).some((r) => r.url.includes("/contents/"))).toBe(false);
    expect(await readReview(review.id)).toMatchObject({ status: "superseded", progressJson: null });
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: api.checkRunCreates[0].id,
      body: { status: "completed", conclusion: "cancelled" },
    });

    // A duplicate continuation never restarts a superseded review.
    const updates = api.checkRunUpdates.length;
    await run(continuation);
    expect(api.checkRunCreates).toHaveLength(1);
    expect(api.checkRunUpdates).toHaveLength(updates);
  });

  test("Re-run between passes starts over on the same in-progress run", async () => {
    const { names, before, after } = manyBumps("rerun", MAX_COLD_DIFFS_PER_PASS + 5);
    const { api, review, input, queue, run } = await scenario({ before, after });
    await run();
    const sentBefore = api.requests.length;

    await run({ ...input, rerun: true });

    // Progress was discarded, so the first names are diffed again.
    expect(registryNames(api, sentBefore)).toContain(names[0]);
    expect(api.checkRunCreates).toHaveLength(1);
    const row = await readReview(review.id);
    expect(row.status).toBe("queued");
    expect(JSON.parse(row.progressJson ?? "{}")).toMatchObject({ passes: 1 });

    // The first attempt's leftover continuation joins the new attempt.
    await run(queue.sent[0].body);
    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      conclusion: "held",
      bumpCount: MAX_COLD_DIFFS_PER_PASS + 5,
    });
    expect(api.checkRunCreates).toHaveLength(1);
  });

  test("an Approve click while passes remain changes nothing", async () => {
    const { before, after } = manyBumps("approve-early", MAX_COLD_DIFFS_PER_PASS + 5);
    const { api, review, input, run } = await scenario({ before, after });
    await run();
    const updates = api.checkRunUpdates.length;

    await run({
      ...input,
      approver: { login: "octocat", githubId: 1, checkRunId: api.checkRunCreates[0].id },
    });

    expect(api.checkRunUpdates).toHaveLength(updates);
    expect(await readReview(review.id)).toMatchObject({ status: "queued", conclusion: null });
  });
});

describe("dependency review age recheck", () => {
  async function ageHeldReview(options: { publishedDaysAgo: number | null }) {
    const name = uniquePackageName("young");
    const setup = await scenario({ before: {}, after: { [name]: "1.0.0" }, policy: AGE_ONLY });
    if (options.publishedDaysAgo !== null) {
      servePackuments({
        [name]: { "1.0.0": new Date(Date.now() - options.publishedDaysAgo * DAY_MS).toISOString() },
      });
    }
    await setup.run();
    return { ...setup, name };
  }

  // The defaults: no switch holds a new package, so the age fallback decides.
  const AGE_ONLY = { ...DEFAULT_DEPENDENCY_REVIEW_POLICY };

  test("a review held only by age schedules a recheck for when the hold passes", async () => {
    const { api, review, queue } = await ageHeldReview({ publishedDaysAgo: 2 });

    const row = await readReview(review.id);
    expect(row).toMatchObject({ status: "completed", conclusion: "held", heldCount: 1 });
    const verdict = row.bumps[0].verdict;
    expect(verdict).toMatchObject({ status: "hold", reasons: ["too-new"] });
    const passesAt = verdict.status === "hold" ? verdict.passesAt : undefined;
    expect(passesAt).toBeDefined();
    expect(api.lastCheckRunState()).toMatchObject({
      conclusion: "action_required",
      output: { summary: expect.stringContaining("younger than the minimum age") },
    });
    // A day away is past the queue's 12-hour delay cap, so it hops.
    expect(queue.sent).toEqual([
      {
        body: {
          kind: "dependency_review",
          organizationId: review.organizationId,
          reviewId: review.id,
          recheck: { checkRunId: row.checkRunId, at: passesAt },
        },
        options: { delaySeconds: 12 * 60 * 60 },
      },
    ]);
  });

  test("an unknown publish time holds until approved and schedules nothing", async () => {
    const { review, queue } = await ageHeldReview({ publishedDaysAgo: null });

    const row = await readReview(review.id);
    expect(row.bumps[0].verdict).toMatchObject({ status: "hold", reasons: ["too-new"] });
    expect(row.bumps[0].verdict).not.toHaveProperty("passesAt");
    expect(queue.sent).toEqual([]);
  });

  test("an early recheck hops again without touching GitHub", async () => {
    const { api, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
    const recheck = queue.sent[0].body;
    const requests = api.requests.length;

    await run(recheck);

    expect(api.requests).toHaveLength(requests);
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[1].body).toEqual(recheck);
    expect(queue.sent[1].options?.delaySeconds).toBeLessThanOrEqual(12 * 60 * 60);
  });

  test("a due recheck re-runs the review against the current policy", async () => {
    const { seeded, api, review, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
    const recheck = queue.sent[0].body;
    const heldRun = api.checkRunCreates[0].id;
    await saveDependencyReviewSettings(
      createDb(env.DB),
      seeded.organizationId,
      { enabled: true, policy: { ...AGE_ONLY, unreadMinimumAgeDays: 1 }, extraBotLogins: [] },
      seeded.userId,
    );

    await run({ ...recheck, recheck: { ...recheck.recheck!, at: new Date().toISOString() } });

    expect(api.checkRunCreates).toHaveLength(2);
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: api.checkRunCreates[1].id,
      body: { status: "completed", conclusion: "success" },
    });
    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      conclusion: "clear",
      checkRunId: api.checkRunCreates[1].id,
    });
    // The held run stays as history; nothing cancels it.
    expect(
      api.checkRunUpdates.filter((u) => u.id === heldRun).map((u) => u.body.conclusion),
    ).toEqual(["action_required"]);
  });

  test.each(["closed", "rebased"])(
    "a recheck for a %s PR leaves its finished check alone",
    async (change) => {
      const { pr, api, review, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
      const recheck = queue.sent[0].body;
      if (change === "closed") pr.state = "closed";
      else pr.headSha = sha("e");
      const creates = api.checkRunCreates.length;
      const updates = api.checkRunUpdates.length;
      const before = await readReview(review.id);

      await run({ ...recheck, recheck: { ...recheck.recheck!, at: new Date().toISOString() } });

      expect(api.checkRunCreates).toHaveLength(creates);
      expect(api.checkRunUpdates).toHaveLength(updates);
      expect(await readReview(review.id)).toMatchObject({
        status: "completed",
        conclusion: "held",
        checkRunId: before.checkRunId,
        attempt: before.attempt,
      });
    },
  );

  test("a recheck released for a retry is resumed by its redelivery, not stranded", async () => {
    const { pr, api, review, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
    const recheck = queue.sent[0].body;
    const due = { ...recheck, recheck: { ...recheck.recheck!, at: new Date().toISOString() } };
    pr.filesStatus = 502;
    const ctx = createExecutionContext();

    await expect(
      executeDependencyReviewJob(dependencyReviewJobEnv({ SCAN_QUEUE: queue.binding }), ctx, due, {
        finalAttempt: false,
      }),
    ).rejects.toThrow();
    await waitOnExecutionContext(ctx);
    const recheckRun = api.checkRunCreates[1].id;
    expect(await readReview(review.id)).toMatchObject({ status: "queued", checkRunId: recheckRun });

    pr.filesStatus = undefined;
    await run(due);

    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      conclusion: "held",
      checkRunId: recheckRun,
    });
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: recheckRun,
      body: { status: "completed", conclusion: "action_required" },
    });
    // Approvable again, and rechecked again when the hold passes.
    expect(queue.sent.at(-1)?.body.recheck?.checkRunId).toBe(recheckRun);
  });

  test("a recheck pass the platform killed is recovered by its redelivery after the lease", async () => {
    const { api, review, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
    const recheck = queue.sent[0].body;
    const due = { ...recheck, recheck: { ...recheck.recheck!, at: new Date().toISOString() } };
    let stalling = true;
    let reached!: () => void;
    const reachedRegistry = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : String(request);
        if (stalling && url.startsWith("https://registry.npmjs.org/")) {
          reached();
          await released;
        }
        return inner(request, init);
      }),
    );
    const ctx = createExecutionContext();
    const killed = executeDependencyReviewJob(
      dependencyReviewJobEnv({ SCAN_QUEUE: queue.binding }),
      ctx,
      due,
      { finalAttempt: true },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    await reachedRegistry;
    const recheckRun = api.checkRunCreates[1].id;
    expect(await readReview(review.id)).toMatchObject({
      status: "running",
      checkRunId: recheckRun,
    });

    // Redelivered inside the lease: retried later rather than acknowledged.
    const early = createExecutionContext();
    await expect(
      executeDependencyReviewJob(
        dependencyReviewJobEnv({ SCAN_QUEUE: queue.binding }),
        early,
        due,
        {
          finalAttempt: false,
        },
      ),
    ).rejects.toBeInstanceOf(DependencyReviewLeaseError);
    await waitOnExecutionContext(early);

    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ updatedAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(schema.dependencyReviews.id, review.id));
    stalling = false;
    await run(due);

    const done = await readReview(review.id);
    expect(done).toMatchObject({ status: "completed", conclusion: "held" });
    expect(done.checkRunId).toBe(api.checkRunCreates.at(-1)?.id);
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: done.checkRunId,
      body: { status: "completed", conclusion: "action_required" },
    });
    expect(
      api.checkRunUpdates.filter((u) => u.id === recheckRun).map((u) => u.body.conclusion),
    ).toContain("cancelled");

    release();
    expect(await killed).toBeNull();
    await waitOnExecutionContext(ctx);
    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      checkRunId: done.checkRunId,
      attempt: done.attempt,
    });
  });

  test("a recheck for a review that is no longer the held result does nothing", async () => {
    const { api, review, queue, run } = await ageHeldReview({ publishedDaysAgo: 2 });
    const recheck = queue.sent[0].body;
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ conclusion: "approved" })
      .where(eq(schema.dependencyReviews.id, review.id));
    const requests = api.requests.length;

    await run({ ...recheck, recheck: { ...recheck.recheck!, at: new Date().toISOString() } });
    // Scheduled for a run a Re-run has since replaced.
    await run({ ...recheck, recheck: { checkRunId: 1, at: new Date().toISOString() } });

    expect(api.requests).toHaveLength(requests);
    expect(queue.sent).toHaveLength(1);
  });
});

describe("approvals of mirror-resolved bumps", () => {
  const base = (name: string, overrides: Partial<DependencyBump> = {}): DependencyBump => ({
    ecosystem: "npm",
    name,
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    direct: true,
    lockfilePath: "package-lock.json",
    ...overrides,
  });
  const unproven = (name: string, toHash: string) =>
    base(name, {
      privateSource: true,
      mirror: { fromHashes: ["sha512-from"], toHashes: [toHash] },
    });

  test("an unproven mirror pin's approval covers those bytes only", async () => {
    const seeded = await seedDependencyReviewOrg();
    const db = createDb(env.DB);
    const name = uniquePackageName("mirror-pin");
    const approvedPin = unproven(name, "sha512-original");
    const { review } = await createDependencyReview(db, {
      organizationId: seeded.organizationId,
      installationRowId: seeded.installation.id,
      repositoryId: 5151,
      repositoryFullName: "octo/example",
      pullNumber: 1,
      headSha: sha("f"),
      authorLogin: "dependabot[bot]",
    });
    await recordDependencyApprovals(db, {
      organizationId: seeded.organizationId,
      repositoryId: 5151,
      reviewId: review.id,
      approvedByLogin: "octocat",
      approvedByGithubId: 1,
      bumps: [approvedPin],
    });

    const repinned = unproven(name, "sha512-swapped");
    const plainPrivate = base(name, { privateSource: true });
    const proven = { ...base(name), viaMirror: true as const };
    const approved = await findApprovedChanges(db, seeded.organizationId, 5151, [
      approvedPin,
      repinned,
      plainPrivate,
      proven,
    ]);

    expect(isChangeApproved(approved, approvedPin)).toBe(true);
    // Same versions, other bytes on the mirror: a different change.
    expect(isChangeApproved(approved, repinned)).toBe(false);
    expect(isChangeApproved(approved, plainPrivate)).toBe(false);
    // A proven mirror bump is the public change, which nobody approved here.
    expect(isChangeApproved(approved, proven)).toBe(false);
  });
});
