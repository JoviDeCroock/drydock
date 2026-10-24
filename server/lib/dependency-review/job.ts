import { packageDiffPath } from "../../../src/lib/package-diff-path";
import { createDb, type AppDb } from "../../db/client";
import {
  claimDependencyReview,
  completeDependencyReview,
  dependencyChangeKey,
  failDependencyReview,
  findApprovedChanges,
  getDependencyReview,
  getDependencyReviewForHead,
  getDependencyReviewSettings,
  isChangeApproved,
  readDependencyReviewResult,
  recordDependencyApprovals,
  releaseDependencyReview,
  setDependencyReviewCheckRun,
  supersedeDependencyReview,
  type DependencyReviewRecord,
} from "../../db/dependency-reviews";
import type { DependencyReviewStatus } from "../../db/enums";
import { recordScanEvent } from "../../db/events";
import { recordProductEvent } from "../analytics";
import { getPublicDiffAdapter } from "../ecosystems";
import { getInstallationAccessToken } from "../github-app/api";
import { readGithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import { parseRepositoryFullName } from "../github-app/validation";
import { dependencyReviewUrl, publicDiffUrl } from "../notify/links";
import { mapWithConcurrency } from "../platform/concurrency";
import { isRecord } from "../platform/guards";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { loadPublicPackageDiff, publicDiffEgressAllowed, PublicDiffError } from "../public-diff";
import {
  createCheckRun,
  DependencyReviewGithubError,
  fetchMergeBase,
  fetchPullRequest,
  hasRepositoryWriteAccess,
  isBranchHead,
  latestCheckRun,
  listPullRequestFiles,
  readRepositoryFile,
  updateCheckRun,
  type CheckRunState,
  type PullRequestFile,
  type RepositoryRef,
} from "./github";
import {
  diffLockfileSnapshots,
  lockfileKindForPath,
  parseLockfile,
  unpinnedRequirementsChanged,
} from "./lockfiles";
import {
  concludeDependencyReview,
  evaluateBumpEvidence,
  extractBumpEvidence,
  newPackageVerdict,
  unreviewedVerdict,
} from "./policy";
import {
  collectCustomRegistries,
  emptyCustomRegistries,
  isPublicNpmName,
  type CustomRegistries,
} from "./registry-config";
import {
  APPROVE_ACTION_IDENTIFIER,
  DEPENDENCY_REVIEW_CHECK_NAME,
  listsEveryHold,
  renderDependencyReviewCheck,
  SKIP_EXTERNAL_ID_PREFIX,
  type CheckRunOutput,
  type RenderDependencyReviewInput,
} from "./render";
import type {
  BumpVerdict,
  DependencyBump,
  DependencyEcosystem,
  DependencyReviewConclusion,
  DependencyReviewPolicy,
  LockfileKind,
  ReviewedBump,
  UnreviewedReason,
} from "./types";

// Cold diffs run the sandbox, so both the count and the concurrency are
// bounded; cached pairs (the common case for popular bumps) cost a KV read.
const MAX_REVIEWED_BUMPS = 40;
const DIFF_CONCURRENCY = 4;
const MAX_LOCKFILES = 20;
// npm and PyPI lockfiles Drydock can't parse. A PR that changes one is not
// "nothing to review": it is unread, and holds like any unreviewed bump.
const UNPARSED_LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|poetry\.lock|Pipfile\.lock|pdm\.lock|pylock(?:\.[^/]+)?\.toml)$/;
// Manifests a dependency bot edits. One changed with no parsed lockfile of its
// ecosystem at or above its directory (a library without a lockfile, or a
// Python project in a PR that only touched npm's) names versions nothing here
// resolved.
const NPM_MANIFEST = /(?:^|\/)package\.json$/;
const PYPI_MANIFEST = /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|[^/]+\.in)$/;
// pip follows `-r`/`-c` into files of any name, and a bot edits those too. A
// `.txt` a dependency bot changed is read as requirements: anything in it that
// isn't a pin is compared as text, so a file that isn't one holds, not passes.
const OTHER_REQUIREMENTS = /\.txt$/;
// Under the queue consumer's wall-clock limit with room to post the result.
const DIFF_BUDGET_MS = 8 * 60 * 1000;
// Bounds what is persisted per review, holds first. Approve is only offered
// when the check shows every hold (`listsEveryHold`), far below this.
const MAX_STORED_BUMPS = 500;

