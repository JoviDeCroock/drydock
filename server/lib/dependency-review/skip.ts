import type { AppDb } from "../../db/client";
import { getDependencyReviewForHead } from "../../db/dependency-reviews";
import { getInstallationAccessToken } from "../github-app/api";
import { readGithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import { parseRepositoryFullName } from "../github-app/validation";
import type { DependencyReviewJobInput } from "./context";
import {
  createCheckRun,
  hasRepositoryWriteAccess,
  isBranchHead,
  updateCheckRun,
  type RepositoryRef,
} from "./github";
import { DEPENDENCY_REVIEW_CHECK_NAME, SKIP_EXTERNAL_ID_PREFIX } from "./render";

/**
 * A PR outside the review scope gets a `skipped` run, which GitHub counts as
 * passing. Legacy skip jobs can also arrive after the scope has changed.
 *
 * Check runs belong to a commit, not a PR, and GitHub reads the newest run of
 * a name. Anyone can open a PR from a fork at a bot PR's head commit, so a
 * skip must never land on a commit Drydock reviews: none is posted when a
 * review exists, and a review that appears while this posts is re-run so its
 * run is the newest.
 */
export async function postSkippedCheck(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  skip: NonNullable<DependencyReviewJobInput["skip"]>,
): Promise<void> {
  const reviewOfHead = () =>
    getDependencyReviewForHead(db, skip.installationRowId, skip.repositoryId, skip.headSha);
  if (await reviewOfHead()) return;
  const repo = parseRepositoryFullName(skip.repositoryFullName);
  if (!repo) return;
  const installationId = await getInstallationExternalId(
    db,
    skip.installationRowId,
    organizationId,
  );
  if (!installationId) return;
  const token = await getInstallationAccessToken(readGithubAppConfig(env), installationId);
  // Posted in progress, which doesn't pass, and completed only once no review
  // has appeared: a skip that dies part way never leaves a passing run.
  const skipRunId = await createCheckRun(
    token,
    repo,
    {
      name: DEPENDENCY_REVIEW_CHECK_NAME,
      headSha: skip.headSha,
      externalId: `${SKIP_EXTERNAL_ID_PREFIX}${skip.headSha}`,
      detailsUrl: null,
    },
    {
      status: "in_progress",
      output: {
        title: "Checking dependency review scope",
        summary: "Drydock reviews pull requests from branches in this repository.",
      },
    },
  );
  const raced = await reviewOfHead();
  // A commit at the tip of one of this repository's branches may be a bot's
  // before the bot opens its PR (Renovate pushes the branch first, and can
  // automerge it on a green check). Anyone who can read the repository can
  // open a PR from it, from a fork or from the branch itself, so it passes
  // only for an author who could push to the repository anyway.
  if (!raced && !(await skipMayPass(token, repo, skip))) {
    await updateCheckRun(
      token,
      repo,
      skipRunId,
      {
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Commit is a branch in this repository",
          summary:
            "This PR shares its head commit with a branch in this repository, but its author or event sender lacks repository write access. Drydock cannot post a passing skip on a commit another PR may need reviewed.",
        },
      },
      null,
    );
    return;
  }
  if (!raced) {
    await updateCheckRun(
      token,
      repo,
      skipRunId,
      {
        status: "completed",
        conclusion: "skipped",
        output: {
          title: "Outside dependency review scope",
          summary:
            "Drydock reviews pull requests from branches in this repository opened by repository writers or trusted dependency bots. Fork pull requests are not reviewed.",
        },
      },
      null,
    );
    return;
  }
  // A review appeared while this posted. The skip never passes, and the review
  // re-runs; its publish sees the newer skip run and posts a fresh one. The
  // re-run goes first, so a failed update below still leaves it queued.
  await env.SCAN_QUEUE?.send({
    kind: "dependency_review",
    organizationId: raced.organizationId,
    reviewId: raced.id,
    rerun: true,
  });
  await updateCheckRun(
    token,
    repo,
    skipRunId,
    {
      status: "completed",
      conclusion: "cancelled",
      output: {
        title: "Replaced by the dependency review",
        summary: "A pull request under dependency review has this commit as its head.",
      },
    },
    null,
  );
}

async function skipMayPass(
  token: string,
  repo: RepositoryRef,
  skip: NonNullable<DependencyReviewJobInput["skip"]>,
): Promise<boolean> {
  // A same-repo PR's head is always a branch tip.
  if (skip.fromFork !== false && !(await isBranchHead(token, repo, skip.headSha))) return true;
  for (const login of new Set([skip.authorLogin, skip.senderLogin])) {
    if (!login || !(await hasRepositoryWriteAccess(token, repo, login))) return false;
  }
  return true;
}
