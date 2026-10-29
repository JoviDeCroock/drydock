import { githubHeaders } from "./client";
import type { GithubAppConfig } from "./config";
import { generateGithubAppJwt } from "./jwt";
import { parseRepositoryFullName } from "./validation";
import { readBoundedJson } from "../platform/bounded-body";
import { base64Encode, sha256Hex } from "../platform/crypto-utils";
import { canonicalJson } from "../platform/canonical-json";
import { isRecord } from "../platform/guards";
import { isSafeManifestPath } from "../platform/path-safety";
import { reliableFetch } from "../platform/reliable-fetch";
import type {
  PublisherSetupInspection,
  PublisherSetupPullRequest,
  PublisherSetupProposal,
} from "./setup-types";

const MAX_WORKFLOW_BYTES = 48_000;
const MAX_WORKFLOWS = 12;
const SHA = /^[a-f0-9]{40,64}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

export class PublisherSetupError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 403 | 404 | 409 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "PublisherSetupError";
  }
}

export function validSetupWorkflowPath(value: string): boolean {
  return value.length <= 180 && WORKFLOW_PATH.test(value);
}

export function validSetupFilePath(value: string): boolean {
  return (
    isSafeManifestPath(value) &&
    value.split("/").length <= 16 &&
    !value.split("/").some((segment) => segment.toLowerCase() === ".git") &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function validSetupEnvironment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value === value.trim().toLowerCase() &&
    [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
  );
}

export function validSetupSha(value: string): boolean {
  return SHA.test(value);
}

const WRITE_PERMISSIONS_REQUIRED =
  "Creating a workflow PR requires this installation to grant Contents, Pull requests, and Workflows write permissions. Ask the GitHub App operator to enable these optional permissions, approve the installation update, then retry PR preparation.";

/** Fails fast on missing write grants without minting a write token before PR creation needs one. */
export async function requireSetupWritePermissions(
  config: GithubAppConfig,
  installationId: string,
): Promise<void> {
  const response = await reliableFetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    { redirect: "manual", headers: githubHeaders(await generateGithubAppJwt(config)) },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not return this installation's permissions.",
      502,
    );
  }
  const body = await readBoundedJson(response, {
    maxBytes: 40_000,
    deadlineMs: Date.now() + 15_000,
  });
  const permissions = isRecord(body) && isRecord(body.permissions) ? body.permissions : {};
  if (!["contents", "pull_requests", "workflows"].every((name) => permissions[name] === "write"))
    throw new PublisherSetupError("setup_permissions_required", WRITE_PERMISSIONS_REQUIRED, 403);
}

/** Shared by agent tools and PR creation so any directory the agent can read can also be committed. */
export const SETUP_TREE_MAX_ENTRIES = 2000;

/** Case-only twins collide on case-insensitive checkouts and could hide a reviewed change. */
export function setupTreeHasCaseTwin(tree: unknown[], name: string): boolean {
  const folded = name.toLowerCase();
  return tree.some(
    (value) =>
      isRecord(value) &&
      typeof value.path === "string" &&
      value.path !== name &&
      value.path.toLowerCase() === folded,
  );
}