const KIND_ECOSYSTEM: Record<LockfileKind, DependencyEcosystem> = {
  npm: "npm",
  pnpm: "npm",
  yarn: "npm",
  uv: "pypi",
  requirements: "pypi",
};

export interface DependencyReviewJobInput {
  organizationId: string;
  reviewId?: string;
  // Re-run a completed review (the check's Re-run button, or a skip raced it).
  rerun?: boolean;
  // `checkRunId` is the run clicked; a Re-run since then made it history.
  approver?: { login: string; githubId: number; checkRunId?: number };
  // A PR no dependency bot opened, in an organization that enabled the check.
  skip?: {
    installationRowId: string;
    repositoryId: number;
    repositoryFullName: string;
    headSha: string;
    // Absent counts as a fork: the branch-head check only ever withholds a pass.
    fromFork?: boolean;
    // Absent means no write access is assumed. Both must be writers: the
    // sender of a `synchronize` may have pushed someone else's branch tip.
    authorLogin?: string;
    senderLogin?: string;
  };
}

interface ReviewContext {
  env: Cloudflare.Env;
  ctx: ExecutionContext;
  db: AppDb;
  review: DependencyReviewRecord;
  repo: RepositoryRef;
  token: string;
  appId: string;
  detailsUrl: string | null;
}

/**
 * Review one dependency-update PR commit, or apply an Approve click to a
 * finished review. Retryable GitHub failures rethrow for the queue to retry;
 * anything else fails the review and, when a check run exists, fails the check
 * so the PR never sits on an in-progress run forever.
 */
export async function executeDependencyReviewJob(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: DependencyReviewJobInput,
  options: { finalAttempt: boolean },
  db: AppDb = createDb(env.DB),
): Promise<void> {
  if (input.skip) {
    await postSkippedCheck(env, db, input.organizationId, input.skip);
    return;
  }
  if (!input.reviewId) return;
  const review = await getDependencyReview(db, input.organizationId, input.reviewId);
  if (!review) return;
  const repo = parseRepositoryFullName(review.repositoryFullName);
  if (!repo) {
    await failDependencyReview(db, review.id, "invalid repository name");
    return;
  }
  const installationId = await getInstallationExternalId(
    db,
    review.installationRowId,
    review.organizationId,
  );
  if (!installationId) {
    await failDependencyReview(db, review.id, "installation missing");
    return;
  }
  const appConfig = readGithubAppConfig(env);
  const token = await getInstallationAccessToken(appConfig, installationId);
  const context: ReviewContext = {
    env,
    ctx,
    db,
    review,
    repo,
    token,
    appId: appConfig.appId,
    detailsUrl: dependencyReviewUrl(env, review.id, review.organizationId),
  };

  if (input.approver) {
    await applyApproval(context, input.approver);
    return;
  }
  if (!(await claimDependencyReview(db, review.id, { rerun: input.rerun }))) {
    // A re-run asked for while another attempt runs must still happen: that
    // attempt may already have published under a run that is no longer newest.
    if (input.rerun && review.status === "running" && !options.finalAttempt) {
      throw new DependencyReviewGithubError("review is running; re-run later", 409, true);
    }
    return;
  }
  // Another attempt may have moved the review to a newer run since it was read.
  context.review = (await getDependencyReview(db, review.organizationId, review.id)) ?? review;
  try {
    await runReview(context, review.status);
  } catch (err) {
    const retryable = err instanceof DependencyReviewGithubError ? err.retryable : true;
    if (retryable && !options.finalAttempt) {
      await releaseDependencyReview(db, review.id);
      throw err;
    }
    await failReview(context, err);
  }
}

