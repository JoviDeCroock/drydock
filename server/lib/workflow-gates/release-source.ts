/**
 * Where a gated release's source came from, as GitHub reports it: whether the
 * commit the run built is on a protected branch, and whether the tag the run
 * was started from still names that commit.
 *
 * Provenance names the repository, workflow, ref and commit a package was
 * built from; it does not say anyone reviewed that commit. bee-js 13.3.0 was
 * built from a commit on no branch at all, tagged and released through the
 * project's own trusted-publishing workflow; WPPConnect 2.4.1's tag was moved
 * to a clean-looking commit after publish. Both carried valid provenance.
 *
 * Reads use the installation token in the control plane only. Every failure
 * (missing Contents permission, a GitHub error, an oversized response) reads
 * as unknown and emits nothing, like the other `release.*` rules: an outage
 * must not look like evidence.
 */
import { githubHeaders } from "../github-app/client";
import { readBoundedJson } from "../platform/bounded-body";
import { reliableFetch } from "../platform/reliable-fetch";
import { DETERMINISTIC_RULES_VERSION } from "../review/rules";
import { tag as tagFinding } from "../review/rules/helpers";
import type { Finding } from "../review";
import { RELEASE_PROCESS_FINDING_FILE } from "../release-fingerprint";

// Compare requests per review. Repositories rarely protect more than a few
// branches; past this the answer is unknown rather than a guess.
const MAX_PROTECTED_BRANCHES = 10;
// Annotated tags can point at other tags; GitHub itself stops nesting early.
const MAX_TAG_DEREFERENCES = 4;
// The compare body carries commits and (on page 1) files; page 2 of a
// one-commit page omits files, so this only has to hold metadata.
const MAX_GITHUB_JSON_BYTES = 1024 * 1024;
const GITHUB_READ_TIMEOUT_MS = 10_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

interface ReleaseTagState {
  name: string;
  /** Commit the tag resolves to now; null when the tag no longer exists. */
  commitSha: string | null;
}

type CommitProtection =
  /** Reachable from this protected branch (or the default branch when none is protected). */
  | { status: "protected"; branch: string }
  | { status: "unprotected"; repositoryProtectsBranches: boolean; defaultBranch: string }
  | { status: "unknown" };

export interface GateReleaseSource {
  headSha: string;
  event: string | null;
  /** Present when the run was started from a tag (a release, or a tag push). */
  tag: ReleaseTagState | null;
  protection: CommitProtection;
}

class GithubReadUnavailable extends Error {
  constructor(
    message: string,
    /** The installation may not read this: a re-check later would fail the same way. */
    readonly denied = false,
  ) {
    super(message);
  }
}

/**
 * Read the gated run's release source. Null when the run itself cannot be read;
 * individual unknowns (protection, tag) are carried inside the result.
 */
export async function inspectGateReleaseSource(
  token: string,
  repositoryFullName: string,
  runId: number,
  /**
   * A tag an earlier review of this run already bound. A retried review must
   * not lose it: a tag deleted after that review is exactly the evidence the
   * retry should show.
   */
  boundTagName?: string | null,
): Promise<GateReleaseSource | null> {
  const api = githubApi(token, repositoryFullName);
  if (!api) return null;
  let run: { headSha: string; headBranch: string | null; event: string | null };
  try {
    run = await readRun(api, runId);
  } catch {
    return null;
  }
  const knownTagRun = Boolean(
    run.headBranch && (run.event === "release" || run.headBranch === boundTagName),
  );
  const [tag, protection] = await Promise.all([
    readRunTag(api, run, knownTagRun).catch((err: unknown) =>
      err instanceof GithubReadUnavailable && err.denied ? null : undefined,
    ),
    readCommitProtection(api, run.headSha).catch((): CommitProtection => ({ status: "unknown" })),
  ]);
  return {
    headSha: run.headSha,
    event: run.event,
    // A transient lookup failure on a known tag run still binds the tag: GitHub
    // started the run at the commit the tag named, so approval can re-check it.
    // A denied read (no Contents permission) binds nothing, or every approval
    // re-check would fail the same way. Otherwise a failed lookup reads as "not
    // known to be a tag run".
    tag:
      tag === undefined
        ? knownTagRun
          ? { name: run.headBranch!, commitSha: run.headSha }
          : null
        : tag,
    protection,
  };
}