export async function createSetupClient(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  write = false,
  repositoryEvidenceOnly = false,
) {
  const parsed = parseRepositoryFullName(fullName);
  if (!parsed)
    throw new PublisherSetupError("invalid_input", "Choose a repository in owner/repository form.");
  const path = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
  const jwt = await generateGithubAppJwt(config);
  const permissions = write
    ? { contents: "write", pull_requests: "write", workflows: "write" }
    : repositoryEvidenceOnly
      ? { contents: "read" }
      : { contents: "read", actions: "read" };
  const tokenResponse = await reliableFetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      redirect: "manual",
      headers: githubHeaders(jwt, { "Content-Type": "application/json" }),
      body: JSON.stringify({ repositories: [parsed.name], permissions }),
    },
  );
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel();
    throw new PublisherSetupError(
      "setup_permissions_required",
      write
        ? WRITE_PERMISSIONS_REQUIRED
        : "Reading the release workflow requires Contents and Actions read permissions for this repository.",
      403,
    );
  }
  const tokenBody = await readBoundedJson(tokenResponse, {
    maxBytes: 12_000,
    deadlineMs: Date.now() + 15_000,
  });
  if (!isRecord(tokenBody) || typeof tokenBody.token !== "string")
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not return an installation token.",
      502,
    );
  const token = tokenBody.token;
  const repositoryResponse = await reliableFetch(`https://api.github.com${path}`, {
    redirect: "manual",
    headers: githubHeaders(token),
  });
  if (!repositoryResponse.ok) {
    await repositoryResponse.body?.cancel();
    throw new PublisherSetupError(
      "repository_not_accessible",
      "This installation cannot access the selected repository.",
      403,
    );
  }
  const metadata = await readBoundedJson(repositoryResponse, {
    maxBytes: 40_000,
    deadlineMs: Date.now() + 15_000,
  });
  if (
    !isRecord(metadata) ||
    typeof metadata.id !== "number" ||
    !Number.isSafeInteger(metadata.id) ||
    metadata.id <= 0 ||
    typeof metadata.full_name !== "string" ||
    metadata.full_name.toLowerCase() !== fullName.toLowerCase() ||
    typeof metadata.default_branch !== "string" ||
    !metadata.default_branch
  ) {
    throw new PublisherSetupError(
      "repository_unavailable",
      "The repository has no accessible default branch.",
      409,
    );
  }
  const repository = {
    id: metadata.id,
    fullName: metadata.full_name,
    defaultBranch: metadata.default_branch,
  };
  return {
    repository,
    path,
    async request(suffix: string, init: RequestInit = {}, allowMissing = false): Promise<unknown> {
      const response = await reliableFetch(`https://api.github.com${path}${suffix}`, {
        ...init,
        redirect: "manual",
        headers: githubHeaders(token, { "Content-Type": "application/json" }),
      });
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PublisherSetupError(
          response.status === 403 ? "setup_permissions_required" : "github_unavailable",
          response.status === 403
            ? "GitHub refused this operation. Check this installation's repository permissions."
            : "GitHub could not complete the setup request. Retry without changing your release workflow.",
          response.status === 403 ? 403 : 502,
        );
      }
      const data = await readBoundedJson(response, {
        maxBytes: 250_000,
        deadlineMs: Date.now() + 15_000,
      });
      if (data === null)
        throw new PublisherSetupError(
          "github_unavailable",
          "GitHub returned an invalid or oversized response.",
          502,
        );
      return data;
    },
  };
}

export type SetupGithubClient = Awaited<ReturnType<typeof createSetupClient>>;

export async function setupDefaultHead(client: SetupGithubClient): Promise<string> {
  const data = await client.request(
    `/git/ref/heads/${encodeURIComponent(client.repository.defaultBranch ?? "")}`,
  );
  if (
    !isRecord(data) ||
    !isRecord(data.object) ||
    typeof data.object.sha !== "string" ||
    !validSetupSha(data.object.sha)
  )
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not return a valid branch revision.",
      502,
    );
  return data.object.sha;
}

export async function readSetupWorkflow(
  client: SetupGithubClient,
  workflowPath: string,
  baseSha: string,
) {
  if (!validSetupWorkflowPath(workflowPath) || !validSetupSha(baseSha))
    throw new PublisherSetupError(
      "invalid_input",
      "Choose a workflow file and a valid repository revision.",
    );
  const data = await client.request(`/contents/${workflowPath}?ref=${baseSha}`);
  if (
    !isRecord(data) ||
    data.type !== "file" ||
    data.path !== workflowPath ||
    data.encoding !== "base64" ||
    typeof data.content !== "string" ||
    typeof data.sha !== "string" ||
    !validSetupSha(data.sha) ||
    typeof data.size !== "number" ||
    data.size > MAX_WORKFLOW_BYTES ||
    data.content.length > MAX_WORKFLOW_BYTES * 1.5
  )
    throw new PublisherSetupError(
      "workflow_unavailable",
      "This workflow is not a supported text file or exceeds the 48 KB draft limit.",
      409,
    );
  try {
    const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length > MAX_WORKFLOW_BYTES) throw new Error("oversized");
    return {
      path: workflowPath,
      sha: data.sha,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw new PublisherSetupError(
      "workflow_unavailable",
      "This workflow could not be read as UTF-8 text.",
      409,
    );
  }
}