async function runReview(
  context: ReviewContext,
  statusBeforeClaim: DependencyReviewStatus,
): Promise<void> {
  const { db, review, repo, token } = context;
  const startedAtMs = Date.now();
  const checkRunId = await ensureCheckRun(context, statusBeforeClaim);

  const pr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!pr || pr.headSha !== review.headSha || pr.state !== "open") {
    // Not `neutral`: GitHub counts that as passing, and a PR closed when this
    // ran and reopened later would carry a passing check nobody earned.
    // Reopening or Re-run reviews the commit again.
    await updateCheckRun(
      token,
      repo,
      checkRunId,
      {
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Not reviewed",
          summary:
            "This commit was not the head of an open PR when Drydock ran. Use Re-run if it is.",
        },
      },
      context.detailsUrl,
    );
    await supersedeDependencyReview(db, review.id);
    return;
  }

  const settings = await getDependencyReviewSettings(db, review.organizationId);
  const collected = await collectBumps(context, pr.baseSha, pr.changedFiles);
  const approvedChanges = await findApprovedChanges(
    db,
    review.organizationId,
    review.repositoryId,
    collected.bumps,
  );
  const verdicts = await reviewBumps(context, collected.bumps, settings.policy, startedAtMs);
  const reviewed: ReviewedBump[] = collected.bumps.map((bump, index) => {
    const verdict = verdicts[index];
    return {
      bump,
      verdict,
      approved: verdict.status === "hold" && isChangeApproved(approvedChanges, bump),
    };
  });

  let conclusion = concludeDependencyReview(reviewed);
  // An unread lockfile, or a listing GitHub cut short, may hide bumps, so the
  // review can't call the PR clear on what it saw.
  const partial = collected.unreadLockfiles.length > 0 || !collected.listingComplete;
  if (partial && settings.policy.holdOnUnreviewed && conclusion !== "held") {
    conclusion = "held";
  }
  // A later attempt owns the newest run; its result is the one to store.
  if (!(await publishResult(context, checkRunId, reviewed, conclusion, collected, null))) return;
  await completeDependencyReview(db, review.id, {
    conclusion,
    bumps: storedBumps(reviewed),
    coverage: {
      unreadLockfiles: collected.unreadLockfiles,
      listingComplete: collected.listingComplete,
    },
  });
  recordProductEvent(context.env, {
    name: "dependency_review.completed",
    organizationId: review.organizationId,
    conclusion,
    bumpCount: reviewed.length,
    heldCount: reviewed.filter((b) => b.verdict.status === "hold" && !b.approved).length,
    durationMs: Date.now() - startedAtMs,
  });
}

function isOpenHold(bump: ReviewedBump): boolean {
  return bump.verdict.status === "hold" && !bump.approved;
}

function storedBumps(reviewed: readonly ReviewedBump[]): ReviewedBump[] {
  return [...reviewed.filter(isOpenHold), ...reviewed.filter((b) => !isOpenHold(b))].slice(
    0,
    MAX_STORED_BUMPS,
  );
}

async function ensureCheckRun(
  context: ReviewContext,
  statusBeforeClaim: DependencyReviewStatus,
): Promise<number> {
  const { review, repo, token } = context;
  const inProgress: CheckRunState = {
    status: "in_progress",
    output: {
      title: "Reviewing dependency changes",
      summary: "Drydock is diffing the package versions this PR changes.",
    },
  };
  // A run this review already finished (completed, failed, or cancelled as
  // superseded) is left as history: a Re-run gets a new check run, which is
  // also what GitHub's Re-run button shows.
  if (review.checkRunId && (statusBeforeClaim === "queued" || statusBeforeClaim === "running")) {
    await updateCheckRun(token, repo, review.checkRunId, inProgress, context.detailsUrl);
    return review.checkRunId;
  }
  const checkRunId = await createCheckRun(
    token,
    repo,
    {
      name: DEPENDENCY_REVIEW_CHECK_NAME,
      headSha: review.headSha,
      externalId: review.id,
      detailsUrl: context.detailsUrl,
    },
    inProgress,
  );
  await setDependencyReviewCheckRun(context.db, review.id, checkRunId);
  context.review = { ...review, checkRunId };
  return checkRunId;
}

interface CollectedBumps {
  bumps: DependencyBump[];
  // Lockfiles the PR changes whose bumps are unknown: an unparsed format, over
  // the per-review or size cap, or a snapshot the parser couldn't finish.
  unreadLockfiles: string[];
  listingComplete: boolean;
}

/**
 * The version changes the PR merges, from each supported lockfile read at the
 * merge base and at the head. The merge base, not the base branch tip, is the
 * "before" side, so commits that landed on the base branch after the PR was
 * opened don't read as bumps.
 */
