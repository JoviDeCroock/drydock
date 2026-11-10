import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { claimDependencyReview, createDependencyReview } from "../../server/db/dependency-reviews";
import {
  DependencyReviewLeaseError,
  executeDependencyReviewJob,
} from "../../server/lib/dependency-review/job";
import * as schema from "../../server/db/schema";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type ReviewedBump,
} from "../../server/lib/dependency-review/types";
import type { QueueMessage } from "../../server/lib/scan/job";
import { queue } from "../../server/queue";
import {
  dependencyReviewJobEnv,
  fakePullRequest,
  npmLockfile,
  runDependencyReviewJob,
  seedDependencyReviewOrg,
  seedNpmDiff,
  setPublishTimes,
  sha,
  stubGithubApi,
  uniquePackageName,
  type FakePullRequest,
  type GithubApiDouble,
  type SeedDependencyReviewOrgOptions,
} from "./helpers/dependency-review";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Seeded = Awaited<ReturnType<typeof seedDependencyReviewOrg>>;

async function seedReview(seeded: Seeded, pr: FakePullRequest) {
  const { review } = await createDependencyReview(createDb(env.DB), {
    organizationId: seeded.organizationId,
    installationRowId: seeded.installation.id,
    repositoryId: 5151,
    repositoryFullName: `${pr.owner}/${pr.repo}`,
    pullNumber: pr.number,
    headSha: pr.headSha,
    authorLogin: "dependabot[bot]",
  });
  return review;
}

function setLockfiles(
  pr: FakePullRequest,
  before: Record<string, string>,
  after: Record<string, string>,
) {
  pr.contents.set(`${pr.mergeBaseSha}:package-lock.json`, npmLockfile(before));
  pr.contents.set(`${pr.headSha}:package-lock.json`, npmLockfile(after));
}

async function readReview(reviewId: string) {
  const [row] = await createDb(env.DB)
    .select()
    .from(schema.dependencyReviews)
    .where(eq(schema.dependencyReviews.id, reviewId));
  return { ...row, bumps: JSON.parse(row.bumpsJson ?? "[]") as ReviewedBump[] };
}

async function approvals(organizationId: string) {
  return createDb(env.DB)
    .select()
    .from(schema.dependencyReviewApprovals)
    .where(eq(schema.dependencyReviewApprovals.organizationId, organizationId));
}

async function auditEvents(organizationId: string, type: string) {
  return createDb(env.DB)
    .select()
    .from(schema.scanEvents)
    .where(
      and(eq(schema.scanEvents.organizationId, organizationId), eq(schema.scanEvents.type, type)),
    );
}

// The installation token must never leave api.github.com, and nothing the job
// fetched may fall outside the double's known routes.
function expectTokenStaysOnGithub(api: GithubApiDouble) {
  expect(api.tokenHosts()).toEqual(["api.github.com"]);
  expect(api.unexpected).toEqual([]);
  for (const request of api.requests) {
    if (request.host !== "api.github.com") expect(request.authorization).toBeNull();
  }
}

interface ScenarioOptions extends SeedDependencyReviewOrgOptions {
  before?: Record<string, string>;
  after?: Record<string, string>;
  pr?: Partial<FakePullRequest>;
}

// One PR bumping `name` 1.0.0 → 1.0.1, reviewed end to end.
const CORP_REGISTRY = "https://npm.corp.example/";

async function scenario(options: ScenarioOptions = {}) {
  const seeded = await seedDependencyReviewOrg(options);
  const pr = fakePullRequest(options.pr);
  const name = uniquePackageName("pkg");
  setLockfiles(pr, options.before ?? { [name]: "1.0.0" }, options.after ?? { [name]: "1.0.1" });
  const api = stubGithubApi(pr);
  const review = await seedReview(seeded, pr);
  const input = { organizationId: seeded.organizationId, reviewId: review.id };
  return { seeded, pr, name, api, review, input };
}

const INSTALL_SCRIPT = {
  fromPackageJson: { name: "x", version: "1.0.0", scripts: {} },
  toPackageJson: { name: "x", version: "1.0.1", scripts: { postinstall: "node setup.js" } },
};

