import { githubHeaders, paginate } from "../github-app/client";
import { readBoundedJson, readBoundedText } from "../platform/bounded-body";
import { isRecord } from "../platform/guards";
import { reliableFetch } from "../platform/reliable-fetch";
import type { CheckRunOutput } from "./render";

// Every request carries the installation token, and a followed redirect would
// carry it too. A 3xx (a renamed or transferred repository) fails the review
// instead; the queue does not retry it.
const API = "https://api.github.com";
// 3,000 files is GitHub's own ceiling for the pull-request files listing.
const MAX_FILE_PAGES = 30;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const BODY_DEADLINE_MS = 20_000;

/** Failure talking to GitHub. `retryable` is what the queue consumer reads. */
export class DependencyReviewGithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DependencyReviewGithubError";
  }
}

export interface RepositoryRef {
  owner: string;
  name: string;
}

function repoPath(repo: RepositoryRef): string {
  return `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function fail(what: string, response: Response): never {
  const retryable = response.status === 429 || response.status >= 500;
  throw new DependencyReviewGithubError(
    `${what} failed (${response.status})`,
    response.status,
    retryable,
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const data = await readBoundedJson(response, {
    maxBytes: MAX_METADATA_BYTES,
    deadlineMs: Date.now() + BODY_DEADLINE_MS,
  });
  if (!isRecord(data)) {
    throw new DependencyReviewGithubError("unreadable GitHub response", response.status, true);
  }
  return data;
}

export interface PullRequestState {
  number: number;
  state: string;
  authorLogin: string;
  authorType: string;
  headSha: string;
  baseSha: string;
  headRepositoryId: number | null;
  changedFiles: number | null;
}

export async function fetchPullRequest(
  token: string,
  repo: RepositoryRef,
  pullNumber: number,
): Promise<PullRequestState | null> {
  const response = await reliableFetch(`${repoPath(repo)}/pulls/${pullNumber}`, {
    headers: githubHeaders(token),
    redirect: "manual",
  });
  if (response.status === 404) return null;
  if (!response.ok) fail("pull request lookup", response);
  const data = await json(response);
  const user = isRecord(data.user) ? data.user : {};
  const head = isRecord(data.head) ? data.head : {};
  const base = isRecord(data.base) ? data.base : {};
  const headRepo = isRecord(head.repo) ? head.repo : null;
  return {
    number: pullNumber,
    state: typeof data.state === "string" ? data.state : "",
    authorLogin: typeof user.login === "string" ? user.login : "",
    authorType: typeof user.type === "string" ? user.type : "",
    headSha: typeof head.sha === "string" ? head.sha : "",
    baseSha: typeof base.sha === "string" ? base.sha : "",
    headRepositoryId: typeof headRepo?.id === "number" ? headRepo.id : null,
    changedFiles:
      typeof data.changed_files === "number" && Number.isSafeInteger(data.changed_files)
        ? data.changed_files
        : null,
  };
}

export interface PullRequestFile {
  filename: string;
  status: string;
  previousFilename: string | null;
}

export async function listPullRequestFiles(
  token: string,
  repo: RepositoryRef,
  pullNumber: number,
): Promise<{ files: PullRequestFile[]; complete: boolean }> {
  const files: PullRequestFile[] = [];
  const { complete } = await paginate(
    `${repoPath(repo)}/pulls/${pullNumber}/files?per_page=100`,
    {
      headers: githubHeaders(token),
      maxPages: MAX_FILE_PAGES,
      // The token must never follow a `Link` off the API host.
      followNext: (next) => next.startsWith(`${API}/`),
      redirect: "manual",
    },
    async (response) => {
      if (!response.ok) fail("pull request files listing", response);
      const data = await readBoundedJson(response, {
        maxBytes: MAX_METADATA_BYTES * 4,
        deadlineMs: Date.now() + BODY_DEADLINE_MS,
      });
      if (!Array.isArray(data)) {
        throw new DependencyReviewGithubError("unreadable files listing", response.status, true);
      }
      for (const entry of data) {
        if (!isRecord(entry) || typeof entry.filename !== "string") continue;
        files.push({
          filename: entry.filename,
          status: typeof entry.status === "string" ? entry.status : "",
          previousFilename:
            typeof entry.previous_filename === "string" ? entry.previous_filename : null,
        });
      }
    },
  );
  return { files, complete };
}

export async function fetchMergeBase(
  token: string,
  repo: RepositoryRef,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const response = await reliableFetch(
    `${repoPath(repo)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}?per_page=1`,
    { headers: githubHeaders(token), redirect: "manual" },
  );
  if (!response.ok) fail("merge base lookup", response);
  const data = await json(response);
  const commit = isRecord(data.merge_base_commit) ? data.merge_base_commit : {};
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new DependencyReviewGithubError("merge base missing", response.status, true);
  }
  return commit.sha;
}

/**
 * One file's bytes at a ref, or null when it doesn't exist there. Content is
 * repository data and is only ever parsed, never executed. Over the size cap
 * is reported as `too-large` so the caller can say the file went unread.
 */
export async function readRepositoryFile(
  token: string,
  repo: RepositoryRef,
  path: string,
  ref: string,
): Promise<string | null | "too-large"> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await reliableFetch(
    `${repoPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    {
      headers: githubHeaders(token, { Accept: "application/vnd.github.raw+json" }),
      redirect: "manual",
    },
  );
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) fail("file read", response);
  const text = await readBoundedText(response, {
    maxBytes: MAX_LOCKFILE_BYTES,
    deadlineMs: Date.now() + BODY_DEADLINE_MS,
  });
  return text ?? "too-large";
}