async function collectBumps(
  context: ReviewContext,
  baseSha: string,
  changedFiles: number | null,
): Promise<CollectedBumps> {
  const { review, repo, token } = context;
  const listing = await listPullRequestFiles(token, repo, review.pullNumber);
  const { files } = listing;
  // GitHub's files listing stops at 3,000 entries without saying so; the PR's
  // own count is what shows the listing was cut short.
  const complete = listing.complete && (changedFiles === null || files.length >= changedFiles);
  const changed = files.filter((file) => file.status !== "removed");
  const lockfiles: Array<{ file: PullRequestFile; kind: LockfileKind }> = [];
  for (const file of changed) {
    if (UNPARSED_LOCKFILE.test(file.filename)) continue;
    const kind =
      lockfileKindForPath(file.filename) ??
      (OTHER_REQUIREMENTS.test(file.filename) ? "requirements" : null);
    if (kind) lockfiles.push({ file, kind });
  }
  const unreadLockfiles: string[] = [
    ...changed.filter((file) => UNPARSED_LOCKFILE.test(file.filename)).map((file) => file.filename),
    ...lockfiles.slice(MAX_LOCKFILES).map(({ file }) => file.filename),
    // A deleted lockfile's packages now resolve from wherever the manifest says.
    ...files
      .filter(
        (file) =>
          file.status === "removed" &&
          (lockfileKindForPath(file.filename) || UNPARSED_LOCKFILE.test(file.filename)),
      )
      .map((file) => file.filename),
  ];
  const heads: HeadLockfile[] = lockfiles.slice(MAX_LOCKFILES).map(({ file, kind }) => ({
    path: file.filename,
    kind,
    text: null,
    manifest: null,
    fallback: !lockfileKindForPath(file.filename),
  }));
  if (lockfiles.length === 0) {
    unreadLockfiles.push(...uncoveredManifests(changed, heads));
    return { bumps: [], unreadLockfiles, listingComplete: complete };
  }

  const mergeBase = await fetchMergeBase(token, repo, baseSha, review.headSha);
  const registries = new Map<string, Promise<CustomRegistries>>();
  const byChange = new Map<string, DependencyBump>();
  for (const { file, kind } of lockfiles.slice(0, MAX_LOCKFILES)) {
    const fallback = !lockfileKindForPath(file.filename);
    const beforePath = file.status === "added" ? null : (file.previousFilename ?? file.filename);
    const [before, after] = await Promise.all([
      beforePath ? readLockfileText(context, kind, beforePath, mergeBase) : null,
      readLockfileText(context, kind, file.filename, review.headSha),
    ]);
    if (before === "too-large" || after === "too-large" || after === null) {
      unreadLockfiles.push(file.filename);
      heads.push({ path: file.filename, kind, text: null, manifest: null, fallback });
      continue;
    }
    heads.push({ path: file.filename, kind, text: after.text, manifest: after.manifest, fallback });
    const baseSnapshot = before
      ? parseLockfile(kind, before.text, { manifestText: before.manifest })
      : null;
    const headSnapshot = parseLockfile(kind, after.text, { manifestText: after.manifest });
    // A capped or unparseable side diffs to nothing, which must not read as
    // "nothing changed".
    if (!headSnapshot.complete || (baseSnapshot && !baseSnapshot.complete)) {
      unreadLockfiles.push(file.filename);
      continue;
    }
    // A requirements range (`foo>=1.3`) names no version to diff.
    if (unpinnedRequirementsChanged(baseSnapshot, headSnapshot)) {
      unreadLockfiles.push(file.filename);
    }
    let custom: CustomRegistries | null = null;
    if (KIND_ECOSYSTEM[kind] === "npm") {
      const dir = dirname(file.filename);
      if (!registries.has(dir)) registries.set(dir, readCustomRegistries(context, dir));
      custom = await (registries.get(dir) as Promise<CustomRegistries>);
    }
    for (const found of diffLockfileSnapshots(baseSnapshot, headSnapshot, file.filename)) {
      // A name the repository routes to another registry is kept, never
      // diffed: dropping it would let its change pass unseen.
      const bump: DependencyBump =
        custom && !isPublicNpmName(custom, found.name) ? { ...found, privateSource: true } : found;
      const key = dependencyChangeKey(bump);
      const existing = byChange.get(key);
      if (existing) existing.direct ||= bump.direct;
      else byChange.set(key, { ...bump });
    }
  }
  unreadLockfiles.push(...uncoveredManifests(changed, heads));
  // Direct bumps first: when the per-review cap bites, it bites transitive churn.
  const bumps = [...byChange.values()].sort(
    (a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name),
  );
  return { bumps, unreadLockfiles, listingComplete: complete };
}

async function readLockfileText(
  context: ReviewContext,
  kind: LockfileKind,
  path: string,
  ref: string,
): Promise<{ text: string; manifest: string | null } | "too-large" | null> {
  const text = await readRepositoryFile(context.token, context.repo, path, ref);
  if (text === null || text === "too-large") return text;
  if (kind !== "yarn") return { text, manifest: null };
  const manifest = await readRepositoryFile(
    context.token,
    context.repo,
    `${dirname(path)}package.json`,
    ref,
  );
  return { text, manifest: typeof manifest === "string" ? manifest : null };
}

