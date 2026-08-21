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

  if (runContext.workflowPath) {
    requests.push({
      path: runContext.workflowPath,
      repositoryFullName: input.repositoryFullName,
      // The entry workflow is read at the commit the run used, not at the tip
      // of the default branch: a later edit must not rewrite the history of
      // what this release was authorized by.
      ref: runContext.headSha,
      sha: runContext.headSha,
      role: "entry",
    });
  } else {
    unresolved.push({ path: `run/${input.runId}`, reason: "unparseable" });
  }

  const referenced = runContext.referencedWorkflows.slice(0, MAX_REFERENCED_WORKFLOWS);
  if (runContext.referencedWorkflows.length > referenced.length) {
    unresolved.push({
      path: `+${runContext.referencedWorkflows.length - referenced.length} referenced workflows`,
      reason: "limit_reached",
    });
  }
  for (const workflow of referenced) {
    requests.push({
      path: workflow.filePath,
      repositoryFullName: workflow.repositoryFullName,
      ref: workflow.sha ?? workflow.ref,
      sha: workflow.sha,
      role: "referenced",
    });
  }

  const workflows: WorkflowSource[] = [];
  const localActionCache = new Map<string, Promise<FetchedLocalActionDigest>>();
  let localActionCount = 0;
  for (const request of requests) {
    // Referenced workflows are keyed repo-qualified so two repositories that
    // both ship `.github/workflows/publish.yml` stay distinct in the snapshot.
    const qualifiedPath =
      request.role === "entry" ? request.path : `${request.repositoryFullName}/${request.path}`;
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
      if (!actionPath || !request.ref) {
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
      if (value?.startsWith("./")) uses.add(value);
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

  return {
    headSha: str(data.head_sha),
    // GitHub reports `path` as `.github/workflows/x.yml` for a run in this
    // repository, and as `owner/repo/.github/workflows/x.yml@ref` when the run
    // entered through a workflow owned elsewhere.
    workflowPath: normalizeEntryPath(str(data.path)),
    runAttempt: int(data.run_attempt),
    event: str(data.event),
    ref: str(data.head_branch),
    actor: str(data.actor?.login),
    triggeringActor: str(data.triggering_actor?.login),
    referencedWorkflows: readReferencedWorkflows(data.referenced_workflows),
  };
}

function normalizeEntryPath(path: string | null): string | null {
  if (!path) return null;
  const withoutRef = path.includes("@") ? path.slice(0, path.lastIndexOf("@")) : path;
  return withoutRef || null;
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

interface GithubContentEntry {
  path?: unknown;
  sha?: unknown;
  type?: unknown;
}

/**
 * Bind a local action to the Git tree identities of everything in its
 * directory. A directory entry's Git tree sha covers all descendants, so one
 * bounded Contents API response captures composite metadata, JavaScript entry
 * points, Dockerfiles, and helper files without downloading or executing any of
 * them.
 */
async function fetchLocalActionDigest(
  token: string,
  repositoryFullName: string,
  actionPath: string,
  ref: string,
): Promise<FetchedLocalActionDigest> {
  if (!REPOSITORY_FULL_NAME_RE.test(repositoryFullName) || !isSafeRepositoryPath(actionPath)) {
    return { digest: null, error: "not_accessible" };
  }
  const [owner, repo] = repositoryFullName.split("/");
  const segments = actionPath.split("/").map(encodeURIComponent).join("/");
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${segments}?ref=${encodeURIComponent(ref)}`;
  const response = await reliableFetch(url, {
    headers: githubInstallationHeaders(token),
    redirect: "manual",
  }).catch(() => null);
  if (!response) return { digest: null, error: "fetch_failed" };
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return { digest: null, error: "not_accessible" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { digest: null, error: "fetch_failed" };
  }

  let data: unknown;
  try {
    const bytes = await readStreamBounded(response.body, MAX_LOCAL_ACTION_RESPONSE_BYTES);
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return {
      digest: null,
      error:
        err instanceof Error && err.message === "archive too large" ? "too_large" : "unparseable",
    };
  }
  if (!Array.isArray(data)) return { digest: null, error: "unparseable" };
  if (data.length === 0) return { digest: null, error: "not_accessible" };
  if (data.length > MAX_LOCAL_ACTION_ENTRIES) return { digest: null, error: "limit_reached" };

  const entries: Array<{ path: string; sha: string; type: string }> = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { digest: null, error: "unparseable" };
    }
    const item = raw as GithubContentEntry;
    const path = typeof item.path === "string" ? item.path : "";
    const sha = typeof item.sha === "string" ? item.sha : "";
    const type = typeof item.type === "string" ? item.type : "";
    if (
      !path.startsWith(`${actionPath}/`) ||
      !/^[0-9a-f]{40}$/i.test(sha) ||
      !["file", "dir", "symlink", "submodule"].includes(type)
    ) {
      return { digest: null, error: "unparseable" };
    }
    entries.push({ path, sha: sha.toLowerCase(), type });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { digest: await sha256Hex(stableJson(entries)), error: null };
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
  if (!uses.startsWith("./")) return null;
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