export async function inspectPublisherSetup(
  client: SetupGithubClient,
  installationRowId: string,
): Promise<PublisherSetupInspection> {
  const baseSha = await setupDefaultHead(client);
  const listing = await client.request(`/contents/.github/workflows?ref=${baseSha}`, {}, true);
  if (listing !== null && !Array.isArray(listing))
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not return a workflow listing.",
      502,
    );
  const paths = (listing ?? [])
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.type === "file" &&
        typeof entry.path === "string" &&
        validSetupWorkflowPath(entry.path),
    )
    .map((entry) => String(entry.path))
    .sort();
  const warnings: string[] = [];
  if (paths.length > MAX_WORKFLOWS)
    warnings.push(
      "Only the first 12 workflow files are shown. Other release paths may still publish independently.",
    );
  const workflows: PublisherSetupInspection["workflows"] = [];
  for (const path of paths.slice(0, MAX_WORKFLOWS)) {
    try {
      workflows.push(await readSetupWorkflow(client, path, baseSha));
    } catch (error) {
      if (!(error instanceof PublisherSetupError) || error.code !== "workflow_unavailable")
        throw error;
      warnings.push(`${path} exceeds the supported text workflow limits.`);
    }
  }
  if (!workflows.length)
    warnings.push(
      "No supported workflow files were found. Add a release workflow using the ecosystem guide, then inspect again.",
    );
  return {
    installationRowId,
    repositoryId: client.repository.id,
    repositoryFullName: client.repository.fullName,
    defaultBranch: client.repository.defaultBranch ?? "",
    baseSha,
    workflows,
    warnings,
  };
}

function setupGithubSha(value: unknown): string {
  if (typeof value !== "string" || !validSetupSha(value))
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not confirm a valid setup revision.",
      502,
    );
  return value;
}

async function setupCommitTree(client: SetupGithubClient, revision: string): Promise<string> {
  const commit = await client.request(`/git/commits/${revision}`);
  if (!isRecord(commit) || commit.sha !== revision || !isRecord(commit.tree))
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not confirm the pinned source tree.",
      502,
    );
  return setupGithubSha(commit.tree.sha);
}