async function readCustomRegistries(
  context: ReviewContext,
  dir: string,
): Promise<CustomRegistries> {
  const found = emptyCustomRegistries();
  for (const base of new Set([dir, ""])) {
    const [npmrc, yarnrc] = await Promise.all([
      readRepositoryFile(context.token, context.repo, `${base}.npmrc`, context.review.headSha),
      readRepositoryFile(context.token, context.repo, `${base}.yarnrc.yml`, context.review.headSha),
    ]);
    // Config too large to read could name any registry, so it drops every name.
    if (npmrc === "too-large" || yarnrc === "too-large") return { all: true, scopes: new Set() };
    collectCustomRegistries(found, { npmrc, yarnrc });
  }
  return found;
}

interface HeadLockfile {
  path: string;
  kind: LockfileKind;
  // Null when the lockfile went unread, which already holds the review.
  text: string | null;
  manifest: string | null;
  // A `.txt` read as requirements only because a bot changed it.
  fallback: boolean;
}

/**
 * Changed manifests no changed lockfile resolves. A lockfile covers a manifest
 * in its own directory, or below it only when it records that directory as a
 * workspace: a root lockfile says nothing about a sibling project with none.
 */
function uncoveredManifests(
  changed: readonly PullRequestFile[],
  heads: readonly HeadLockfile[],
): string[] {
  const workspaces = new Map<HeadLockfile, (dir: string) => boolean>();
  const covers = (head: HeadLockfile, manifest: string) => {
    if (head.fallback) return false;
    const manifestDir = dirname(manifest);
    const lockDir = dirname(head.path);
    // A requirements file pins what it lists, not what a pyproject beside it
    // declares, unless it was compiled from that manifest (pip-compile names
    // its sources in the header).
    if (head.kind === "requirements") {
      if (manifestDir !== lockDir) return false;
      const name = manifest.slice(manifestDir.length);
      const pairedIn = name === `${head.path.slice(lockDir.length).replace(/\.txt$/, "")}.in`;
      return pairedIn || compiledFrom(head.text, name);
    }
    if (manifestDir === lockDir) return true;
    if (!manifestDir.startsWith(lockDir)) return false;
    if (head.text === null) return true;
    let isWorkspace = workspaces.get(head);
    if (!isWorkspace) {
      isWorkspace = workspaceMatcher(head.kind, head.text, head.manifest);
      workspaces.set(head, isWorkspace);
    }
    return isWorkspace(manifestDir.slice(lockDir.length, -1));
  };
  const covered = (ecosystem: DependencyEcosystem, manifest: string) =>
    heads.some((head) => KIND_ECOSYSTEM[head.kind] === ecosystem && covers(head, manifest));
  return changed
    .map((file) => file.filename)
    .filter(
      (path) =>
        (NPM_MANIFEST.test(path) && !covered("npm", path)) ||
        (PYPI_MANIFEST.test(path) && !covered("pypi", path)),
    );
}

// pip-compile and `uv pip compile` write their command line into the leading
// comment block, naming the inputs the file was resolved from.
const COMPILE_COMMAND = /^#\s+(?:pip-compile|uv pip compile)\s/;

function compiledFrom(text: string | null, manifestName: string): boolean {
  if (text === null) return true;
  for (const line of text.split("\n", 40)) {
    if (!line.startsWith("#")) break;
    if (COMPILE_COMMAND.test(line) && line.split(/\s+/).includes(manifestName)) return true;
  }
  return false;
}

const PNPM_IMPORTER = /^ {2}(['"]?)(.+?)\1:\s*$/;
const UV_LOCAL_SOURCE = /source = \{ (?:editable|virtual|directory) = "([^"]+)" \}/g;
const BERRY_WORKSPACE = /@workspace:([^"]+)"/g;

/** Which directories, relative to the lockfile's, it records as workspaces. */
function workspaceMatcher(
  kind: LockfileKind,
  text: string,
  manifest: string | null,
): (dir: string) => boolean {
  const dirs = new Set<string>();
  const normalize = (dir: string) => dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (kind === "npm") {
    const parsed = parseJson(text);
    const packages = isRecord(parsed) && isRecord(parsed.packages) ? parsed.packages : {};
    for (const key of Object.keys(packages)) {
      if (key && !key.includes("node_modules/")) dirs.add(key);
    }
  } else if (kind === "pnpm") {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trimEnd() === "importers:");
    for (let index = start + 1; start >= 0 && index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line)) break;
      const match = PNPM_IMPORTER.exec(line);
      if (match) dirs.add(normalize(match[2]));
    }
  } else if (kind === "uv") {
    for (const match of text.matchAll(UV_LOCAL_SOURCE)) dirs.add(normalize(match[1]));
  } else if (kind === "yarn") {
    for (const match of text.matchAll(BERRY_WORKSPACE)) dirs.add(normalize(match[1]));
    const globs = yarnWorkspaceGlobs(manifest);
    return (dir) => dirs.has(dir) || (dir.length <= 512 && globs.some((glob) => glob.test(dir)));
  }
  return (dir) => dirs.has(dir);
}