export type CheckRunState =
  | { status: "in_progress"; output: CheckRunOutput }
  | {
      status: "completed";
      conclusion: "success" | "action_required" | "failure" | "cancelled" | "skipped";
      output: CheckRunOutput;
      // Only offered while something is held; GitHub shows the button on the run.
      approveAction?: { label: string; description: string; identifier: string };
    };

function checkRunBody(state: CheckRunState, detailsUrl: string | null): Record<string, unknown> {
  return {
    status: state.status,
    ...(state.status === "completed"
      ? {
          conclusion: state.conclusion,
          completed_at: new Date().toISOString(),
          actions: state.approveAction ? [state.approveAction] : [],
        }
      : {}),
    output: state.output,
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
  };
}

export async function createCheckRun(
  token: string,
  repo: RepositoryRef,
  input: { name: string; headSha: string; externalId: string; detailsUrl: string | null },
  state: CheckRunState,
): Promise<number> {
  const response = await reliableFetch(`${repoPath(repo)}/check-runs`, {
    method: "POST",
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    redirect: "manual",
    body: JSON.stringify({
      name: input.name,
      head_sha: input.headSha,
      external_id: input.externalId,
      ...checkRunBody(state, input.detailsUrl),
    }),
  });
  if (!response.ok) fail("check run create", response);
  const data = await json(response);
  if (typeof data.id !== "number") {
    throw new DependencyReviewGithubError("check run id missing", response.status, true);
  }
  return data.id;
}

export async function updateCheckRun(
  token: string,
  repo: RepositoryRef,
  checkRunId: number,
  state: CheckRunState,
  detailsUrl: string | null,
): Promise<void> {
  const response = await reliableFetch(`${repoPath(repo)}/check-runs/${checkRunId}`, {
    method: "PATCH",
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    redirect: "manual",
    body: JSON.stringify(checkRunBody(state, detailsUrl)),
    retryMethods: ["PATCH"],
  });
  if (!response.ok) fail("check run update", response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * The newest run named `name` that `appId` posted on a commit. GitHub's
 * required checks read the newest run of a name, so a review only decides the
 * commit when its run is this one. Run ids only grow, so the newest is the
 * highest.
 */
export async function latestCheckRun(
  token: string,
  repo: RepositoryRef,
  headSha: string,
  name: string,
  appId: string,
): Promise<{ id: number; externalId: string | null } | null> {
  const query = new URLSearchParams({ check_name: name, app_id: appId, filter: "latest" });
  const response = await reliableFetch(
    `${repoPath(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?${query}`,
    { headers: githubHeaders(token), redirect: "manual" },
  );
  if (!response.ok) fail("check run listing", response);
  const data = await json(response);
  const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
  let newest: { id: number; externalId: string | null } | null = null;
  for (const run of runs) {
    if (!isRecord(run) || typeof run.id !== "number") continue;
    if (newest === null || run.id > newest.id) {
      newest = {
        id: run.id,
        externalId: typeof run.external_id === "string" ? run.external_id : null,
      };
    }
  }
  return newest;
}

/** Whether `sha` is the tip of any branch in the repository. */
export async function isBranchHead(
  token: string,
  repo: RepositoryRef,
  sha: string,
): Promise<boolean> {
  const response = await reliableFetch(
    `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/branches-where-head`,
    { headers: githubHeaders(token), redirect: "manual" },
  );
  if (response.status === 404 || response.status === 422) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  if (!response.ok) fail("branch head lookup", response);
  const data = await readBoundedJson(response, {
    maxBytes: MAX_METADATA_BYTES,
    deadlineMs: Date.now() + BODY_DEADLINE_MS,
  });
  return Array.isArray(data) && data.length > 0;
}

/**
 * Whether `login` can push to the repository. Approval authority for a held
 * dependency update is repository write access, the same bar as merging it.
 */
export async function hasRepositoryWriteAccess(
  token: string,
  repo: RepositoryRef,
  login: string,
): Promise<boolean> {
  const response = await reliableFetch(
    `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
    { headers: githubHeaders(token), redirect: "manual" },
  );
  if (response.status === 404 || response.status === 403) return false;
  if (!response.ok) fail("permission lookup", response);
  const data = await json(response);
  const permission = typeof data.permission === "string" ? data.permission : "";
  return permission === "admin" || permission === "maintain" || permission === "write";
}