describe("dependency review job", () => {
  test("a code-only PR succeeds with an explicit no-dependency-changes result", async () => {
    const { api, review, input } = await scenario({
      pr: { files: [{ filename: "src/app.ts", status: "modified" }] },
    });

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      conclusion: "clear",
      bumpCount: 0,
      heldCount: 0,
    });
    expect(api.lastCheckRunState()).toMatchObject({
      conclusion: "success",
      output: {
        title: "No npm or PyPI dependency updates",
        summary:
          "This PR adds no npm or PyPI dependencies and changes no resolved npm or PyPI package versions. Other ecosystems are not reviewed.",
      },
    });
    expect(api.requests.some((r) => r.url.includes("/contents/"))).toBe(false);
    expectTokenStaysOnGithub(api);
  });

  test.each(["unchanged", "removal only"])(
    "%s lockfile dependencies succeed without diffing package releases",
    async (change) => {
      const name = uniquePackageName("no-update");
      const { api, review, input } = await scenario({
        before: { [name]: "1.0.0" },
        after: change === "unchanged" ? { [name]: "1.0.0" } : {},
      });

      await runDependencyReviewJob(input);

      expect(await readReview(review.id)).toMatchObject({ conclusion: "clear", bumpCount: 0 });
      expect(api.lastCheckRunState()).toMatchObject({
        conclusion: "success",
        output: { title: "No npm or PyPI dependency updates" },
      });
      expect(api.requests.every((r) => r.host === "api.github.com")).toBe(true);
      expectTokenStaysOnGithub(api);
    },
  );

  test("a bump with nothing to hold completes the check as success", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect(api.checkRunCreates).toHaveLength(1);
    expect(api.checkRunCreates[0].body).toMatchObject({
      name: "Drydock dependency review",
      head_sha: sha("b"),
      external_id: review.id,
      status: "in_progress",
    });
    expect(api.lastCheckRunState()).toMatchObject({
      status: "completed",
      conclusion: "success",
      actions: [],
    });
    expect(api.checkRunUpdates.at(-1)?.id).toBe(api.checkRunCreates[0].id);
    const row = await readReview(review.id);
    expect(row).toMatchObject({
      status: "completed",
      conclusion: "clear",
      bumpCount: 1,
      heldCount: 0,
      checkRunId: api.checkRunCreates[0].id,
    });
    expect(row.bumps[0]).toMatchObject({
      bump: { ecosystem: "npm", name, fromVersion: "1.0.0", toVersion: "1.0.1", direct: true },
      verdict: { status: "clear" },
      approved: false,
    });
    // The lockfile is read at the merge base, not the base branch tip.
    expect(
      api.requests.some((r) => r.url.includes(`/contents/package-lock.json?ref=${sha("c")}`)),
    ).toBe(true);
    expect(api.requests.some((r) => r.url.includes(`ref=${sha("a")}`))).toBe(false);
    expectTokenStaysOnGithub(api);
  });

  test("a bump that adds an install script holds the check with an Approve action", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1", ...INSTALL_SCRIPT });

    await runDependencyReviewJob(input);

    const state = api.lastCheckRunState();
    expect(state).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(state?.actions).toEqual([
      expect.objectContaining({ identifier: "approve-holds", label: expect.any(String) }),
    ]);
    const row = await readReview(review.id);
    expect(row).toMatchObject({ status: "completed", conclusion: "held", heldCount: 1 });
    expect(row.bumps[0].verdict).toMatchObject({
      status: "hold",
      reasons: ["install-script-added"],
    });
    expectTokenStaysOnGithub(api);
  });

  test("a young package beneath a newly added one holds; the release adding it does not", async () => {
    const host = uniquePackageName("host");
    const carrier = uniquePackageName("carrier");
    const payload = uniquePackageName("payload");
    const { api, review, input } = await scenario({
      before: { [host]: "1.0.0" },
      after: { [host]: "1.0.1", [carrier]: "2.0.0", [payload]: "1.0.0" },
    });
    await seedNpmDiff({
      name: host,
      from: "1.0.0",
      to: "1.0.1",
      fromPackageJson: { name: host, version: "1.0.0" },
      toPackageJson: { name: host, version: "1.0.1", dependencies: { [carrier]: "^2.0.0" } },
    });
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    setPublishTimes(carrier, { "2.0.0": daysAgo(200) });
    const yesterday = daysAgo(1);
    setPublishTimes(payload, { "1.0.0": yesterday });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row).toMatchObject({ conclusion: "held", heldCount: 1 });
    const byName = (name: string) => row.bumps.find((b) => b.bump.name === name);
    expect(byName(host)).toMatchObject({
      bump: { lockfilePinsTree: true },
      verdict: { status: "clear", evidence: { dependenciesAdded: 1 } },
    });
    expect(byName(carrier)?.verdict).toEqual({ status: "new-package" });
    expect(byName(payload)?.verdict).toEqual({
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      young: { why: "first-published", at: yesterday },
    });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(JSON.stringify(api.lastCheckRunState())).toContain(
      `\`${payload}\` \`1.0.0\`: a package new to the lockfile, first published`,
    );
    expectTokenStaysOnGithub(api);
  });

  test("a release adding a dependency on a long-published package passes", async () => {
    const dependency = uniquePackageName("old-dep");
    const host = uniquePackageName("host");
    const { api, review, input } = await scenario({
      before: { [host]: "1.0.0" },
      after: { [host]: "1.0.1", [dependency]: "2.0.0" },
    });
    await seedNpmDiff({
      name: host,
      from: "1.0.0",
      to: "1.0.1",
      fromPackageJson: { name: host, version: "1.0.0" },
      toPackageJson: { name: host, version: "1.0.1", dependencies: { [dependency]: "^2.0.0" } },
    });
    setPublishTimes(dependency, {
      "2.0.0": new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row).toMatchObject({ status: "completed", conclusion: "clear", heldCount: 0 });
    expect(row.bumps.find((b) => b.bump.name === host)?.verdict).toMatchObject({
      status: "clear",
      evidence: { dependenciesAdded: 1 },
    });
    expect(row.bumps.find((b) => b.bump.name === dependency)?.verdict).toEqual({
      status: "new-package",
    });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
  });

  test("a native binary matched by extension holds as a native binary only", async () => {
    const { name, review, input } = await scenario();
    await seedNpmDiff({
      name,
      from: "1.0.0",
      to: "1.0.1",
      diff: [{ path: "prebuilds/addon.node", status: "added", flags: ["binary"] }],
    });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.bumps[0].verdict).toMatchObject({
      status: "hold",
      reasons: ["native-binary-added"],
    });
  });

  test("high release risk holds under the default policy", async () => {
    const { name, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1", releaseRisk: "high" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).bumps[0].verdict).toMatchObject({
      status: "hold",
      reasons: ["release-risk"],
    });
  });

  test("cached pairs cost no cold-diff budget, so 40 cached and one cold finish in one pass", async () => {
    const prefix = uniquePackageName("cap");
    const names = Array.from({ length: 41 }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
    const { api, review, input } = await scenario({
      before: Object.fromEntries(names.map((n) => [n, "1.0.0"])),
      after: Object.fromEntries(names.map((n) => [n, "1.0.1"])),
    });
    for (const n of names.slice(0, 40)) await seedNpmDiff({ name: n, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row).toMatchObject({ conclusion: "held", bumpCount: 41, heldCount: 1 });
    expect(row.bumps.filter((b) => b.verdict.status === "clear")).toHaveLength(40);
    // Holds are stored first, so a capped list never drops one. The one cold
    // pair reaches the stubbed registry, whose tarballs are missing.
    expect(row.bumps[0]).toMatchObject({
      bump: { name: names[40] },
      verdict: { status: "hold", reasons: ["unreviewed"], unreviewed: "failed" },
    });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    // Every pin is proven from its packument; only the cold pair downloads.
    const downloads = api.requests.filter(
      (r) => r.host === "registry.npmjs.org" && r.url.endsWith(".tgz"),
    );
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.every((r) => r.url.includes(names[40]))).toBe(true);
    expectTokenStaysOnGithub(api);
  });

  test("a release whose tarballs can't be downloaded is held as a failed diff", async () => {
    const { name, api, review, input } = await scenario();

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.bumps[0].verdict).toMatchObject({
      status: "hold",
      reasons: ["unreviewed"],
      unreviewed: "failed",
    });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    const registryCalls = api.requests.filter((r) => r.host === "registry.npmjs.org");
    expect(registryCalls.length).toBeGreaterThan(0);
    expect(registryCalls.every((r) => r.url.includes(name))).toBe(true);
    expectTokenStaysOnGithub(api);
  });

  test("with holdOnUnreviewed and the age fallback off, a failed diff no longer blocks the check", async () => {
    const { api, review, input } = await scenario({
      policy: { holdOnUnreviewed: false, unreadMinimumAgeDays: null },
    });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.bumps[0].verdict).toEqual({ status: "unreviewed", unreviewed: "failed" });
    expect(row).toMatchObject({ conclusion: "clear", heldCount: 0 });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
  });

  test("a self-hosted install with a custom NPM_REGISTRY never diffs against public registries", async () => {
    const { name, api, review, input } = await scenario();
    // Even a warm cache entry must not be read as a verdict for a private install.
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input, { NPM_REGISTRY: "https://npm.internal.example" });

    // With no public egress the lockfile's pin can't be proven either.
    const row = await readReview(review.id);
    expect(row.bumps[0].verdict).toMatchObject({
      status: "hold",
      reasons: ["unreviewed"],
      unreviewed: "unverified-pin",
    });
    expect(row.conclusion).toBe("held");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(api.requests.map((r) => r.host).filter((host) => host !== "api.github.com")).toEqual([]);
    expectTokenStaysOnGithub(api);
  });

  test("names a committed .npmrc sends to a private registry hold as private, never diffed", async () => {
    const publicName = uniquePackageName("pub");
    const privateName = `@corp/${uniquePackageName("internal")}`;
    const { pr, api, review, input } = await scenario({
      before: { [publicName]: "1.0.0", [privateName]: "2.0.0" },
      after: { [publicName]: "1.0.1", [privateName]: "2.0.1" },
      // Only a registry the organization lists is private; any other is remote.
      policy: { privateRegistries: [CORP_REGISTRY] },
    });
    pr.contents.set(`${pr.headSha}:.npmrc`, "@corp:registry=https://npm.corp.example/\n");
    await seedNpmDiff({ name: publicName, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row).toMatchObject({ conclusion: "held", bumpCount: 2, heldCount: 1 });
    expect(row.bumps.find((b) => b.bump.name === privateName)).toMatchObject({
      bump: { privateSource: true },
      verdict: { status: "hold", reasons: ["unreviewed"], unreviewed: "private-source" },
    });
    expect(row.bumps.find((b) => b.bump.name === publicName)?.verdict.status).toBe("clear");
    // The .npmrc is read at the PR head, the config that ships with the change.
    expect(api.requests.some((r) => r.url.endsWith(`/contents/.npmrc?ref=${sha("b")}`))).toBe(true);
    const offGithub = api.requests.filter((r) => r.host !== "api.github.com");
    expect(offGithub.filter((r) => r.url.includes("corp"))).toEqual([]);
    const summary = String((api.lastCheckRunState()?.output as { summary?: string })?.summary);
    expect(summary).toContain(`\`${privateName}\``);
    expect(summary).not.toMatch(/\/diff\/[^)\s]*corp/);
    expectTokenStaysOnGithub(api);
  });

  test("an unscoped private registry in .npmrc holds every npm bump as private", async () => {
    const { pr, api, review, input } = await scenario();
    pr.contents.set(`${pr.headSha}:.npmrc`, "registry=https://npm.corp.example/\n");

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ conclusion: "held", heldCount: 1 });
    expect(api.requests.filter((r) => r.host === "registry.npmjs.org")).toEqual([]);
  });

  test("with holdOnUnreviewed off, private bumps are listed and pass", async () => {
    const { pr, review, input } = await scenario({
      policy: { holdOnUnreviewed: false, privateRegistries: [CORP_REGISTRY] },
    });
    pr.contents.set(`${pr.headSha}:.npmrc`, "registry=https://npm.corp.example/\n");

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row).toMatchObject({ conclusion: "clear", bumpCount: 1 });
    expect(row.bumps[0].verdict).toEqual({ status: "unreviewed", unreviewed: "private-source" });
  });

  test("a review whose commit is no longer the PR head is cancelled, not passed", async () => {
    const { pr, api, review, input } = await scenario();
    pr.headSha = sha("f");

    await runDependencyReviewJob(input);

    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect((await readReview(review.id)).status).toBe("superseded");
    expect(api.requests.some((r) => r.url.includes("/contents/"))).toBe(false);
    expectTokenStaysOnGithub(api);
  });

  test("a closed PR's cancelled review runs again once the PR is reopened", async () => {
    const { name, pr, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    pr.state = "closed";
    await runDependencyReviewJob(input);
    expect((await readReview(review.id)).status).toBe("superseded");

    pr.state = "open";
    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ status: "completed", conclusion: "clear" });
    // The cancelled run is finished, so the new verdict gets a run of its own.
    expect(api.checkRunCreates).toHaveLength(2);
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
  });

  test("a legacy queued skip still completes safely", async () => {
    const seeded = await seedDependencyReviewOrg();
    const pr = fakePullRequest({ permissions: new Map([["octocat", "write"]]) });
    const api = stubGithubApi(pr);

    await runDependencyReviewJob({
      organizationId: seeded.organizationId,
      skip: {
        installationRowId: seeded.installation.id,
        repositoryId: 5151,
        repositoryFullName: "octo/example",
        headSha: pr.headSha,
        fromFork: false,
        authorLogin: "octocat",
        senderLogin: "octocat",
      },
    });

    expect(api.checkRunCreates).toHaveLength(1);
    // In progress first, so a skip that dies part way never passes.
    expect(api.checkRunCreates[0].body).toMatchObject({
      name: "Drydock dependency review",
      head_sha: pr.headSha,
      status: "in_progress",
    });
    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "skipped" });
    expect(api.requests.filter((r) => r.url.includes("/pulls/"))).toEqual([]);
  });

  test("a writer's PR whose new commit someone else pushed gets cancelled", async () => {
    const seeded = await seedDependencyReviewOrg();
    const pr = fakePullRequest({
      permissions: new Map([
        ["maintainer", "write"],
        ["outsider", "read"],
      ]),
    });
    const api = stubGithubApi(pr);

    await runDependencyReviewJob({
      organizationId: seeded.organizationId,
      skip: {
        installationRowId: seeded.installation.id,
        repositoryId: 5151,
        repositoryFullName: "octo/example",
        headSha: pr.headSha,
        fromFork: false,
        authorLogin: "maintainer",
        senderLogin: "outsider",
      },
    });

    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });

  test("a same-repo PR from someone who can't push gets cancelled, not skipped", async () => {
    const seeded = await seedDependencyReviewOrg();
    const pr = fakePullRequest({ permissions: new Map([["outsider", "read"]]) });
    const api = stubGithubApi(pr);

    await runDependencyReviewJob({
      organizationId: seeded.organizationId,
      skip: {
        installationRowId: seeded.installation.id,
        repositoryId: 5151,
        repositoryFullName: "octo/example",
        headSha: pr.headSha,
        fromFork: false,
        authorLogin: "outsider",
      },
    });

    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expectTokenStaysOnGithub(api);
  });

  test("a skip never lands on a commit Drydock reviews, so a fork PR can't pass a held one", async () => {
    const { seeded, pr, api, input } = await scenario();
    await runDependencyReviewJob(input);
    const creates = api.checkRunCreates.length;

    // Someone opens a PR from a fork whose branch sits at the bot PR's head.
    await runDependencyReviewJob({
      organizationId: seeded.organizationId,
      skip: {
        installationRowId: seeded.installation.id,
        repositoryId: 5151,
        repositoryFullName: "octo/example",
        headSha: pr.headSha,
        fromFork: false,
      },
    });

    expect(api.checkRunCreates).toHaveLength(creates);
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
  });

  test("a second message for a leased review waits without creating a second check run", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    expect(await claimDependencyReview(createDb(env.DB), review.id)).toBe(true);

    await expect(runDependencyReviewJob(input)).rejects.toBeInstanceOf(DependencyReviewLeaseError);

    expect(api.checkRunCreates).toEqual([]);
    // Past the lease, a run whose worker died is taken over.
    const later = new Date(Date.now() + 16 * 60 * 1000);
    expect(await claimDependencyReview(createDb(env.DB), review.id, { now: later })).toBe(true);
  });

  test("a retryable failure gives the claim back so the retry can run", async () => {
    const { pr, review, input } = await scenario();
    pr.filesStatus = 503;
    const ctx = createExecutionContext();

    await expect(
      executeDependencyReviewJob(dependencyReviewJobEnv(), ctx, input, { finalAttempt: false }),
    ).rejects.toThrow();
    await waitOnExecutionContext(ctx);

    expect((await readReview(review.id)).status).toBe("queued");
  });

  test.each(["head", "closed"])(
    "a PR whose %s changes during the diff cancels its old review",
    async (change) => {
      const { pr, api, review, input } = await scenario();
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const url = request instanceof Request ? request.url : String(request);
          if (url.startsWith("https://registry.npmjs.org/")) {
            if (change === "head") pr.headSha = sha("d");
            else pr.state = "closed";
          }
          return realFetch(request, init);
        }),
      );

      await runDependencyReviewJob(input);

      expect((await readReview(review.id)).status).toBe("superseded");
      expect(api.lastCheckRunState()).toMatchObject({
        status: "completed",
        conclusion: "cancelled",
      });
      expect(api.checkRunUpdates.some((run) => run.body.conclusion === "success")).toBe(false);
      expectTokenStaysOnGithub(api);
    },
  );

  test("an old worker's cancellation cannot supersede a newer attempt's row", async () => {
    const { pr, api, review, input } = await scenario();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : String(request);
        if (url.startsWith("https://registry.npmjs.org/")) {
          pr.headSha = sha("d");
          await createDb(env.DB)
            .update(schema.dependencyReviews)
            .set({ checkRunId: 1e9 })
            .where(eq(schema.dependencyReviews.id, review.id));
        }
        return realFetch(request, init);
      }),
    );

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ status: "running", checkRunId: 1e9 });
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: api.checkRunCreates[0].id,
      body: { status: "completed", conclusion: "cancelled" },
    });
  });

  test.each(["finishes", "fails", "retries"])(
    "a lease takeover keeps its distinct result when the expired worker %s",
    async (outcome) => {
      const { api, review, input } = await scenario();
      let reachedDiff!: () => void;
      const diffReached = new Promise<void>((resolve) => {
        reachedDiff = resolve;
      });
      let resumeDiff!: () => void;
      const diffPaused = new Promise<void>((resolve) => {
        resumeDiff = resolve;
      });
      let paused = false;
      let originalResuming = false;
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const url = request instanceof Request ? request.url : String(request);
          if (url.startsWith("https://registry.npmjs.org/") && !paused) {
            paused = true;
            reachedDiff();
            await diffPaused;
          }
          if (originalResuming && url.endsWith("/pulls/42") && outcome !== "finishes") {
            return new Response("{}", { status: outcome === "fails" ? 422 : 503 });
          }
          return realFetch(request, init);
        }),
      );
      const ctx = createExecutionContext();
      const original = executeDependencyReviewJob(dependencyReviewJobEnv(), ctx, input, {
        finalAttempt: outcome !== "retries",
      }).then(
        () => null,
        (err: unknown) => err,
      );
      await diffReached;
      const previousRun = api.checkRunCreates[0].id;
      await createDb(env.DB)
        .update(schema.dependencyReviews)
        .set({ updatedAt: new Date(Date.now() - 16 * 60 * 1000) })
        .where(eq(schema.dependencyReviews.id, review.id));

      await runDependencyReviewJob(input);

      const replacement = await readReview(review.id);
      expect(replacement).toMatchObject({ status: "completed", conclusion: "held" });
      expect(replacement.checkRunId).not.toBe(previousRun);
      expect(api.checkRunUpdates.find((run) => run.id === previousRun)?.body.conclusion).toBe(
        "cancelled",
      );
      originalResuming = true;
      resumeDiff();
      const error = await original;
      await waitOnExecutionContext(ctx);

      // The expired pass stops at its first fenced progress write, before it
      // reaches GitHub again, whatever GitHub would have answered.
      expect(error).toBeNull();
      expect(await readReview(review.id)).toMatchObject({
        status: "completed",
        conclusion: "held",
        checkRunId: replacement.checkRunId,
      });
      expectTokenStaysOnGithub(api);
    },
  );

  test("a takeover during result publication prevents the previous worker completing its row", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : String(request);
        if (url.includes("/check-runs/") && init?.method === "PATCH") {
          await createDb(env.DB)
            .update(schema.dependencyReviews)
            .set({ checkRunId: 1e9 })
            .where(eq(schema.dependencyReviews.id, review.id));
        }
        return realFetch(request, init);
      }),
    );

    await runDependencyReviewJob(input);

    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
    expect(await readReview(review.id)).toMatchObject({ status: "running", checkRunId: 1e9 });
  });

  test("a PR changing pyproject.toml and only an npm lockfile holds on the manifest", async () => {
    const { name, api, review, input } = await scenario({
      pr: {
        files: [
          { filename: "package-lock.json", status: "modified" },
          { filename: "py/pyproject.toml", status: "modified" },
        ],
      },
    });
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    const summary = String((api.lastCheckRunState()?.output as { summary?: string })?.summary);
    expect(summary).toContain("`py/pyproject.toml`");
    expect(summary).not.toContain("`package-lock.json`, ");
  });

  test("a workspace package.json is covered by the root lockfile that lists it", async () => {
    const { name, pr, review, input } = await scenario({
      pr: {
        files: [
          { filename: "package-lock.json", status: "modified" },
          { filename: "packages/app/package.json", status: "modified" },
        ],
      },
    });
    const head = JSON.parse(pr.contents.get(`${pr.headSha}:package-lock.json`) ?? "{}");
    head.packages["packages/app"] = { name: "app-workspace", version: "0.0.0" };
    pr.contents.set(`${pr.headSha}:package-lock.json`, JSON.stringify(head));
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("clear");
  });

  test("a root lockfile does not cover a sibling project it doesn't list", async () => {
    const { name, api, review, input } = await scenario({
      pr: {
        files: [
          { filename: "package-lock.json", status: "modified" },
          { filename: "website/package.json", status: "modified" },
        ],
      },
    });
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(String((api.lastCheckRunState()?.output as { summary?: string })?.summary)).toContain(
      "`website/package.json`",
    );
  });

  test("a changed .txt is read as requirements", async () => {
    const { pr, api, review, input } = await scenario({
      pr: { files: [{ filename: "deps/common.txt", status: "modified" }] },
    });
    pr.contents.set(`${pr.mergeBaseSha}:deps/common.txt`, "requests==2.31.0\n");
    pr.contents.set(`${pr.headSha}:deps/common.txt`, "requests==2.32.0\n");

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.bumps.map((b) => [b.bump.ecosystem, b.bump.name, b.bump.toVersion])).toEqual([
      ["pypi", "requests", "2.32.0"],
    ]);
    expect(api.requests.some((r) => r.url.includes("/contents/deps/common.txt"))).toBe(true);
  });

  test("a .txt that isn't requirements holds rather than passes", async () => {
    const { pr, review, input } = await scenario({
      pr: { files: [{ filename: "VERSION.txt", status: "modified" }] },
    });
    pr.contents.set(`${pr.mergeBaseSha}:VERSION.txt`, "tool 1.2\n");
    pr.contents.set(`${pr.headSha}:VERSION.txt`, "tool 1.3\n");

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
  });

  test("a removed bun.lockb holds the review", async () => {
    const { name, review, input } = await scenario({
      pr: {
        files: [
          { filename: "package-lock.json", status: "modified" },
          { filename: "bun.lockb", status: "removed" },
        ],
      },
    });
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
  });

  test("a review whose run is no longer the newest on the commit publishes to a fresh run", async () => {
    const { name, pr, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1", ...INSTALL_SCRIPT });
    // A skip lands on the commit right after the review's in-progress run.
    pr.onCheckRunCreate = async (body) => {
      if (body.external_id !== review.id || api.checkRunCreates.length > 1) return;
      api.checkRunCreates.push({
        id: 1e9,
        body: { name: body.name, head_sha: body.head_sha, external_id: `skip:${body.head_sha}` },
      });
    };

    await runDependencyReviewJob(input);

    const reviewRuns = api.checkRunCreates.filter((run) => run.body.external_id === review.id);
    expect(reviewRuns).toHaveLength(2);
    expect(reviewRuns[1].body).toMatchObject({
      status: "completed",
      conclusion: "action_required",
    });
    expect((await readReview(review.id)).checkRunId).toBe(reviewRuns[1].id);
    // The replaced run is closed, not left in progress.
    expect(api.checkRunUpdates.at(-1)).toMatchObject({
      id: reviewRuns[0].id,
      body: { status: "completed", conclusion: "cancelled" },
    });
  });

  test("a newer run of the same review is left to the attempt that recorded it", async () => {
    const { name, pr, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    pr.onCheckRunCreate = async (body) => {
      if (api.checkRunCreates.length > 1) return;
      api.checkRunCreates.push({ id: 1e9, body: { ...body, external_id: review.id } });
    };
    // A Re-run claimed the review after the lease and recorded its own run
    // before this attempt looked for the newest one.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request ? request.url : String(request);
        if (url.includes("/check-runs?")) {
          await createDb(env.DB)
            .update(schema.dependencyReviews)
            .set({ checkRunId: 1e9 })
            .where(eq(schema.dependencyReviews.id, review.id));
        }
        return realFetch(request, init);
      }),
    );

    await runDependencyReviewJob(input);

    expect(api.checkRunCreates).toHaveLength(2);
    expect(api.checkRunUpdates.filter((u) => u.body.status === "completed")).toEqual([]);
    expect((await readReview(review.id)).status).toBe("running");
  });

  test("a newer run of the same review nobody recorded is adopted", async () => {
    const { name, pr, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    // A create whose response was lost: GitHub has the run, the review doesn't.
    pr.onCheckRunCreate = async (body) => {
      if (api.checkRunCreates.length > 1) return;
      api.checkRunCreates.push({ id: 1e9, body: { ...body, external_id: review.id } });
    };

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ status: "completed", checkRunId: 1e9 });
    expect(api.checkRunUpdates.find((u) => u.id === 1e9)?.body).toMatchObject({
      conclusion: "success",
    });
  });

  test("a re-run asked for while the review runs is retried, not dropped", async () => {
    const { review, input } = await scenario();
    await claimDependencyReview(createDb(env.DB), review.id);
    const ctx = createExecutionContext();

    await expect(
      executeDependencyReviewJob(
        dependencyReviewJobEnv(),
        ctx,
        { ...input, rerun: true },
        { finalAttempt: false },
      ),
    ).rejects.toThrow("re-run later");
    await waitOnExecutionContext(ctx);
  });

  test("a fallback .txt does not cover a pyproject.toml beside it", async () => {
    const { pr, review, input } = await scenario({
      pr: {
        files: [
          { filename: "svc/notes.txt", status: "modified" },
          { filename: "svc/pyproject.toml", status: "modified" },
        ],
      },
    });
    pr.contents.set(`${pr.mergeBaseSha}:svc/notes.txt`, "");
    pr.contents.set(`${pr.headSha}:svc/notes.txt`, "");

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
  });

  test("a changed Yarn zero-install cache holds, reported once per directory", async () => {
    const { review, input } = await scenario({
      pr: {
        files: [
          {
            filename: ".yarn/cache/left-pad-npm-1.3.0-b1ba5b8b38-0000000000.zip",
            status: "modified",
          },
          { filename: ".yarn/cache/is-odd-npm-3.0.1-93c3c3f41b-0000000000.zip", status: "added" },
          { filename: "README.md", status: "modified" },
        ],
      },
    });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.conclusion).toBe("held");
    expect(JSON.parse(row.unreadLockfilesJson)).toEqual([".yarn/cache/"]);
  });

  test.each([
    // Yarn's built-in typescript patch, in a cache the config moved.
    ["deps/typescript-patch-5f2b0a3b9f-1234567890.zip", "cacheFolder: deps\n", ["deps/"]],
    ["deps/foo-https-abcdef-1234.zip", "cacheFolder: deps\n", ["deps/"]],
    // A zip outside any configured cache is a file like any other.
    ["docs/release-npm-notes.zip", "cacheFolder: deps\n", []],
    ["docs/release-npm-notes.zip", null, []],
    // A config the strict reader refuses may set the cache anywhere.
    ["docs/release.zip", "cacheFolder: &a deps\n", ["docs/"]],
  ])("a changed %s with .yarnrc.yml %j reports %j", async (path, yarnrc, unread) => {
    const { pr, review, input } = await scenario({
      pr: { files: [{ filename: path, status: "modified" }] },
    });
    if (yarnrc !== null) pr.contents.set(`${pr.headSha}:.yarnrc.yml`, yarnrc);

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(JSON.parse(row.unreadLockfilesJson)).toEqual(unread);
    expect(row.conclusion).toBe(unread.length > 0 ? "held" : "clear");
  });

  const berryLock = (checksum: string) =>
    [
      "__metadata:",
      "  version: 8",
      "  cacheKey: 10c0",
      "",
      '"lodash@npm:^4.17.21":',
      "  version: 4.17.21",
      '  resolution: "lodash@npm:4.17.21"',
      `  checksum: 10c0/${checksum}`,
      "  languageName: node",
      "  linkType: hard",
      "",
    ].join("\n");

  test.each([
    // Found by its name alone, with no config pointing at it.
    ["shared/cache/lodash-npm-4.17.21-6382451519-eb835a2e51.zip", null],
    // Found through the cache folder of the config beside the changed lockfile.
    ["shared/cache/lodash.zip", "cacheFolder: ../shared/cache\nenableGlobalCache: false\n"],
  ])("a changed %s beside a lockfile whose config is %j holds", async (archive, yarnrc) => {
    const { pr, review, input } = await scenario({
      pr: {
        files: [
          { filename: "app/yarn.lock", status: "modified" },
          { filename: archive, status: "modified" },
        ],
      },
    });
    pr.contents.set(`${pr.mergeBaseSha}:app/yarn.lock`, berryLock("a".repeat(128)));
    pr.contents.set(`${pr.headSha}:app/yarn.lock`, berryLock("b".repeat(128)));
    if (yarnrc !== null) pr.contents.set(`${pr.headSha}:app/.yarnrc.yml`, yarnrc);

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.conclusion).toBe("held");
    expect(JSON.parse(row.unreadLockfilesJson)).toEqual(["shared/cache/"]);
  });

  test("a lockfile inside its own cache folder is not cache content", async () => {
    const { pr, review, input } = await scenario({
      pr: { files: [{ filename: "app/yarn.lock", status: "modified" }] },
    });
    pr.contents.set(`${pr.mergeBaseSha}:app/yarn.lock`, berryLock("a".repeat(128)));
    pr.contents.set(`${pr.headSha}:app/yarn.lock`, berryLock("b".repeat(128)));
    pr.contents.set(`${pr.headSha}:app/.yarnrc.yml`, "cacheFolder: .\nenableGlobalCache: false\n");

    await runDependencyReviewJob(input);

    expect(JSON.parse((await readReview(review.id)).unreadLockfilesJson)).toEqual([]);
  });

  test("a cache folder the lockfile's config cannot name reports each changed zip's directory", async () => {
    const { pr, review, input } = await scenario({
      pr: {
        files: [
          { filename: "app/yarn.lock", status: "modified" },
          { filename: "shared/cache/lodash.zip", status: "modified" },
        ],
      },
    });
    pr.contents.set(`${pr.mergeBaseSha}:app/yarn.lock`, berryLock("a".repeat(128)));
    pr.contents.set(`${pr.headSha}:app/yarn.lock`, berryLock("b".repeat(128)));
    pr.contents.set(`${pr.headSha}:app/.yarnrc.yml`, "cacheFolder: ${CACHE}\n");

    await runDependencyReviewJob(input);

    expect(JSON.parse((await readReview(review.id)).unreadLockfilesJson)).toEqual([
      "shared/cache/",
    ]);
  });

  test.each([
    [
      "pnpm importers",
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies: {}\n  packages/app:\n    dependencies: {}\n",
      true,
    ],
    [
      "pnpm importers in the workspace document after pnpm's own",
      "pnpm-lock.yaml",
      [
        "---",
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    configDependencies: {}",
        "    packageManagerDependencies:",
        "      pnpm:",
        "        specifier: 10.0.0",
        "        version: 10.0.0",
        "",
        "---",
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies: {}",
        "",
        "  packages/app:",
        "    dependencies: {}",
        "",
      ].join("\n"),
      true,
    ],
    [
      "a Berry workspace resolution",
      "yarn.lock",
      [
        "__metadata:",
        "  version: 8",
        "  cacheKey: 10",
        "",
        '"app@workspace:packages/app":',
        "  version: 0.0.0-use.local",
        '  resolution: "app@workspace:packages/app"',
        "  languageName: unknown",
        "  linkType: soft",
        "",
      ].join("\n"),
      true,
    ],
    [
      "a pnpm override named like the directory",
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n\noverrides:\n  packages/app: 1.0.0\n\nimporters:\n  .:\n    dependencies: {}\n",
      false,
    ],
    [
      "an npm dependency named like the directory",
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { "packages/app": "1" } } },
      }),
      false,
    ],
  ])("workspace coverage: %s", async (_label, lockfile, text, covered) => {
    const { pr, review, input } = await scenario({
      pr: {
        files: [
          { filename: lockfile, status: "modified" },
          { filename: "packages/app/package.json", status: "modified" },
        ],
      },
    });
    pr.contents.set(`${pr.mergeBaseSha}:${lockfile}`, text);
    pr.contents.set(`${pr.headSha}:${lockfile}`, text);

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.unreadLockfilesJson.includes("packages/app/package.json")).toBe(!covered);
  });

  test.each([
    ["is the tip of a branch here", [sha("b")], "cancelled"],
    ["is no branch's tip here", [], "skipped"],
    ["is a branch tip, opened by a writer", [sha("b")], "skipped"],
  ])("a fork PR whose head %s", async (label, branchHeads, conclusion) => {
    const seeded = await seedDependencyReviewOrg();
    const pr = fakePullRequest({
      branchHeads,
      permissions: new Map([["contributor", label.includes("writer") ? "write" : "read"]]),
    });
    const api = stubGithubApi(pr);

    await runDependencyReviewJob({
      organizationId: seeded.organizationId,
      skip: {
        installationRowId: seeded.installation.id,
        repositoryId: 5151,
        repositoryFullName: "octo/example",
        headSha: pr.headSha,
        fromFork: true,
        authorLogin: "contributor",
        senderLogin: "contributor",
      },
    });

    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion });
  });

  test("a Yarn classic workspace lockfile is read, and never pins the tree", async () => {
    const { pr, review, input } = await scenario({
      pr: { files: [{ filename: "yarn.lock", status: "modified" }] },
    });
    // `host` depends on the local workspace `lib`, which Yarn classic never
    // writes a stanza for.
    const lock = (version: string) =>
      [
        "# yarn lockfile v1",
        "",
        "host@^1.0.0:",
        `  version "${version}"`,
        `  resolved "https://registry.yarnpkg.com/host/-/host-${version}.tgz"`,
        `  integrity sha512-${version.replaceAll(".", "").padEnd(86, "A")}==`,
        "  dependencies:",
        '    lib "^1.0.0"',
        "",
      ].join("\n");
    pr.contents.set(`${pr.mergeBaseSha}:yarn.lock`, lock("1.0.0"));
    pr.contents.set(`${pr.headSha}:yarn.lock`, lock("1.0.1"));

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(JSON.parse(row.unreadLockfilesJson)).toEqual([]);
    expect(row.bumps).toHaveLength(1);
    expect(row.bumps[0].bump).toMatchObject({ name: "host", toVersion: "1.0.1" });
    expect(row.bumps[0].bump).not.toHaveProperty("lockfilePinsTree");
  });

  test("a requirements file never pins the tree, in hash-checking mode too", async () => {
    const { pr, review, input } = await scenario({
      pr: { files: [{ filename: "requirements.txt", status: "modified" }] },
    });
    const hash = (seed: string) => `--hash=sha256:${seed.repeat(64)}`;
    pr.contents.set(`${pr.mergeBaseSha}:requirements.txt`, `requests==2.31.0 ${hash("a")}\n`);
    pr.contents.set(`${pr.headSha}:requirements.txt`, `requests==2.32.0 ${hash("b")}\n`);

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.bumps).toHaveLength(1);
    expect(row.bumps[0].bump).toMatchObject({ name: "requests", toVersion: "2.32.0" });
    expect(row.bumps[0].bump).not.toHaveProperty("lockfilePinsTree");
  });

  test("a requirements file covers a pyproject only when compiled from it", async () => {
    const files = [
      { filename: "requirements.txt", status: "modified" },
      { filename: "pyproject.toml", status: "modified" },
    ];
    const run = async (header: string) => {
      const { pr, review, input } = await scenario({ pr: { files } });
      pr.contents.set(`${pr.mergeBaseSha}:requirements.txt`, `${header}requests==2.31.0\n`);
      pr.contents.set(`${pr.headSha}:requirements.txt`, `${header}requests==2.31.0\n`);
      await runDependencyReviewJob(input);
      return (await readReview(review.id)).unreadLockfilesJson.includes("pyproject.toml");
    };

    expect(await run("")).toBe(true);
    expect(await run("# see pyproject.toml for ranges\n")).toBe(true);
    expect(await run("#    pip-compile --output-file=requirements.txt pyproject.toml\n")).toBe(
      false,
    );
  });

  test("a skip that races a new review is cancelled and the review re-run", async () => {
    const seeded = await seedDependencyReviewOrg();
    const pr = fakePullRequest();
    const api = stubGithubApi(pr);
    let raced = null as { id: string } | null;
    pr.onCheckRunCreate = async () => {
      raced = await seedReview(seeded, pr);
    };
    const send = vi.fn(async () => undefined);

    await runDependencyReviewJob(
      {
        organizationId: seeded.organizationId,
        skip: {
          installationRowId: seeded.installation.id,
          repositoryId: 5151,
          repositoryFullName: "octo/example",
          headSha: pr.headSha,
        },
      },
      { SCAN_QUEUE: { send } as unknown as Queue },
    );

    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(send).toHaveBeenCalledWith({
      kind: "dependency_review",
      organizationId: seeded.organizationId,
      reviewId: raced?.id,
      rerun: true,
    });
  });

  test("a duplicate message for a completed review posts nothing; Re-run reviews it again", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    await runDependencyReviewJob(input);
    expect(api.checkRunCreates).toHaveLength(1);

    await runDependencyReviewJob(input);
    expect(api.checkRunCreates).toHaveLength(1);

    await runDependencyReviewJob({ ...input, rerun: true });
    expect(api.checkRunCreates).toHaveLength(2);
    expect((await readReview(review.id)).status).toBe("completed");
  });

  test("a redirect from GitHub fails the review without being followed", async () => {
    const { api, review, input } = await scenario({
      pr: { redirectTo: "https://api.github.com/repositories/5151/pulls/42" },
    });

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ status: "failed" });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "failure" });
    expect(api.requests.filter((r) => r.url.includes("/repositories/"))).toEqual([]);
    expect(
      api.requests
        .filter((r) => r.host === "api.github.com" && !r.url.includes("access_tokens"))
        .every((r) => r.redirect === "manual"),
    ).toBe(true);
  });

  test("a GitHub error that will not succeed on retry fails the review and its check", async () => {
    const { pr, api, review, input } = await scenario();
    pr.filesStatus = 422;

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ status: "failed" });
    expect(api.lastCheckRunState()).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  test("the SCAN_QUEUE consumer routes dependency_review messages to the job", async () => {
    const { name, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    const message = {
      id: "m1",
      timestamp: new Date(),
      attempts: 1,
      body: { kind: "dependency_review", ...input } satisfies QueueMessage,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const ctx = createExecutionContext();

    await queue(
      { queue: "scan", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as never,
      dependencyReviewJobEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(message.retry).not.toHaveBeenCalled();
    expect((await readReview(review.id)).conclusion).toBe("clear");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
  });

  test.each([1, 3, 4])(
    "queue attempt %s defers a terminated worker's lease and can recover it after expiry",
    async (attempts) => {
      const { name, api, review, input } = await scenario();
      await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
      await claimDependencyReview(createDb(env.DB), review.id);
      const message = {
        id: "leased",
        timestamp: new Date(),
        attempts,
        body: { kind: "dependency_review", ...input, rerun: true } satisfies QueueMessage,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const batch = { queue: "scan", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() };
      const ctx = createExecutionContext();
      const send = vi.fn().mockResolvedValue(undefined);
      const jobEnv = dependencyReviewJobEnv({
        SCAN_QUEUE: { send } as unknown as Queue<QueueMessage>,
      });

      await queue(batch as never, jobEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(send).toHaveBeenCalledWith(message.body, { delaySeconds: expect.any(Number) });
      expect(send.mock.calls[0][1].delaySeconds).toBeGreaterThan(890);
      expect(message.retry).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(api.checkRunCreates).toEqual([]);
      await createDb(env.DB)
        .update(schema.dependencyReviews)
        .set({ updatedAt: new Date(Date.now() - 16 * 60 * 1000) })
        .where(eq(schema.dependencyReviews.id, review.id));
      send.mockClear();

      const recoveredCtx = createExecutionContext();
      await queue(batch as never, jobEnv, recoveredCtx);
      await waitOnExecutionContext(recoveredCtx);

      expect(message.retry).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(await readReview(review.id)).toMatchObject({
        status: "completed",
        conclusion: "clear",
      });
      expect(api.checkRunCreates).toHaveLength(1);
    },
  );

  test("a failed lease handoff never acknowledges the original message", async () => {
    const { review, input } = await scenario();
    await claimDependencyReview(createDb(env.DB), review.id);
    const message = {
      id: "lease-handoff-failure",
      timestamp: new Date(),
      attempts: 4,
      body: { kind: "dependency_review", ...input } satisfies QueueMessage,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const ctx = createExecutionContext();

    await expect(
      queue(
        { queue: "scan", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as never,
        dependencyReviewJobEnv({ SCAN_QUEUE: { send } as unknown as Queue<QueueMessage> }),
        ctx,
      ),
    ).rejects.toThrow("queue unavailable");
    await waitOnExecutionContext(ctx);

    expect(send).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect((await readReview(review.id)).status).toBe("running");
  });
});

// A changed lockfile Drydock could not read hides its bumps, so the review
// holds rather than passing on what it did see.
describe("lockfiles the review could not read", () => {
  function checkOutput(api: GithubApiDouble) {
    return (api.lastCheckRunState()?.output ?? {}) as { title?: string; summary?: string };
  }

  test("an over-8 MiB lockfile holds the review", async () => {
    const { pr, api, review, input } = await scenario();
    pr.contents.set(`${pr.headSha}:package-lock.json`, " ".repeat(8 * 1024 * 1024 + 1));

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(checkOutput(api).title).toBe("Held: some updates could not be read");
    expect(checkOutput(api).summary).toContain(
      "Drydock couldn't review the changes to `package-lock.json`",
    );
  });

  test("a lockfile that does not parse at the head holds the review", async () => {
    const { pr, api, review, input } = await scenario();
    pr.contents.set(`${pr.headSha}:package-lock.json`, "{ not json");

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(checkOutput(api).summary).toContain("`package-lock.json`");
  });

  test.each(["bun.lock", "bun.lockb", "poetry.lock", "Pipfile.lock", "pdm.lock"])(
    "a PR changing only %s holds the review and names the file",
    async (filename) => {
      const { api, review, input } = await scenario({
        pr: { files: [{ filename: `packages/app/${filename}`, status: "modified" }] },
      });

      await runDependencyReviewJob(input);

      expect((await readReview(review.id)).conclusion).toBe("held");
      expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
      expect(checkOutput(api).summary).toContain(filename);
      // The format is not parsed, so its bytes are never fetched.
      expect(api.requests.some((r) => r.url.includes(`/contents/packages/app/${filename}`))).toBe(
        false,
      );
    },
  );

  test.each([
    ["a manifest changed without a lockfile", "package.json", "modified"],
    ["a pyproject changed without a lockfile", "pyproject.toml", "modified"],
    ["a removed lockfile", "package-lock.json", "removed"],
    ["a pylock file", "pylock.toml", "modified"],
    ["a named pylock file", "pylock.dev.toml", "added"],
  ])("%s holds the review and names the file", async (_label, filename, status) => {
    const { api, review, input } = await scenario({ pr: { files: [{ filename, status }] } });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(checkOutput(api).summary).toContain(`\`${filename}\``);
  });

  test.each(["modified", "added", "renamed"])(
    "an npm manifest %s with only metadata changes passes without a lockfile",
    async (status) => {
      const filename = "app/package.json";
      const { pr, api, review, input } = await scenario({
        pr: {
          files: [
            {
              filename,
              status,
              ...(status === "renamed" ? { previous_filename: "old/package.json" } : {}),
            },
          ],
        },
      });
      if (status !== "added") {
        pr.contents.set(
          `${pr.mergeBaseSha}:${status === "renamed" ? "old/package.json" : filename}`,
          JSON.stringify({ name: "app", version: "1.0.0", description: "before" }),
        );
      }
      pr.contents.set(
        `${pr.headSha}:${filename}`,
        JSON.stringify({ name: "app", version: "1.0.1", scripts: { test: "node test.js" } }),
      );

      await runDependencyReviewJob(input);

      expect(await readReview(review.id)).toMatchObject({ conclusion: "clear", bumpCount: 0 });
      expect(checkOutput(api).title).toBe("No npm or PyPI dependency updates");
      expectTokenStaysOnGithub(api);
    },
  );

  test("metadata changes with unchanged dependency declarations pass without a lockfile", async () => {
    const filename = "package.json";
    const { pr, api, review, input } = await scenario({
      pr: { files: [{ filename, status: "modified" }] },
    });
    pr.contents.set(
      `${pr.mergeBaseSha}:${filename}`,
      JSON.stringify({ description: "before", dependencies: { a: "1.0.0", b: "2.0.0" } }),
    );
    pr.contents.set(
      `${pr.headSha}:${filename}`,
      JSON.stringify({ description: "after", dependencies: { b: "2.0.0", a: "1.0.0" } }),
    );

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ conclusion: "clear", bumpCount: 0 });
    expect(checkOutput(api).title).toBe("No npm or PyPI dependency updates");
  });

  test("a moved manifest's unchanged dependencies still need resolution in its new directory", async () => {
    const filename = "new/package.json";
    const { pr, api, review, input } = await scenario({
      pr: {
        files: [{ filename, status: "renamed", previous_filename: "old/package.json" }],
      },
    });
    const manifest = JSON.stringify({ dependencies: { existing: "1.0.0" } });
    pr.contents.set(`${pr.mergeBaseSha}:old/package.json`, manifest);
    pr.contents.set(`${pr.headSha}:${filename}`, manifest);

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ conclusion: "held" });
    expect(checkOutput(api).summary).toContain("`new/package.json`");
  });

  test.each(["dependency edit", "malformed", "oversized"])(
    "an npm manifest with a %s remains unread without a lockfile",
    async (change) => {
      const filename = "package.json";
      const { pr, api, review, input } = await scenario({
        pr: { files: [{ filename, status: "modified" }] },
      });
      pr.contents.set(`${pr.mergeBaseSha}:${filename}`, JSON.stringify({ dependencies: {} }));
      pr.contents.set(
        `${pr.headSha}:${filename}`,
        change === "dependency edit"
          ? JSON.stringify({ dependencies: { added: "1.0.0" } })
          : change === "malformed"
            ? "{ invalid"
            : " ".repeat(8 * 1024 * 1024 + 1),
      );

      await runDependencyReviewJob(input);

      expect(await readReview(review.id)).toMatchObject({ conclusion: "held" });
      expect(checkOutput(api).summary).toContain("`package.json`");
      expect(checkOutput(api).title).not.toBe("No npm or PyPI dependency updates");
    },
  );

  test("npm manifests past the comparison cap stay unread", async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      filename: `app${i}/package.json`,
      status: "added",
    }));
    const { pr, api, review, input } = await scenario({ pr: { files } });
    for (const file of files) {
      pr.contents.set(`${pr.headSha}:${file.filename}`, JSON.stringify({ name: "app" }));
    }

    await runDependencyReviewJob(input);

    expect(await readReview(review.id)).toMatchObject({ conclusion: "held" });
    expect(checkOutput(api).summary).toContain("`app20/package.json`");
    expect(api.requests.filter((r) => r.url.includes("/contents/"))).toHaveLength(20);
  });

  test("a manifest changed alongside a parsed lockfile is reviewed through the lockfile", async () => {
    const { name, api, review, input } = await scenario({
      pr: {
        files: [
          { filename: "package.json", status: "modified" },
          { filename: "package-lock.json", status: "modified" },
        ],
      },
    });
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("clear");
    expect(checkOutput(api).summary).not.toContain("couldn't read");
  });

  test("a files listing shorter than the PR's changed_files holds the review", async () => {
    const { name, api, review, input } = await scenario({ pr: { changedFiles: 3001 } });
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(checkOutput(api).summary).toContain("GitHub listed only part of this PR's files");
  });

  test("under the default policy, an unread lockfile holds: nothing vouches for its updates", async () => {
    const { api, review, input } = await scenario({
      policy: DEFAULT_DEPENDENCY_REVIEW_POLICY,
      pr: { files: [{ filename: "bun.lock", status: "modified" }] },
    });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
    expect(checkOutput(api).title).toBe("Held: some updates could not be read");
    expect(checkOutput(api).summary).toContain("bun.lock");
    expect(checkOutput(api).summary).toContain("Approve below to accept these changes unread");
  });

  test("with the age fallback and holdOnUnreviewed off, an unread lockfile is named but never called clear", async () => {
    const { api, review, input } = await scenario({
      policy: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, unreadMinimumAgeDays: null },
      pr: { files: [{ filename: "bun.lock", status: "modified" }] },
    });

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("clear");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
    expect(checkOutput(api).summary).toContain("bun.lock");
    expect(checkOutput(api).title).toBe("No updates held");
    expect(checkOutput(api).summary).not.toContain("adds no npm or PyPI dependencies");
  });

  test("with an unread lockfile, a release that adds a dependency holds on any lockfile", async () => {
    const host = uniquePackageName("host");
    const carrier = uniquePackageName("carrier");
    const { api, review, input } = await scenario({
      policy: {
        ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
        unreadMinimumAgeDays: null,
        holdOnUnreviewed: false,
      },
      before: { [host]: "1.0.0" },
      after: { [host]: "1.0.1" },
      pr: {
        files: [
          { filename: "package-lock.json", status: "modified" },
          { filename: "bun.lock", status: "modified" },
        ],
      },
    });
    await seedNpmDiff({
      name: host,
      from: "1.0.0",
      to: "1.0.1",
      fromPackageJson: { name: host, version: "1.0.0" },
      toPackageJson: { name: host, version: "1.0.1", dependencies: { [carrier]: "^1.0.0" } },
    });

    await runDependencyReviewJob(input);

    const row = await readReview(review.id);
    expect(row.conclusion).toBe("held");
    expect(row.bumps[0]).toMatchObject({
      bump: { name: host, lockfilePinsTree: true },
      verdict: {
        status: "hold",
        reasons: ["dependency-added"],
        dependencyUnseen: "coverage-incomplete",
      },
    });
    expect(checkOutput(api).summary).toContain(
      "adds a dependency; part of this pull request went unread, so Drydock cannot see what it installs",
    );
  });

  test("lockfiles past the 20-per-review cap hold the review", async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      filename: `packages/p${String(i).padStart(2, "0")}/package-lock.json`,
      status: "added",
    }));
    const { pr, api, review, input } = await scenario({ pr: { files } });
    for (const file of files) pr.contents.set(`${pr.headSha}:${file.filename}`, npmLockfile({}));

    await runDependencyReviewJob(input);

    expect((await readReview(review.id)).conclusion).toBe("held");
    expect(checkOutput(api).summary).toContain(files[20].filename);
    expect(api.requests.some((r) => r.url.includes(`/contents/${files[20].filename}`))).toBe(false);
  });
});

