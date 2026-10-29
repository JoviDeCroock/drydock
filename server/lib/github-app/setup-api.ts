import { githubHeaders } from "./client";
import type { GithubAppConfig } from "./config";
import { generateGithubAppJwt } from "./jwt";
import { parseRepositoryFullName } from "./validation";
import { readBoundedJson } from "../platform/bounded-body";
import { base64Encode, sha256Hex } from "../platform/crypto-utils";
import { canonicalJson } from "../platform/canonical-json";
import { isRecord } from "../platform/guards";
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

export async function createSetupClient(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  write = false,
) {
  const parsed = parseRepositoryFullName(fullName);
  if (!parsed)
    throw new PublisherSetupError("invalid_input", "Choose a repository in owner/repository form.");
  const path = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
  const jwt = await generateGithubAppJwt(config);
  const permissions = write
    ? { contents: "write", pull_requests: "write", workflows: "write" }
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
        ? "Creating a workflow PR requires this installation to grant Contents, Pull requests, and Workflows write permissions. Ask the GitHub App operator to enable these optional permissions, then approve the installation update. You can still copy the draft manually."
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

export async function createSetupPullRequest(
  client: SetupGithubClient,
  proposal: PublisherSetupProposal,
): Promise<PublisherSetupPullRequest & { created: boolean }> {
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
  if (isRecord(existing) && typeof existing.number === "number")
    return { ...setupPullRequestResult(client, existing.number, branch), created: false };
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
  const ref = await client.request(`/git/ref/heads/${encodeURIComponent(branch)}`, {}, true);
  if (ref === null) {
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
    // After an uncertain write, resume only the exact one-file proposal. Never
    // overwrite a collaborator's edits on the proposal's stable branch.
    const comparison = await client.request(
      `/compare/${proposal.baseSha}...${encodeURIComponent(branch)}`,
    );
    const current = await readSetupWorkflow(client, proposal.workflowPath, branchHead);
    if (
      !isRecord(comparison) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length !== 1 ||
      !isRecord(comparison.files[0]) ||
      comparison.files[0].filename !== proposal.workflowPath ||
      current.content !== proposal.content
    ) {
      throw new PublisherSetupError(
        "proposal_branch_changed",
        "The setup branch contains other edits. Review it on GitHub instead of overwriting it.",
        409,
      );
    }
  }
  const result = await client.request("/pulls", {
    method: "POST",
    body: JSON.stringify({
      title: "Configure Drydock release review",
      head: branch,
      base: proposal.defaultBranch,
      draft: true,
      body: `Adds a proposed release workflow for Drydock review. Review every workflow change before merging.\n\n${proposal.summary}\n\nSetup still required:\n${proposal.manualSteps.map((step) => `- ${step}`).join("\n")}\n\nThis PR does not configure GitHub Environment protection rules or prove that a release is protected. Verify a real gated release in Drydock after setup.`,
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