// Yarn v1 lockfiles don't list workspaces; the root manifest's globs do. One
// `*` per segment and one `**` keep matching linear in the path.
function yarnWorkspaceGlobs(manifest: string | null): RegExp[] {
  const parsed = manifest ? parseJson(manifest) : null;
  const field = isRecord(parsed) ? parsed.workspaces : null;
  const list = Array.isArray(field) ? field : isRecord(field) ? field.packages : null;
  if (!Array.isArray(list)) return [];
  const globs: RegExp[] = [];
  for (const glob of list.slice(0, 100)) {
    if (typeof glob !== "string" || glob.length > 200) continue;
    const parts = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
    const doubleStars = parts.filter((part) => part === "**").length;
    if (
      doubleStars > 1 ||
      parts.some((part) => (part.match(/\*/g)?.length ?? 0) > 1 && part !== "**")
    ) {
      continue;
    }
    const pattern = parts
      .map((part) => (part === "**" ? ".*" : escapeRegExp(part).replace("\\*", "[^/]*")))
      .join("/");
    globs.push(new RegExp(`^${pattern}$`));
  }
  return globs;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dirname(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

async function reviewBumps(
  context: ReviewContext,
  bumps: readonly DependencyBump[],
  policy: DependencyReviewPolicy,
  startedAtMs: number,
): Promise<BumpVerdict[]> {
  const deadline = startedAtMs + DIFF_BUDGET_MS;
  let diffed = 0;
  const plan = bumps.map((bump) => {
    if (bump.fromVersion === null || bump.privateSource) return { bump, review: false as const };
    diffed += 1;
    return { bump, review: diffed <= MAX_REVIEWED_BUMPS };
  });
  return mapWithConcurrency(plan, DIFF_CONCURRENCY, async ({ bump, review }) => {
    if (bump.privateSource) return unreviewedVerdict("private-source", policy);
    if (bump.fromVersion === null) return newPackageVerdict(policy);
    if (!review) return unreviewedVerdict("over-cap", policy);
    if (Date.now() > deadline) return unreviewedVerdict("timed-out", policy);
    const outcome = await diffBump(context, bump, bump.fromVersion);
    return typeof outcome === "string"
      ? unreviewedVerdict(outcome, policy)
      : evaluateBumpEvidence(outcome, policy);
  });
}

async function diffBump(
  context: ReviewContext,
  bump: DependencyBump,
  fromVersion: string,
): Promise<ReturnType<typeof extractBumpEvidence> | UnreviewedReason> {
  if (!publicDiffEgressAllowed(context.env)) return "unsupported";
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  // npm's public diff also accepts preview URLs as versions; a lockfile
  // version never is one.
  if (
    !adapter ||
    !adapter.isValidPackageName(bump.name) ||
    !adapter.isValidVersion(fromVersion) ||
    !adapter.isValidVersion(bump.toVersion) ||
    fromVersion.includes(":") ||
    bump.toVersion.includes(":")
  ) {
    return "unsupported";
  }
  try {
    const diff = await loadPublicPackageDiff(context.env, context.ctx, {
      ecosystem: adapter.ecosystem,
      packageName: adapter.normalizePackageName(bump.name),
      fromVersion,
      toVersion: bump.toVersion,
      registryUrl: adapter.registryUrl,
    });
    return extractBumpEvidence(diff);
  } catch (err) {
    if (err instanceof PublicDiffError) {
      if (err.status === 404) return "not-found";
      if (err.status === 400 || err.status === 413) return "unsupported";
    }
    emitOperationalEvent("warn", "dependency_review.diff_failed", {
      organizationId: context.review.organizationId,
      reviewId: context.review.id,
      ecosystem: bump.ecosystem,
      error: describeOperationalError(err),
    });
    return "failed";
  }
}

async function publishResult(
  context: ReviewContext,
  checkRunId: number,
  reviewed: readonly ReviewedBump[],
  conclusion: DependencyReviewConclusion,
  collected: Pick<CollectedBumps, "unreadLockfiles" | "listingComplete">,
  approvedBy: string | null,
): Promise<boolean> {
  const input = renderInput(context, reviewed, conclusion, collected, approvedBy);
  const approvable = listsEveryHold(input);
  const output: CheckRunOutput = renderDependencyReviewCheck({ ...input, approvable });
  if (!collected.listingComplete) {
    output.summary = `GitHub listed only part of this PR's files, so a lockfile may have gone unread.\n\n${output.summary}`;
  }
  const state: CheckRunState =
    conclusion === "held" && approvable
      ? {
          status: "completed",
          conclusion: "action_required",
          output,
          approveAction: {
            label: "Approve held updates",
            description: "Accept every held update in this PR",
            identifier: APPROVE_ACTION_IDENTIFIER,
          },
        }
      : {
          status: "completed",
          conclusion: conclusion === "held" ? "action_required" : "success",
          output,
        };
  // GitHub reads the newest run of a name on a commit. A skip that raced this
  // review may have landed after our run; the verdict then goes on a fresh run
  // so it is the one that counts. A newer run of this review that the review
  // records belongs to a later attempt (a Re-run), which publishes its own
  // result; one it doesn't record was orphaned (a create whose response was
  // lost) and is adopted.
  const { token, repo, review } = context;
  const newest = await latestCheckRun(
    token,
    repo,
    review.headSha,
    DEPENDENCY_REVIEW_CHECK_NAME,
    context.appId,
  );
  if (newest === null || newest.id === checkRunId) {
    await updateCheckRun(token, repo, checkRunId, state, context.detailsUrl);
    return true;
  }
  if (newest.externalId === review.id) {
    const stored = await getDependencyReview(context.db, review.organizationId, review.id);
    if (stored?.checkRunId === newest.id) return false;
    await updateCheckRun(token, repo, newest.id, state, context.detailsUrl);
    await setDependencyReviewCheckRun(context.db, review.id, newest.id);
    context.review = { ...review, checkRunId: newest.id };
    await cancelReplacedRun(context, checkRunId);
    return true;
  }
  if (!newest.externalId?.startsWith(SKIP_EXTERNAL_ID_PREFIX)) return false;
  const fresh = await createCheckRun(
    token,
    repo,
    {
      name: DEPENDENCY_REVIEW_CHECK_NAME,
      headSha: review.headSha,
      externalId: review.id,
      detailsUrl: context.detailsUrl,
    },
    state,
  );
  await setDependencyReviewCheckRun(context.db, review.id, fresh);
  context.review = { ...review, checkRunId: fresh };
  await cancelReplacedRun(context, checkRunId);
  return true;
}

async function cancelReplacedRun(context: ReviewContext, checkRunId: number): Promise<void> {
  await updateCheckRun(
    context.token,
    context.repo,
    checkRunId,
    {
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Moved to a newer run", summary: "This review's result is on a newer run." },
    },
    context.detailsUrl,
  );
}

function renderInput(
  context: ReviewContext,
  bumps: readonly ReviewedBump[],
  conclusion: DependencyReviewConclusion,
  collected: Pick<CollectedBumps, "unreadLockfiles" | "listingComplete">,
  approvedBy: string | null,
): RenderDependencyReviewInput {
  return {
    bumps,
    conclusion,
    approvedBy,
    unreadLockfiles: collected.unreadLockfiles,
    listingComplete: collected.listingComplete,
    diffUrl: (bump) =>
      bump.fromVersion && !bump.privateSource
        ? publicDiffUrl(
            context.env,
            packageDiffPath(bump.ecosystem, bump.name, bump.fromVersion, bump.toVersion),
          )
        : null,
  };
}

/**
 * A PR no dependency bot opened gets a `skipped` run, which GitHub counts as
 * passing, so making the check required doesn't block people's own PRs.
 *
 * Check runs belong to a commit, not a PR, and GitHub reads the newest run of
 * a name. Anyone can open a PR from a fork at a bot PR's head commit, so a
 * skip must never land on a commit Drydock reviews: none is posted when a
 * review exists, and a review that appears while this posts is re-run so its
 * run is the newest.
 */
async function postSkippedCheck(
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
        title: "Checking the PR's author",
        summary: "Drydock reviews dependency bots' PRs.",
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
            "This PR's head commit is the tip of a branch here, which may be a dependency bot's, and its author can't push to this repository. Push a new commit to the PR to get past this.",
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
          title: "Not a dependency-update PR",
          summary: "Drydock reviews PRs opened by dependency bots. This PR's author is not one.",
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
        summary: "A dependency bot's PR has this commit as its head, so Drydock reviews it.",
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

/**
 * An Approve click. GitHub vouches for who clicked (the webhook is signed),
 * not for whether they may approve, so repository write access is checked
 * here before anything is recorded. Approving a commit that is no longer the
 * PR's head would approve bumps nobody was shown, so that is refused too.
 */
async function applyApproval(
  context: ReviewContext,
  approver: NonNullable<DependencyReviewJobInput["approver"]>,
): Promise<void> {
  const { db, review, repo, token } = context;
  if (review.status !== "completed" || !review.checkRunId) return;
  // The click was on a run a Re-run has since replaced: its holds may differ.
  if (approver.checkRunId !== undefined && approver.checkRunId !== review.checkRunId) return;
  if (review.conclusion === "approved" && review.approvedByLogin === approver.login) {
    // A retry after the approval was stored but its check update failed.
    const { bumps, coverage } = await readDependencyReviewResult(db, review.id);
    await publishResult(context, review.checkRunId, bumps, "approved", coverage, approver.login);
    return;
  }
  if (review.conclusion !== "held") return;
  const log = (reason: string) =>
    emitOperationalEvent("warn", "dependency_review.approval_refused", {
      organizationId: review.organizationId,
      reviewId: review.id,
      reason,
    });
  if (!(await hasRepositoryWriteAccess(token, repo, approver.login))) {
    log("no_write_access");
    return;
  }
  const pr = await fetchPullRequest(token, repo, review.pullNumber);
  if (!pr || pr.headSha !== review.headSha || pr.state !== "open") {
    log("head_moved");
    return;
  }
  const { bumps, coverage } = await readDependencyReviewResult(db, review.id);
  const held = bumps.filter(isOpenHold);
  // The run offered no Approve, so this click is forged or stale.
  if (!listsEveryHold(renderInput(context, bumps, "held", coverage, null))) {
    log("too_many_holds");
    return;
  }
  await recordDependencyApprovals(db, {
    organizationId: review.organizationId,
    repositoryId: review.repositoryId,
    reviewId: review.id,
    approvedByLogin: approver.login,
    approvedByGithubId: approver.githubId,
    bumps: held.map((b) => b.bump),
  });
  // Recorded with the approvals: they carry to later commits whatever happens
  // to this run, so the audit trail can't depend on it.
  await recordScanEvent(db, {
    organizationId: review.organizationId,
    type: "dependency_review.approved",
    metadata: {
      reviewId: review.id,
      repositoryFullName: review.repositoryFullName,
      pullNumber: review.pullNumber,
      approvedByLogin: approver.login,
      approvedCount: held.length,
    },
  });
  const approved = bumps.map((b) => (b.verdict.status === "hold" ? { ...b, approved: true } : b));
  // A writer accepted what was held, including a hold that came from an unread
  // lockfile with no per-bump hold behind it, so this reads as approved.
  const conclusion: DependencyReviewConclusion = "approved";
  const current = await completeDependencyReview(db, review.id, {
    conclusion,
    bumps: approved,
    coverage,
    approvedByLogin: approver.login,
    ifCompletedOnRun: review.checkRunId,
  });
  // A Re-run claimed the review since the click; it will find the approvals.
  if (!current) return;
  await publishResult(context, review.checkRunId, approved, conclusion, coverage, approver.login);
  recordProductEvent(context.env, {
    name: "dependency_review.approved",
    organizationId: review.organizationId,
    approvedCount: held.length,
  });
}

async function failReview(context: ReviewContext, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.name : "error";
  emitOperationalEvent("error", "dependency_review.failed", {
    organizationId: context.review.organizationId,
    reviewId: context.review.id,
    error: describeOperationalError(err),
  });
  await failDependencyReview(context.db, context.review.id, reason);
  if (!context.review.checkRunId) return;
  await updateCheckRun(
    context.token,
    context.repo,
    context.review.checkRunId,
    {
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Dependency review failed",
        summary: "Drydock could not finish this review. Use Re-run to try again.",
      },
    },
    context.detailsUrl,
  ).catch(() => undefined);
}
