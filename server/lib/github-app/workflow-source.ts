// Fetch the workflow definitions behind a gated release, so the gate can
// snapshot the authority that produced it.
//
// Trust boundary: this runs in the control plane and the installation token is
// attached only to `api.github.com`. Redirects are never followed — the
// contents endpoint has no legitimate reason to redirect at these sizes, and
// following one would be a way to move a credentialed request off GitHub.
//
// Everything here is best effort. A gate review must never fail because a
// reusable workflow lives in a repository the installation cannot read; the
// unreadable definition is recorded as unresolved coverage instead, and the
// review says the authority graph is incomplete rather than implying it is
// unchanged.

import type {
  AuthorityUnresolved,
  AuthorityUnresolvedReason,
  ReleaseAuthorityRun,
  WorkflowSource,
} from "../release-authority/snapshot";
import {
  MAX_WORKFLOW_BYTES,
  WorkflowYamlError,
  asRecord,
  asString,
  parseWorkflowYaml,
} from "../release-authority/yaml";
import { readStreamBounded } from "../tar-parser.js";
import { reliableFetch } from "../platform/reliable-fetch";
import { sha256Hex, stableJson } from "../platform/stable-json";
import { getInstallationAccessToken } from "./api";
import type { GithubAppConfig } from "./config";
import { githubInstallationHeaders } from "./http";

// A release whose authority graph is wider than this is bounded rather than
// followed to the end; the overflow is recorded as unresolved coverage.
const MAX_REFERENCED_WORKFLOWS = 16;
const MAX_LOCAL_ACTIONS = 32;
const MAX_LOCAL_ACTION_ENTRIES = 512;
const MAX_LOCAL_ACTION_DEPTH = 32;
const MAX_LOCAL_ACTION_OBJECTS = 256;
const MAX_LOCAL_ACTION_RESPONSE_BYTES = 2 * 1024 * 1024;

const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface ReleaseAuthoritySources {
  run: ReleaseAuthorityRun;
  workflows: WorkflowSource[];
  unresolved: AuthorityUnresolved[];
}

export interface FetchAuthoritySourcesInput {
  installationExternalId: string;
  repositoryFullName: string;
  environment: string;
  runId: number;
}

/**
 * Resolve a run's workflow graph: the entry workflow at the commit the run
 * used, plus every reusable workflow GitHub reports the run referenced — which
 * GitHub already pins to a sha, so the graph does not have to be re-derived
 * from `uses:` strings.
 */
export async function fetchReleaseAuthoritySources(
  config: GithubAppConfig,
  input: FetchAuthoritySourcesInput,
): Promise<ReleaseAuthoritySources> {
  const token = await getInstallationAccessToken(config, input.installationExternalId);
  return fetchReleaseAuthoritySourcesWithToken(token, input);
}