/** The commit a tag names now, or null when the tag is gone. Throws when GitHub cannot say. */
export async function resolveTagCommit(
  token: string,
  repositoryFullName: string,
  tagName: string,
): Promise<string | null> {
  const api = githubApi(token, repositoryFullName);
  if (!api) throw new GithubReadUnavailable("invalid repository name");
  return resolveRef(api, "tags", tagName);
}

export function releaseSourceFindings(source: GateReleaseSource | null): Finding[] {
  if (!source) return [];
  const findings: Finding[] = [];
  const short = source.headSha.slice(0, 12);

  if (source.tag && source.tag.commitSha !== source.headSha) {
    const now = source.tag.commitSha
      ? `now points at ${source.tag.commitSha.slice(0, 12)}`
      : "no longer exists";
    findings.push(
      stamp(
        tagFinding("releaseTagMismatch", {
          severity: "high",
          file: RELEASE_PROCESS_FINDING_FILE,
          evidence: `the run was started from tag ${source.tag.name} and built ${short}; the tag ${now}`,
          reason:
            "the tag a reader would review no longer names the commit these bytes were built from; a tag moved or deleted after the build hides what was released (WPPConnect 2.4.1's tag was moved to a clean-looking commit after publish). Review the built commit, not the tag",
        }),
      ),
    );
  }

  const protection = source.protection;
  if (protection.status === "unprotected") {
    findings.push(
      stamp(
        tagFinding("releaseUnprotectedCommit", {
          severity: protection.repositoryProtectsBranches ? "medium" : "low",
          file: RELEASE_PROCESS_FINDING_FILE,
          evidence: protection.repositoryProtectsBranches
            ? `commit ${short} is not on any protected branch`
            : `commit ${short} is not on the default branch ${protection.defaultBranch}, and the repository protects no branch`,
          reason: protection.repositoryProtectsBranches
            ? "the release was built from a commit that never went through the repository's branch protection, so no pull-request review or status check applies to it (bee-js 13.3.0 was built from a commit on no branch at all). A release from an unprotected maintenance branch has the same shape; confirm where this commit came from"
            : "the release was built from a commit outside the default branch, and no branch protection exists that would have reviewed it; context about the release path, not release risk",
        }),
      ),
    );
  }
  return findings;
}

function stamp(finding: Finding): Finding {
  return { ...finding, ruleVersion: DETERMINISTIC_RULES_VERSION };
}

interface GithubApi {
  get(path: string): Promise<{ status: number; body: unknown }>;
}

function githubApi(token: string, repositoryFullName: string): GithubApi | null {
  const [owner, repo, ...rest] = repositoryFullName.split("/");
  if (!owner || !repo || rest.length) return null;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    async get(path) {
      const response = await reliableFetch(`${base}${path}`, {
        headers: githubHeaders(token),
        redirect: "manual",
        timeoutMs: GITHUB_READ_TIMEOUT_MS,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, body: null };
      }
      const body = await readBoundedJson(response, {
        maxBytes: MAX_GITHUB_JSON_BYTES,
        deadlineMs: Date.now() + GITHUB_READ_TIMEOUT_MS,
      });
      if (body === null) throw new GithubReadUnavailable(`unreadable body for ${path}`);
      return { status: response.status, body };
    },
  };
}

async function readRun(api: GithubApi, runId: number) {
  const { status, body } = await api.get(`/actions/runs/${runId}`);
  if (status !== 200 || !isRecord(body) || body.id !== runId) {
    throw new GithubReadUnavailable(`run ${runId} unreadable (${status})`);
  }
  const headSha = typeof body.head_sha === "string" ? body.head_sha.toLowerCase() : "";
  if (!SHA_PATTERN.test(headSha)) throw new GithubReadUnavailable("run has no head sha");
  return {
    headSha,
    headBranch: typeof body.head_branch === "string" && body.head_branch ? body.head_branch : null,
    event: typeof body.event === "string" ? body.event : null,
  };
}

/**
 * The run object names its ref only by short name (`head_branch`), for tags
 * too. A `release` run, or one whose tag an earlier review bound, is a tag
 * run. Any other event is a tag run when
 * a tag of that name exists and no branch does; a deleted tag on a non-release
 * run cannot be told apart from a branch run, so it stays unknown.
 */
async function readRunTag(
  api: GithubApi,
  run: { headBranch: string | null; event: string | null },
  knownTagRun: boolean,
): Promise<ReleaseTagState | null> {
  const name = run.headBranch;
  if (!name) return null;
  const commitSha = await resolveRef(api, "tags", name);
  if (knownTagRun) return { name, commitSha };
  if (commitSha === null) return null;
  const branchSha = await resolveRef(api, "heads", name);
  return branchSha === null ? { name, commitSha } : null;
}