async function readRegularSetupFile(client: SetupGithubClient, path: string, revision: string) {
  if (!validSetupFilePath(path) || !validSetupSha(revision))
    throw new PublisherSetupError(
      "proposal_invalid",
      "The setup file or revision is not supported.",
      409,
    );
  let treeSha = await setupCommitTree(client, revision);
  const segments = path.split("/");
  let blobSha = "";
  let mode = "";
  for (let index = 0; index < segments.length; index++) {
    const listing = await client.request(`/git/trees/${treeSha}`);
    if (
      !isRecord(listing) ||
      !Array.isArray(listing.tree) ||
      listing.truncated !== false ||
      listing.tree.length > SETUP_TREE_MAX_ENTRIES
    )
      throw new PublisherSetupError(
        "github_unavailable",
        "GitHub could not inspect a bounded setup tree.",
        502,
      );
    const entry = listing.tree.find((value) => isRecord(value) && value.path === segments[index]);
    if (setupTreeHasCaseTwin(listing.tree, segments[index]))
      throw new PublisherSetupError(
        "proposal_file_conflict",
        "A setup path differs only by letter case from another repository entry. Configure this workflow manually.",
        409,
      );
    if (!isRecord(entry)) return null;
    const directory = index < segments.length - 1;
    if (
      (directory && (entry.type !== "tree" || entry.mode !== "040000")) ||
      (!directory &&
        (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")))
    )
      throw new PublisherSetupError(
        "proposal_file_conflict",
        "A setup path is a symlink or another unsupported entry. Configure this workflow manually.",
        409,
      );
    treeSha = setupGithubSha(entry.sha);
    if (!directory) {
      blobSha = treeSha;
      mode = entry.mode as string;
    }
  }
  const data = await client.request(
    `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`,
  );
  const maximum = 65_536;
  if (
    !isRecord(data) ||
    data.type !== "file" ||
    data.path !== path ||
    data.sha !== blobSha ||
    data.encoding !== "base64" ||
    typeof data.content !== "string" ||
    data.content.length > maximum * 1.5 ||
    typeof data.size !== "number" ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0 ||
    data.size > maximum ||
    "target" in data ||
    "submodule_git_url" in data
  )
    throw new PublisherSetupError(
      "proposal_file_conflict",
      "The pinned setup file is not a supported regular UTF-8 file.",
      409,
    );
  try {
    const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length !== data.size || bytes.length > maximum) throw new Error("size");
    return {
      path,
      sha: blobSha,
      mode,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw new PublisherSetupError(
      "proposal_file_conflict",
      "The pinned setup file is not supported UTF-8 text.",
      409,
    );
  }
}

async function prepareSetupProposalBranch(
  client: SetupGithubClient,
  proposal: PublisherSetupProposal,
  branch: string,
  beforeWrite: (() => Promise<void>) | undefined,
  existingPullRequest: boolean,
): Promise<void> {
  const original = await readRegularSetupFile(client, proposal.workflowPath, proposal.baseSha);
  if (!original || original.sha !== proposal.originalSha)
    throw new PublisherSetupError(
      "proposal_stale",
      "The pinned workflow source changed. Inspect the repository and start a fresh setup.",
      409,
    );
  const files = [
    {
      path: proposal.workflowPath,
      content: proposal.content,
      mode: original.mode,
      changed: original.content !== proposal.content,
    },
  ];
  for (const file of proposal.supportingFiles ?? []) {
    const before = await readRegularSetupFile(client, file.path, proposal.baseSha);
    if (
      (before?.sha ?? null) !== file.originalSha ||
      (before?.content ?? null) !== file.originalContent
    )
      throw new PublisherSetupError(
        "proposal_stale",
        "A pinned supporting file changed. Inspect the repository and start a fresh setup.",
        409,
      );
    files.push({
      path: file.path,
      content: file.content,
      mode: before?.mode ?? "100644",
      changed: before?.content !== file.content,
    });
  }
  const changedFiles = files.filter((file) => file.changed);
  const changedPaths = new Set(changedFiles.map((file) => file.path));
  if (!changedPaths.size)
    throw new PublisherSetupError(
      "proposal_no_changes",
      "The proposal does not change any repository files.",
      409,
    );
  const ref = await client.request(`/git/ref/heads/${encodeURIComponent(branch)}`, {}, true);
  const head =
    ref === null
      ? null
      : isRecord(ref) && isRecord(ref.object)
        ? setupGithubSha(ref.object.sha)
        : setupGithubSha(null);
  if (head && head !== proposal.baseSha) {
    const comparison = await client.request(`/compare/${proposal.baseSha}...${head}`);
    let contentsMatch = true;
    for (const file of files) {
      try {
        const current = await readRegularSetupFile(client, file.path, head);
        if (current?.content !== file.content || current.mode !== file.mode) contentsMatch = false;
      } catch (error) {
        if (!(error instanceof PublisherSetupError) || error.code !== "proposal_file_conflict")
          throw error;
        contentsMatch = false;
      }
    }
    if (
      !isRecord(comparison) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length !== changedPaths.size ||
      comparison.files.some(
        (file) =>
          !isRecord(file) ||
          typeof file.filename !== "string" ||
          !changedPaths.has(file.filename) ||
          "previous_filename" in file,
      ) ||
      new Set(comparison.files.map((file) => (isRecord(file) ? file.filename : null))).size !==
        changedPaths.size ||
      !contentsMatch
    )
      throw new PublisherSetupError(
        "proposal_branch_changed",
        "The setup branch contains other edits. Review it on GitHub instead of overwriting it.",
        409,
      );
    return;
  }
  if (existingPullRequest)
    throw new PublisherSetupError(
      "proposal_branch_changed",
      "The setup pull request no longer contains its proposed files. Review it on GitHub.",
      409,
    );
  if ((await setupDefaultHead(client)) !== proposal.baseSha)
    throw new PublisherSetupError(
      "proposal_stale",
      "The default branch changed. Inspect the repository and start a fresh setup.",
      409,
    );
  const baseTree = await setupCommitTree(client, proposal.baseSha);
  await beforeWrite?.();
  const tree = await client.request("/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTree,
      tree: changedFiles.map((file) => ({
        path: file.path,
        mode: file.mode,
        type: "blob",
        content: file.content,
      })),
    }),
  });
  const newTree = setupGithubSha(isRecord(tree) ? tree.sha : null);
  await beforeWrite?.();
  const commit = await client.request("/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: "Configure Drydock release review [skip ci]",
      tree: newTree,
      parents: [proposal.baseSha],
    }),
  });
  const newCommit = setupGithubSha(isRecord(commit) ? commit.sha : null);
  await beforeWrite?.();
  // Branch creation fires `create` workflows from the new ref's head, and [skip ci] does
  // not suppress that event; create at the reviewed base so only a skipped push carries
  // the drafted files.
  if (head === null)
    await client.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: proposal.baseSha }),
    });
  await beforeWrite?.();
  await client.request(`/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit, force: false }),
  });
}

/** Agent text can carry repository-steered mentions or closing keywords; a fence keeps them inert. */
function inertMarkdown(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export async function createSetupPullRequest(
  client: SetupGithubClient,
  proposal: PublisherSetupProposal,
  beforeWrite?: () => Promise<void>,
): Promise<PublisherSetupPullRequest & { created: boolean }> {
  const supportingFiles = proposal.supportingFiles ?? [];
  if (
    !Array.isArray(supportingFiles) ||
    supportingFiles.some(
      (file) =>
        !isRecord(file) ||
        typeof file.path !== "string" ||
        typeof file.content !== "string" ||
        (file.originalSha !== null && typeof file.originalSha !== "string") ||
        (file.originalContent !== null && typeof file.originalContent !== "string"),
    )
  )
    throw new PublisherSetupError(
      "proposal_invalid",
      "The proposed repository edits are invalid.",
      409,
    );
  const paths = [proposal.workflowPath, ...supportingFiles.map((file) => file.path)];
  if (
    !validSetupWorkflowPath(proposal.workflowPath) ||
    !validSetupSha(proposal.baseSha) ||
    !validSetupSha(proposal.originalSha) ||
    supportingFiles.length > 12 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !validSetupFilePath(path) ||
        paths.some((other) => other !== path && other.startsWith(`${path}/`)),
    ) ||
    supportingFiles.some(
      (file) =>
        typeof file.content !== "string" ||
        file.content.includes("\0") ||
        new TextEncoder().encode(file.content).byteLength > 65_536 ||
        (file.originalSha === null
          ? file.originalContent !== null
          : !validSetupSha(file.originalSha) ||
            typeof file.originalContent !== "string" ||
            new TextEncoder().encode(file.originalContent).byteLength > 65_536) ||
        file.content === file.originalContent,
    ) ||
    new TextEncoder().encode(proposal.content).byteLength +
      supportingFiles.reduce(
        (bytes, file) => bytes + new TextEncoder().encode(file.content).byteLength,
        0,
      ) >
      262_144 ||
    new TextEncoder().encode(proposal.content).byteLength > 65_536
  )
    throw new PublisherSetupError(
      "proposal_invalid",
      "The proposed repository edits exceed supported path, identity, file, or byte limits.",
      409,
    );
  if (
    client.repository.id !== proposal.repositoryId ||
    client.repository.defaultBranch !== proposal.defaultBranch
  ) {
    throw new PublisherSetupError(
      "proposal_stale",
      "The repository identity or default branch changed. Create a fresh draft.",
      409,
    );
  }
  // The branch derives from what gets written, not from the proposal's expiry
  // or prose, so re-drafting identical content reuses the same branch.
  const written = {
    repositoryId: proposal.repositoryId,
    workflowPath: proposal.workflowPath,
    baseSha: proposal.baseSha,
    originalSha: proposal.originalSha,
    content: proposal.content,
    ...(supportingFiles.length
      ? {
          supportingFiles: [...supportingFiles].sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          ),
        }
      : {}),
  };
  const branch = `drydock/setup-${(await sha256Hex(canonicalJson(written))).slice(0, 20)}`;
  const owner = client.repository.fullName.split("/")[0];
  // Only an open PR is recovered. A closed one falls through: the branch check
  // below reopens its exact one-file branch as a new PR, and a merged one fails
  // as stale because the default branch moved.
  const pulls = await client.request(
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(proposal.defaultBranch)}&per_page=1`,
  );
  if (!Array.isArray(pulls))
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub could not check for an existing setup PR.",
      502,
    );
  const existing = pulls.find(
    (pr) =>
      isRecord(pr) &&
      Number.isSafeInteger(pr.number) &&
      isRecord(pr.head) &&
      pr.head.ref === branch &&
      isRecord(pr.head.repo) &&
      pr.head.repo.id === proposal.repositoryId &&
      isRecord(pr.base) &&
      pr.base.ref === proposal.defaultBranch &&
      isRecord(pr.base.repo) &&
      pr.base.repo.id === proposal.repositoryId,
  );
  if (isRecord(existing) && typeof existing.number === "number" && !supportingFiles.length) {
    await prepareSetupProposalBranch(client, proposal, branch, beforeWrite, true);
    return { ...setupPullRequestResult(client, existing.number, branch), created: false };
  }
  if (supportingFiles.length) {
    await prepareSetupProposalBranch(client, proposal, branch, beforeWrite, Boolean(existing));
    if (isRecord(existing) && typeof existing.number === "number")
      return { ...setupPullRequestResult(client, existing.number, branch), created: false };
  } else {
    if ((await setupDefaultHead(client)) !== proposal.baseSha)
      throw new PublisherSetupError(
        "proposal_stale",
        "The default branch changed. Inspect the repository and create a fresh draft before opening the PR.",
        409,
      );
    const original = await readSetupWorkflow(client, proposal.workflowPath, proposal.baseSha);
    if (original.sha !== proposal.originalSha)
      throw new PublisherSetupError(
        "proposal_stale",
        "The workflow changed. Create a fresh draft.",
        409,
      );
    if (original.content === proposal.content)
      throw new PublisherSetupError(
        "proposal_no_changes",
        "The proposal does not change any repository files.",
        409,
      );
    const ref = await client.request(`/git/ref/heads/${encodeURIComponent(branch)}`, {}, true);
    if (ref === null) {
      await beforeWrite?.();
      await client.request("/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: proposal.baseSha }),
      });
    } else if (!isRecord(ref) || !isRecord(ref.object) || typeof ref.object.sha !== "string") {
      throw new PublisherSetupError(
        "github_unavailable",
        "GitHub could not confirm the setup branch revision.",
        502,
      );
    }
    const branchHead =
      ref === null ? proposal.baseSha : String((ref as { object: { sha: string } }).object.sha);
    if (branchHead === proposal.baseSha) {
      await beforeWrite?.();
      await client.request(`/contents/${proposal.workflowPath}`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Configure Drydock release review [skip ci]",
          branch,
          sha: proposal.originalSha,
          content: base64Encode(new TextEncoder().encode(proposal.content)),
        }),
      });
    } else {
      await prepareSetupProposalBranch(client, proposal, branch, beforeWrite, false);
    }
  }
  await beforeWrite?.();
  const result = await client.request("/pulls", {
    method: "POST",
    body: JSON.stringify({
      title: "Configure Drydock release review",
      head: branch,
      base: proposal.defaultBranch,
      draft: true,
      body: `Adds a proposed release workflow for Drydock review. Review every workflow change before merging.\n\n${inertMarkdown(proposal.summary)}\n\nSetup still required:\n${proposal.manualSteps.map((step) => `- ${step}`).join("\n")}\n\nThis PR does not configure GitHub Environment protection rules or prove that a release is protected. Verify a real gated release in Drydock after setup.`,
    }),
  });
  if (
    !isRecord(result) ||
    typeof result.number !== "number" ||
    !Number.isSafeInteger(result.number) ||
    result.number <= 0
  )
    throw new PublisherSetupError(
      "github_unavailable",
      "The setup branch was created, but GitHub did not confirm the draft PR. Retry the same proposal to recover its existing branch or PR.",
      502,
    );
  return { ...setupPullRequestResult(client, result.number, branch), created: true };
}

function setupPullRequestResult(
  client: SetupGithubClient,
  number: number,
  branch: string,
): PublisherSetupPullRequest {
  return { number, url: `https://github.com/${client.repository.fullName}/pull/${number}`, branch };
}