/** Token-taking form, so tests can exercise ingestion without an RSA key. */
export async function fetchReleaseAuthoritySourcesWithToken(
  token: string,
  input: FetchAuthoritySourcesInput,
): Promise<ReleaseAuthoritySources> {
  const unresolved: AuthorityUnresolved[] = [];
  const emptyRun: ReleaseAuthorityRun = {
    repositoryFullName: input.repositoryFullName,
    environment: input.environment,
    runId: input.runId,
    runAttempt: null,
    workflowPath: null,
    headSha: null,
    ref: null,
    event: null,
    actor: null,
    triggeringActor: null,
  };

  if (!REPOSITORY_FULL_NAME_RE.test(input.repositoryFullName)) {
    return {
      run: emptyRun,
      workflows: [],
      unresolved: [{ path: input.repositoryFullName, reason: "not_accessible" }],
    };
  }

  const runContext = await fetchWorkflowRun(token, input.repositoryFullName, input.runId);
  if (!runContext) {
    return {
      run: emptyRun,
      workflows: [],
      unresolved: [{ path: `run/${input.runId}`, reason: "fetch_failed" }],
    };
  }

  const run: ReleaseAuthorityRun = {
    repositoryFullName: input.repositoryFullName,
    environment: input.environment,
    runId: input.runId,
    runAttempt: runContext.runAttempt,
    workflowPath: runContext.workflowPath,
    headSha: runContext.headSha,
    ref: runContext.ref,
    event: runContext.event,
    actor: runContext.actor,
    triggeringActor: runContext.triggeringActor,
  };

  const requests: Array<{
    path: string;
    repositoryFullName: string;
    ref: string | null;
    sha: string | null;
    role: "entry" | "referenced";
  }> = [];

  const entryWorkflow = runContext.entryWorkflow;
  let resolvedEntry: ReferencedWorkflowRef | undefined;
  if (entryWorkflow) {
    const entryInRunRepository = entryWorkflow.repositoryFullName === input.repositoryFullName;
    resolvedEntry = entryInRunRepository
      ? undefined
      : runContext.referencedWorkflows.find(
          (workflow) =>
            workflow.repositoryFullName === entryWorkflow.repositoryFullName &&
            workflow.filePath === entryWorkflow.path &&
            workflowRevisionMatches(entryWorkflow.ref, workflow),
        );
    const entrySha = entryInRunRepository
      ? commitSha(runContext.headSha)
      : (commitSha(resolvedEntry?.sha ?? null) ?? commitSha(entryWorkflow.ref));
    const qualifiedPath = entryInRunRepository
      ? entryWorkflow.path
      : `${entryWorkflow.repositoryFullName}/${entryWorkflow.path}`;
    if (!entrySha) {
      // A branch or tag names today's workflow definition, not necessarily the
      // one GitHub resolved when this run started. Without an immutable commit
      // we cannot produce historical authority evidence, so leave explicit
      // incomplete coverage instead of fetching a moving ref and presenting it
      // as the workflow that actually ran.
      unresolved.push({ path: qualifiedPath, reason: "not_accessible" });
    } else {
      requests.push({
        path: entryWorkflow.path,
        repositoryFullName: entryWorkflow.repositoryFullName,
        // The entry workflow is read at the commit the run used, not at the tip
        // of the default branch: a later edit must not rewrite the history of
        // what this release was authorized by. A repository-qualified entry has
        // its own revision; the run repository's head sha does not name content
        // in that other repository.
        ref: entrySha,
        sha: entrySha,
        role: "entry",
      });
    }
  } else {
    unresolved.push({ path: `run/${input.runId}`, reason: "unparseable" });
  }

  const referencedGraph = runContext.referencedWorkflows.filter(
    (workflow) => workflow !== resolvedEntry,
  );
  const referenced = referencedGraph.slice(0, MAX_REFERENCED_WORKFLOWS);
  if (referencedGraph.length > referenced.length) {
    unresolved.push({
      path: `+${referencedGraph.length - referenced.length} referenced workflows`,
      reason: "limit_reached",
    });
  }
  for (const workflow of referenced) {
    const qualifiedPath = `${workflow.repositoryFullName}/${workflow.filePath}`;
    const workflowSha = commitSha(workflow.sha) ?? commitSha(workflow.ref);
    if (!workflowSha) {
      unresolved.push({ path: qualifiedPath, reason: "not_accessible" });
      continue;
    }
    requests.push({
      path: workflow.filePath,
      repositoryFullName: workflow.repositoryFullName,
      ref: workflowSha,
      sha: workflowSha,
      role: "referenced",
    });
  }

  const workflows: WorkflowSource[] = [];
  const localActionCache = new Map<string, Promise<FetchedLocalActionDigest>>();
  const localActionObjectCache = new Map<string, Promise<FetchedGithubJson>>();
  let localActionCount = 0;
  for (const request of requests) {
    // Referenced workflows are keyed repo-qualified so two repositories that
    // both ship `.github/workflows/publish.yml` stay distinct in the snapshot.
    const qualifiedPath =
      request.role === "entry" && request.repositoryFullName === input.repositoryFullName
        ? request.path
        : `${request.repositoryFullName}/${request.path}`;
    const fetched = await fetchWorkflowContent(
      token,
      request.repositoryFullName,
      request.path,
      request.ref,
    );
    if (fetched.error) {
      unresolved.push({ path: qualifiedPath, reason: fetched.error });
      continue;
    }
    let document: WorkflowSource["document"] = null;
    let documentComplete = false;
    try {
      const parsed = parseWorkflowYaml(fetched.content);
      document = parsed.value;
      documentComplete = parsed.complete;
    } catch (err) {
      unresolved.push({
        path: qualifiedPath,
        reason:
          err instanceof WorkflowYamlError && err.code === "too_large"
            ? "too_large"
            : "unparseable",
      });
      continue;
    }
    const localActionDigests = Object.create(null) as Record<string, string>;
    for (const uses of collectLocalActionUses(document)) {
      const actionPath = normalizeLocalActionPath(uses);
      // `$/` is explicitly bound to the running workflow's repository and
      // commit. `./` resolves from github.workspace, which an earlier checkout
      // step may have populated from another repository or moving ref, so do
      // not attest it with bytes fetched from the workflow commit.
      if (!uses.startsWith("$/") || !actionPath || !request.ref) {
        unresolved.push({ path: `${qualifiedPath} -> ${uses}`, reason: "not_accessible" });
        continue;
      }
      const cacheKey = `${request.repositoryFullName}\u0000${request.ref}\u0000${actionPath}`;
      let pending = localActionCache.get(cacheKey);
      if (!pending) {
        localActionCount += 1;
        if (localActionCount > MAX_LOCAL_ACTIONS) {
          unresolved.push({ path: `${qualifiedPath} -> ${uses}`, reason: "limit_reached" });
          continue;
        }
        pending = fetchLocalActionDigest(
          token,
          request.repositoryFullName,
          actionPath,
          request.ref,
          localActionObjectCache,
        );
        localActionCache.set(cacheKey, pending);
      }
      const localAction = await pending;
      if (localAction.error || !localAction.digest) {
        unresolved.push({
          path: `${qualifiedPath} -> ${uses}`,
          reason: localAction.error ?? "fetch_failed",
        });
        continue;
      }
      localActionDigests[uses] = localAction.digest;
    }
    workflows.push({
      path: qualifiedPath,
      repositoryFullName: request.repositoryFullName,
      sha: request.sha,
      ref: request.ref,
      role: request.role,
      content: fetched.content,
      document,
      documentComplete,
      localActionDigests,
    });
  }

  return { run, workflows, unresolved };
}