async function resolveRef(
  api: GithubApi,
  namespace: "tags" | "heads",
  name: string,
): Promise<string | null> {
  const { status, body } = await api.get(`/git/ref/${namespace}/${encodeRefName(name)}`);
  if (status === 404) return null;
  if (status !== 200) {
    throw new GithubReadUnavailable(
      `ref lookup failed (${status})`,
      status === 401 || status === 403,
    );
  }
  let object = isRecord(body) && isRecord(body.object) ? body.object : null;
  for (let depth = 0; object && object.type === "tag"; depth += 1) {
    if (depth >= MAX_TAG_DEREFERENCES || typeof object.sha !== "string") {
      throw new GithubReadUnavailable("tag nesting too deep");
    }
    const tag = await api.get(`/git/tags/${encodeURIComponent(object.sha)}`);
    if (tag.status !== 200)
      throw new GithubReadUnavailable(`tag object unreadable (${tag.status})`);
    object = isRecord(tag.body) && isRecord(tag.body.object) ? tag.body.object : null;
  }
  // A tag naming a tree or blob still resolves to an object id; it just never
  // equals the commit the run built.
  if (!object || typeof object.sha !== "string") {
    throw new GithubReadUnavailable("ref names no object");
  }
  return object.sha.toLowerCase();
}

/**
 * Protected branches when the repository has any, else the default branch.
 * An unprotected default branch is not counted when other branches are
 * protected: it is where bee-js's maintainer could force-push.
 */
async function readCommitProtection(api: GithubApi, headSha: string): Promise<CommitProtection> {
  const repository = await api.get("");
  if (repository.status !== 200 || !isRecord(repository.body)) return { status: "unknown" };
  const defaultBranch =
    typeof repository.body.default_branch === "string" ? repository.body.default_branch : "";
  if (!defaultBranch) return { status: "unknown" };

  const listed = await api.get(`/branches?protected=true&per_page=${MAX_PROTECTED_BRANCHES + 1}`);
  if (listed.status !== 200 || !Array.isArray(listed.body)) return { status: "unknown" };
  if (listed.body.length > MAX_PROTECTED_BRANCHES) return { status: "unknown" };
  const protectedBranches: { name: string; sha: string | null }[] = [];
  for (const entry of listed.body) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const sha = isRecord(entry.commit) ? commitSha(entry.commit.sha) : null;
    protectedBranches.push({ name: entry.name, sha });
  }

  const candidates = protectedBranches.length
    ? protectedBranches
    : [{ name: defaultBranch, sha: null }];
  // The default branch first: it is the likeliest home of a release commit.
  candidates.sort((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch));
  let undetermined = false;
  for (const branch of candidates) {
    // Compare against the branch tip's commit id, never its bare name: git
    // resolves a bare name to a tag first, so a pushed tag called `main`
    // would otherwise stand in for the protected branch.
    const tip = branch.sha ?? (await resolveRef(api, "heads", branch.name).catch(() => null));
    const contained = tip ? await branchContains(api, tip, headSha) : null;
    if (contained) return { status: "protected", branch: branch.name };
    if (contained === null) undetermined = true;
  }
  if (undetermined) return { status: "unknown" };
  return {
    status: "unprotected",
    repositoryProtectsBranches: protectedBranches.length > 0,
    defaultBranch,
  };
}

/** Whether `sha` is `tipSha` or one of its ancestors; null when GitHub cannot say. */
async function branchContains(
  api: GithubApi,
  tipSha: string,
  sha: string,
): Promise<boolean | null> {
  // Page 2 of a one-commit page leaves out the changed-files list, which on a
  // large comparison is most of the body; `status` is on every page.
  const { status, body } = await api.get(`/compare/${tipSha}...${sha}?per_page=1&page=2`);
  // GitHub answers 404 when the two commits share no history; a parentless
  // release commit is exactly what this check exists to notice.
  if (status === 404) return false;
  if (status !== 200 || !isRecord(body) || typeof body.status !== "string") return null;
  if (body.status === "identical" || body.status === "behind") return true;
  if (body.status === "ahead" || body.status === "diverged") return false;
  return null;
}

function commitSha(value: unknown): string | null {
  const sha = typeof value === "string" ? value.toLowerCase() : "";
  return SHA_PATTERN.test(sha) ? sha : null;
}

/** Ref names may contain `/`; each segment is encoded on its own. */
function encodeRefName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