describe("approving held updates", () => {
  // A finished held review of `name` 1.0.0 → 1.0.1, plus the check run id.
  async function heldScenario() {
    const s = await scenario();
    await seedNpmDiff({ name: s.name, from: "1.0.0", to: "1.0.1", ...INSTALL_SCRIPT });
    await runDependencyReviewJob(s.input);
    expect((await readReview(s.review.id)).conclusion).toBe("held");
    return { ...s, updatesBefore: s.api.checkRunUpdates.length };
  }

  test.each([
    ["read access", "read"],
    ["triage access", "triage"],
    ["no collaborator record", null],
  ])("a user with %s cannot approve", async (_label, permission) => {
    const { seeded, pr, api, review, input, updatesBefore } = await heldScenario();
    if (permission) pr.permissions.set("drive-by", permission);

    await runDependencyReviewJob({ ...input, approver: { login: "drive-by", githubId: 99 } });

    expect(await approvals(seeded.organizationId)).toEqual([]);
    expect(api.checkRunUpdates).toHaveLength(updatesBefore);
    expect(await readReview(review.id)).toMatchObject({
      conclusion: "held",
      heldCount: 1,
      approvedByLogin: null,
    });
    expect(await auditEvents(seeded.organizationId, "dependency_review.approved")).toEqual([]);
    expect(api.requests.some((r) => r.url.endsWith("/collaborators/drive-by/permission"))).toBe(
      true,
    );
    expectTokenStaysOnGithub(api);
  });

  test("a writer's approval records the change, passes the check, and audits", async () => {
    const { seeded, name, pr, api, review, input } = await heldScenario();
    pr.permissions.set("maintainer", "write");

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    expect(await approvals(seeded.organizationId)).toEqual([
      expect.objectContaining({
        repositoryId: 5151,
        ecosystem: "npm",
        packageName: name,
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        approvedByLogin: "maintainer",
        approvedByGithubId: 3141,
        reviewId: review.id,
      }),
    ]);
    expect(api.lastCheckRunState()).toMatchObject({
      status: "completed",
      conclusion: "success",
      actions: [],
    });
    expect(await readReview(review.id)).toMatchObject({
      status: "completed",
      conclusion: "approved",
      heldCount: 0,
      approvedByLogin: "maintainer",
    });
    const [event] = await auditEvents(seeded.organizationId, "dependency_review.approved");
    expect(event.metadataJson).toMatchObject({
      reviewId: review.id,
      repositoryFullName: "octo/example",
      pullNumber: 42,
      approvedByLogin: "maintainer",
      approvedCount: 1,
    });
    expectTokenStaysOnGithub(api);
  });

  test("approving a review cut at the storage limit keeps its real total", async () => {
    const { pr, review, input } = await heldScenario();
    pr.permissions.set("maintainer", "write");
    // As stored for a PR past the stored-bump limit: the row counts more than it keeps.
    await createDb(env.DB)
      .update(schema.dependencyReviews)
      .set({ bumpCount: 900 })
      .where(eq(schema.dependencyReviews.id, review.id));

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    expect(await readReview(review.id)).toMatchObject({
      conclusion: "approved",
      bumpCount: 900,
      heldCount: 0,
    });
  });

  test("an approval carries to a later commit that merges the same change", async () => {
    const { seeded, name, pr, input } = await heldScenario();
    pr.permissions.set("maintainer", "admin");
    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    // Dependabot rebases: new head, same version change, plus an unapproved one.
    const other = uniquePackageName("other");
    const next = fakePullRequest({ headSha: sha("9"), mergeBaseSha: pr.mergeBaseSha });
    setLockfiles(
      next,
      { [name]: "1.0.0", [other]: "3.0.0" },
      { [name]: "1.0.1", [other]: "3.0.1" },
    );
    await seedNpmDiff({ name: other, from: "3.0.0", to: "3.0.1" });
    const api = stubGithubApi(next);
    const rebased = await seedReview(seeded, next);

    await runDependencyReviewJob({ organizationId: seeded.organizationId, reviewId: rebased.id });

    const row = await readReview(rebased.id);
    expect(row).toMatchObject({ conclusion: "approved", heldCount: 0 });
    expect(row.bumps.find((b) => b.bump.name === name)).toMatchObject({
      verdict: { status: "hold" },
      approved: true,
    });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
    expect(api.requests.some((r) => r.url.includes("/collaborators/"))).toBe(false);
    expectTokenStaysOnGithub(api);
  });

  test("an approval does not carry to a different target version", async () => {
    const { seeded, name, pr, input } = await heldScenario();
    pr.permissions.set("maintainer", "maintain");
    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    const next = fakePullRequest({ headSha: sha("8") });
    setLockfiles(next, { [name]: "1.0.0" }, { [name]: "1.0.2" });
    await seedNpmDiff({
      name,
      from: "1.0.0",
      to: "1.0.2",
      fromPackageJson: INSTALL_SCRIPT.fromPackageJson,
      toPackageJson: { ...INSTALL_SCRIPT.toPackageJson, version: "1.0.2" },
    });
    const api = stubGithubApi(next);
    const later = await seedReview(seeded, next);

    await runDependencyReviewJob({ organizationId: seeded.organizationId, reviewId: later.id });

    expect(await readReview(later.id)).toMatchObject({ conclusion: "held", heldCount: 1 });
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "action_required" });
  });

  test("approving a commit that is no longer the PR head records nothing", async () => {
    const { seeded, pr, api, review, input, updatesBefore } = await heldScenario();
    pr.permissions.set("maintainer", "write");
    pr.headSha = sha("7");

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    expect(await approvals(seeded.organizationId)).toEqual([]);
    expect(api.checkRunUpdates).toHaveLength(updatesBefore);
    expect((await readReview(review.id)).conclusion).toBe("held");
  });

  test("a PR holding more updates than the check can show offers no Approve and refuses one", async () => {
    const prefix = uniquePackageName("many");
    const names = Array.from({ length: 101 }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
    const { seeded, pr, api, review, input } = await scenario({
      before: Object.fromEntries(names.map((n) => [n, "1.0.0"])),
      after: Object.fromEntries(names.map((n) => [n, "1.0.1"])),
    });
    pr.permissions.set("maintainer", "write");

    await runDependencyReviewJob(input);

    const state = api.lastCheckRunState();
    expect(state).toMatchObject({ conclusion: "action_required", actions: [] });
    expect(String((state?.output as { summary?: string })?.summary)).toContain(
      "can't be approved here",
    );
    const updates = api.checkRunUpdates.length;

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 7 } });

    expect(await approvals(seeded.organizationId)).toEqual([]);
    expect(api.checkRunUpdates).toHaveLength(updates);
    expect((await readReview(review.id)).conclusion).toBe("held");
  });

  test("an approval that loses a race with a Re-run publishes nothing", async () => {
    const { pr, api, review, input, updatesBefore } = await heldScenario();
    pr.permissions.set("maintainer", "write");
    // The Re-run claims the review between the permission check and completion.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/permission")) {
          await claimDependencyReview(createDb(env.DB), review.id, { rerun: true });
        }
        return realFetch(input, init);
      }),
    );

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    expect(api.checkRunUpdates).toHaveLength(updatesBefore);
    expect((await readReview(review.id)).status).toBe("running");
  });

  test("a retried approval whose check update failed republishes the approval", async () => {
    const { pr, api, review, input } = await heldScenario();
    pr.permissions.set("maintainer", "write");
    const realFetch = globalThis.fetch;
    let failed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const method = request instanceof Request ? request.method : (init?.method ?? "GET");
        if (method === "PATCH" && !failed) {
          failed = true;
          return new Response("{}", { status: 422 });
        }
        return realFetch(request, init);
      }),
    );
    const approval = { ...input, approver: { login: "maintainer", githubId: 3141 } };

    await expect(runDependencyReviewJob(approval)).rejects.toThrow();
    await runDependencyReviewJob(approval);

    expect((await readReview(review.id)).conclusion).toBe("approved");
    expect(api.lastCheckRunState()).toMatchObject({ conclusion: "success" });
  });

  test("a click on a run a Re-run has replaced approves nothing", async () => {
    const { seeded, pr, api, input, updatesBefore } = await heldScenario();
    pr.permissions.set("maintainer", "write");

    await runDependencyReviewJob({
      ...input,
      approver: { login: "maintainer", githubId: 3141, checkRunId: 1 },
    });

    expect(await approvals(seeded.organizationId)).toEqual([]);
    expect(api.checkRunUpdates).toHaveLength(updatesBefore);
  });

  test("approving a private-registry change does not approve the same versions from npm", async () => {
    const s = await scenario({ policy: { privateRegistries: [CORP_REGISTRY] } });
    s.pr.contents.set(`${s.pr.headSha}:.npmrc`, "registry=https://npm.corp.example/\n");
    s.pr.permissions.set("maintainer", "write");
    await runDependencyReviewJob(s.input);
    await runDependencyReviewJob({
      ...s.input,
      approver: { login: "maintainer", githubId: 3141 },
    });
    expect(await approvals(s.seeded.organizationId)).toMatchObject([{ source: "private" }]);

    // The same change, now resolved from the public registry.
    const next = fakePullRequest({ headSha: sha("8"), mergeBaseSha: s.pr.mergeBaseSha });
    setLockfiles(next, { [s.name]: "1.0.0" }, { [s.name]: "1.0.1" });
    await seedNpmDiff({ name: s.name, from: "1.0.0", to: "1.0.1", ...INSTALL_SCRIPT });
    stubGithubApi(next);
    const publicReview = await seedReview(s.seeded, next);

    await runDependencyReviewJob({
      organizationId: s.seeded.organizationId,
      reviewId: publicReview.id,
    });

    const row = await readReview(publicReview.id);
    expect(row).toMatchObject({ conclusion: "held", heldCount: 1 });
    expect(row.bumps[0].approved).toBe(false);
  });

  test("an Approve click on a review that held nothing is a no-op", async () => {
    const { seeded, name, pr, api, review, input } = await scenario();
    await seedNpmDiff({ name, from: "1.0.0", to: "1.0.1" });
    await runDependencyReviewJob(input);
    const requestsBefore = api.requests.length;
    pr.permissions.set("maintainer", "write");

    await runDependencyReviewJob({ ...input, approver: { login: "maintainer", githubId: 3141 } });

    expect(await approvals(seeded.organizationId)).toEqual([]);
    expect((await readReview(review.id)).conclusion).toBe("clear");
    // Only the installation token exchange happens before the state check.
    expect(api.requests.slice(requestsBefore).map((r) => new URL(r.url).pathname)).toEqual([
      expect.stringMatching(/\/access_tokens$/),
    ]);
  });
});