function collectLocalActionUses(document: WorkflowSource["document"]): string[] {
  const doc = asRecord(document);
  const jobs = doc && asRecord(doc.jobs);
  if (!jobs) return [];
  const uses = new Set<string>();
  for (const rawJob of Object.values(jobs)) {
    const job = asRecord(rawJob);
    const steps = job && Array.isArray(job.steps) ? job.steps : [];
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      const value = step && asString(step.uses)?.trim();
      if (value && normalizeLocalActionPath(value)) uses.add(value);
    }
  }
  return [...uses].sort();
}

// ── GitHub API ───────────────────────────────────────────────────────────────

interface ReferencedWorkflowRef {
  /** Path inside its own repository, e.g. `.github/workflows/publish.yml`. */
  filePath: string;
  repositoryFullName: string;
  sha: string | null;
  ref: string | null;
}

interface WorkflowRunContext {
  headSha: string | null;
  workflowPath: string | null;
  entryWorkflow: {
    path: string;
    repositoryFullName: string;
    ref: string | null;
  } | null;
  runAttempt: number | null;
  event: string | null;
  actor: string | null;
  triggeringActor: string | null;
  ref: string | null;
  referencedWorkflows: ReferencedWorkflowRef[];
}

async function fetchWorkflowRun(
  token: string,
  repositoryFullName: string,
  runId: number,
): Promise<WorkflowRunContext | null> {
  const [owner, repo] = repositoryFullName.split("/");
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/runs/${runId}`;
  const response = await reliableFetch(url, {
    headers: githubInstallationHeaders(token),
    redirect: "manual",
  }).catch(() => null);
  if (!response || !response.ok) {
    await response?.body?.cancel();
    return null;
  }
  const data = (await response.json().catch(() => null)) as {
    head_sha?: unknown;
    path?: unknown;
    run_attempt?: unknown;
    event?: unknown;
    head_branch?: unknown;
    actor?: { login?: unknown } | null;
    triggering_actor?: { login?: unknown } | null;
    referenced_workflows?: unknown;
  } | null;
  if (!data) return null;

  const entryWorkflow = parseEntryWorkflow(str(data.path), repositoryFullName);
  return {
    headSha: str(data.head_sha),
    // GitHub reports `path` as `.github/workflows/x.yml` for a run in this
    // repository, and as `owner/repo/.github/workflows/x.yml@ref` when the run
    // entered through a workflow owned elsewhere.
    workflowPath: entryWorkflow?.qualifiedPath ?? null,
    entryWorkflow,
    runAttempt: int(data.run_attempt),
    event: str(data.event),
    ref: str(data.head_branch),
    actor: str(data.actor?.login),
    triggeringActor: str(data.triggering_actor?.login),
    referencedWorkflows: readReferencedWorkflows(data.referenced_workflows),
  };
}

function parseEntryWorkflow(
  path: string | null,
  runRepositoryFullName: string,
): { path: string; repositoryFullName: string; qualifiedPath: string; ref: string | null } | null {
  if (!path) return null;
  const separator = path.lastIndexOf("@");
  const withoutRef = separator > 0 ? path.slice(0, separator) : path;
  const ref = separator > 0 ? path.slice(separator + 1) || null : null;
  if (!withoutRef) return null;
  if (withoutRef.startsWith(".github/workflows/")) {
    return {
      path: withoutRef,
      repositoryFullName: runRepositoryFullName,
      qualifiedPath: withoutRef,
      ref: null,
    };
  }
  const segments = withoutRef.split("/");
  if (segments.length < 3) return null;
  return {
    path: segments.slice(2).join("/"),
    repositoryFullName: segments.slice(0, 2).join("/"),
    qualifiedPath: withoutRef,
    ref,
  };
}

function commitSha(ref: string | null): string | null {
  return ref && /^[0-9a-f]{40}$/i.test(ref) ? ref : null;
}

function workflowRevisionMatches(
  entryRef: string | null,
  workflow: ReferencedWorkflowRef,
): boolean {
  if (!entryRef) return false;
  if (workflow.sha === entryRef || workflow.ref === entryRef) return true;
  const shortEntryRef = entryRef.replace(/^refs\/(?:heads|tags)\//, "");
  const shortWorkflowRef = workflow.ref?.replace(/^refs\/(?:heads|tags)\//, "") ?? null;
  return shortWorkflowRef === shortEntryRef;
}

/**
 * GitHub reports the reusable workflows a run actually used, already resolved
 * to a commit sha. That is the authority graph — no `uses:` string has to be
 * re-resolved here, and a transitive reference is reported the same way as a
 * direct one.
 */
function readReferencedWorkflows(value: unknown): ReferencedWorkflowRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ReferencedWorkflowRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as { path?: unknown; sha?: unknown; ref?: unknown };
    const raw = str(item.path);
    if (!raw) continue;
    const withoutRef = raw.includes("@") ? raw.slice(0, raw.lastIndexOf("@")) : raw;
    const segments = withoutRef.split("/");
    if (segments.length < 3) continue;
    refs.push({
      repositoryFullName: segments.slice(0, 2).join("/"),
      filePath: segments.slice(2).join("/"),
      sha: str(item.sha),
      ref: str(item.ref),
    });
  }
  return refs;
}

interface FetchedContent {
  content: string;
  error: AuthorityUnresolvedReason | null;
}

interface FetchedLocalActionDigest {
  digest: string | null;
  error: AuthorityUnresolvedReason | null;
}

interface FetchedGithubJson {
  data: unknown;
  error: AuthorityUnresolvedReason | null;
}

interface GithubTreeEntry {
  mode?: unknown;
  path?: unknown;
  sha?: unknown;
  type?: unknown;
}

interface ValidGithubTreeEntry {
  mode: string;
  path: string;
  sha: string;
  type: string;
}

interface FetchedGithubTree {
  entries: ValidGithubTreeEntry[] | null;
  error: AuthorityUnresolvedReason | null;
}

/**
 * Bind a local action to its directory's Git tree identity. Tree identities
 * cover every descendant's path, object id, and mode, so executable-bit-only
 * changes are visible alongside content changes without downloading or
 * executing any repository files.
 */
async function fetchLocalActionDigest(
  token: string,
  repositoryFullName: string,
  actionPath: string,
  ref: string,
  objectCache: Map<string, Promise<FetchedGithubJson>>,
): Promise<FetchedLocalActionDigest> {
  const pathSegments = actionPath.split("/");
  if (
    !REPOSITORY_FULL_NAME_RE.test(repositoryFullName) ||
    !isSafeRepositoryPath(actionPath) ||
    !/^[0-9a-f]{40}$/i.test(ref) ||
    pathSegments.length > MAX_LOCAL_ACTION_DEPTH
  ) {
    return { digest: null, error: "not_accessible" };
  }
  const [owner, repo] = repositoryFullName.split("/");
  const baseUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    "/git";
  const commit = await fetchCachedGithubJson(
    `${baseUrl}/commits/${encodeURIComponent(ref)}`,
    token,
    objectCache,
  );
  if (commit.error) return { digest: null, error: commit.error };
  if (!commit.data || typeof commit.data !== "object" || Array.isArray(commit.data)) {
    return { digest: null, error: "unparseable" };
  }
  const commitTree = (commit.data as { tree?: unknown }).tree;
  if (!commitTree || typeof commitTree !== "object" || Array.isArray(commitTree)) {
    return { digest: null, error: "unparseable" };
  }
  const rawTreeSha = (commitTree as { sha?: unknown }).sha;
  if (typeof rawTreeSha !== "string" || !/^[0-9a-f]{40}$/i.test(rawTreeSha)) {
    return { digest: null, error: "unparseable" };
  }
  let treeSha = rawTreeSha;

  for (const segment of pathSegments) {
    const fetched = await fetchGithubTree(baseUrl, treeSha, token, objectCache);
    if (fetched.error || !fetched.entries) {
      return { digest: null, error: fetched.error ?? "unparseable" };
    }
    let nextTreeSha: string | null = null;
    for (const entry of fetched.entries) {
      if (entry.path === segment) {
        if (nextTreeSha || entry.type !== "tree" || entry.mode !== "040000") {
          return { digest: null, error: "unparseable" };
        }
        nextTreeSha = entry.sha;
      }
    }
    if (!nextTreeSha) return { digest: null, error: "not_accessible" };
    treeSha = nextTreeSha;
  }

  const actionTree = await fetchGithubTree(baseUrl, treeSha, token, objectCache);
  if (actionTree.error || !actionTree.entries) {
    return { digest: null, error: actionTree.error ?? "unparseable" };
  }
  return {
    digest: await sha256Hex(
      stableJson({ gitTreeSha: treeSha.toLowerCase(), entries: actionTree.entries }),
    ),
    error: null,
  };
}

async function fetchGithubTree(
  baseUrl: string,
  treeSha: string,
  token: string,
  objectCache: Map<string, Promise<FetchedGithubJson>>,
): Promise<FetchedGithubTree> {
  const fetched = await fetchCachedGithubJson(
    `${baseUrl}/trees/${encodeURIComponent(treeSha)}`,
    token,
    objectCache,
  );
  if (fetched.error) return { entries: null, error: fetched.error };
  if (!fetched.data || typeof fetched.data !== "object" || Array.isArray(fetched.data)) {
    return { entries: null, error: "unparseable" };
  }
  const tree = fetched.data as { tree?: unknown; truncated?: unknown };
  if (!Array.isArray(tree.tree)) return { entries: null, error: "unparseable" };
  if (tree.truncated === true || tree.tree.length > MAX_LOCAL_ACTION_ENTRIES) {
    return { entries: null, error: "limit_reached" };
  }

  const entries: ValidGithubTreeEntry[] = [];
  for (const raw of tree.tree) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { entries: null, error: "unparseable" };
    }
    const entry = raw as GithubTreeEntry;
    const path = typeof entry.path === "string" ? entry.path : "";
    const sha = typeof entry.sha === "string" ? entry.sha : "";
    const type = typeof entry.type === "string" ? entry.type : "";
    const mode = typeof entry.mode === "string" ? entry.mode : "";
    if (
      !path ||
      path.includes("/") ||
      !/^[0-9a-f]{40}$/i.test(sha) ||
      !["blob", "tree", "commit"].includes(type) ||
      !/^(?:040000|100644|100755|120000|160000)$/.test(mode)
    ) {
      return { entries: null, error: "unparseable" };
    }
    entries.push({ path, sha: sha.toLowerCase(), type, mode });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, error: null };
}

function fetchCachedGithubJson(
  url: string,
  token: string,
  cache: Map<string, Promise<FetchedGithubJson>>,
): Promise<FetchedGithubJson> {
  const cached = cache.get(url);
  if (cached) return cached;
  if (cache.size >= MAX_LOCAL_ACTION_OBJECTS) {
    return Promise.resolve({ data: null, error: "limit_reached" });
  }
  const pending = fetchGithubJson(url, token);
  cache.set(url, pending);
  return pending;
}

async function fetchGithubJson(url: string, token: string): Promise<FetchedGithubJson> {
  const response = await reliableFetch(url, {
    headers: githubInstallationHeaders(token),
    redirect: "manual",
  }).catch(() => null);
  if (!response) return { data: null, error: "fetch_failed" };
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return { data: null, error: "not_accessible" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { data: null, error: "fetch_failed" };
  }

  try {
    const bytes = await readStreamBounded(response.body, MAX_LOCAL_ACTION_RESPONSE_BYTES);
    return { data: JSON.parse(new TextDecoder().decode(bytes)), error: null };
  } catch (err) {
    return {
      data: null,
      error:
        err instanceof Error && err.message === "archive too large" ? "too_large" : "unparseable",
    };
  }
}

async function fetchWorkflowContent(
  token: string,
  repositoryFullName: string,
  path: string,
  ref: string | null,
): Promise<FetchedContent> {
  if (!REPOSITORY_FULL_NAME_RE.test(repositoryFullName) || !isSafeWorkflowPath(path)) {
    return { content: "", error: "not_accessible" };
  }
  const [owner, repo] = repositoryFullName.split("/");
  const segments = path.split("/").map(encodeURIComponent).join("/");
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${segments}${query}`;

  const response = await reliableFetch(url, {
    headers: {
      ...githubInstallationHeaders(token),
      // Raw media type: the file bytes, with no base64 round-trip.
      Accept: "application/vnd.github.raw+json",
    },
    // A credentialed request must not chase a redirect off api.github.com.
    redirect: "manual",
  }).catch(() => null);
  if (!response) return { content: "", error: "fetch_failed" };
  if (response.status === 404 || response.status === 403) {
    await response.body?.cancel();
    // The installation cannot read this definition — typically a reusable
    // workflow in a repository outside the installation.
    return { content: "", error: "not_accessible" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { content: "", error: "fetch_failed" };
  }

  try {
    const bytes = await readStreamBounded(response.body, MAX_WORKFLOW_BYTES);
    return { content: new TextDecoder().decode(bytes), error: null };
  } catch (err) {
    if (err instanceof Error && err.message === "archive too large") {
      return { content: "", error: "too_large" };
    }
    return { content: "", error: "fetch_failed" };
  }
}

// Workflow definitions live under `.github/workflows/`. Constraining the path
// keeps a hostile `referenced_workflows` entry from turning this into a
// general-purpose repository file reader.
function isSafeWorkflowPath(path: string): boolean {
  if (!path.startsWith(".github/workflows/")) return false;
  if (path.includes("..") || path.includes("//")) return false;
  return path.length <= 512 && /^[A-Za-z0-9._/-]+$/.test(path);
}

function normalizeLocalActionPath(uses: string): string | null {
  if (!uses.startsWith("./") && !uses.startsWith("$/")) return null;
  const path = uses.slice(2).replace(/\/+$/, "");
  return isSafeRepositoryPath(path) ? path : null;
}

function isSafeRepositoryPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("//")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return /^[A-Za-z0-9._@+/-]+$/.test(path);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}
