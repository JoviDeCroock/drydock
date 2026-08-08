import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubAppHeaders, githubInstallationHeaders, nextLink } from "./http";
import { generateGithubAppJwt } from "./jwt";
import { parseRepositoryFullName } from "./validation";
import { reliableFetch, type ReliableFetchOptions } from "../platform/reliable-fetch";

export interface GithubInstallationMetadata {
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  targetType: string;
  suspended: boolean;
}

export async function fetchInstallationMetadata(
  config: GithubAppConfig,
  installationId: string,
): Promise<GithubInstallationMetadata> {
  const jwt = await generateGithubAppJwt(config);
  const response = await reliableFetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: githubAppHeaders(jwt),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "installation_missing",
      `GitHub installation ${installationId} could not be fetched (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    id?: number | string;
    account?: { login?: string; type?: string } | null;
    target_type?: string;
    suspended_at?: string | null;
  };
  const idValue =
    typeof data.id === "number" ? String(data.id) : typeof data.id === "string" ? data.id : null;
  if (!idValue)
    throw new GithubAppValidationError("installation_missing", "missing installation id");
  const login = typeof data.account?.login === "string" ? data.account.login : "";
  const accountType =
    data.account?.type === "Organization" || data.account?.type === "User"
      ? data.account.type
      : "Organization";
  return {
    installationId: idValue,
    accountLogin: login,
    accountType,
    targetType: typeof data.target_type === "string" ? data.target_type : accountType,
    suspended: Boolean(data.suspended_at),
  };
}

export async function getInstallationAccessToken(
  config: GithubAppConfig,
  installationId: string,
  fetchOptions: Pick<ReliableFetchOptions, "attempts" | "timeoutMs"> = {},
): Promise<string> {
  const jwt = await generateGithubAppJwt(config);
  const response = await reliableFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubAppHeaders(jwt),
      retryMethods: ["POST"],
      ...fetchOptions,
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation access token request failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new GithubAppValidationError(
      "installation_inactive",
      "installation access token response missing token",
    );
  }
  return data.token;
}

export interface GithubRepositoryRef {
  id: number;
  fullName: string;
  defaultBranch?: string;
}

export async function fetchRepository(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
): Promise<GithubRepositoryRef> {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const token = await getInstallationAccessToken(config, installationId);
  const repositoryPath = `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const response = await reliableFetch(`https://api.github.com/repos/${repositoryPath}`, {
    headers: githubInstallationHeaders(token),
  });
  if (response.status === 404) {
    throw new GithubAppValidationError(
      "repository_not_accessible",
      `repository ${fullName} is not accessible to installation ${installationId}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "repository_not_accessible",
      `repository ${fullName} lookup failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    id?: number;
    full_name?: string;
    default_branch?: string;
  };
  if (typeof data.id !== "number" || typeof data.full_name !== "string") {
    throw new GithubAppValidationError(
      "repository_not_accessible",
      "repository response missing id or full_name",
    );
  }
  return { id: data.id, fullName: data.full_name, defaultBranch: data.default_branch };
}

export async function listInstallationRepositories(
  config: GithubAppConfig,
  installationId: string,
): Promise<GithubRepositoryRef[]> {
  const token = await getInstallationAccessToken(config, installationId);
  const repositories: GithubRepositoryRef[] = [];
  let url = "https://api.github.com/installation/repositories?per_page=100";

  const seenUrls = new Set<string>();
  while (url) {
    if (seenUrls.has(url)) {
      throw new GithubAppValidationError(
        "repository_not_accessible",
        "installation repositories lookup returned a repeated pagination link",
      );
    }
    seenUrls.add(url);
    const response = await reliableFetch(url, { headers: githubInstallationHeaders(token) });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GithubAppValidationError(
        "repository_not_accessible",
        `installation repositories lookup failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      repositories?: {
        id?: number;
        full_name?: string;
        default_branch?: string;
      }[];
    };
    for (const repo of data.repositories ?? []) {
      if (typeof repo.id !== "number" || typeof repo.full_name !== "string") continue;
      repositories.push({
        id: repo.id,
        fullName: repo.full_name,
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
      });
    }
    url = nextLink(response.headers.get("link"));
  }

  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return repositories;
}

export interface GithubEnvironmentRef {
  name: string;
}

export async function listRepositoryEnvironments(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
): Promise<GithubEnvironmentRef[]> {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const token = await getInstallationAccessToken(config, installationId);
  const repositoryPath = `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const environments: GithubEnvironmentRef[] = [];
  let url = `https://api.github.com/repos/${repositoryPath}/environments?per_page=100`;

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await reliableFetch(url, { headers: githubInstallationHeaders(token) });
    if (response.status === 404) {
      throw new GithubAppValidationError(
        "repository_not_accessible",
        `repository ${fullName} is not accessible to installation ${installationId}`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GithubAppValidationError(
        "repository_not_accessible",
        `environments lookup for ${fullName} failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      environments?: { name?: string }[];
    };
    for (const environment of data.environments ?? []) {
      if (typeof environment.name === "string" && environment.name) {
        environments.push({ name: environment.name });
      }
    }
    url = nextLink(response.headers.get("link"));
  }

  return environments;
}

/**
 * Resolve the head commit of a workflow run.
 *
 * Used by the build-attestation cross-check: an attestation claims the commit
 * it built from, and the run's own head commit is the independently-held value
 * to compare it against. Reads through the existing `actions: read` grant that
 * artifact discovery already requires.
 *
 * Returns null rather than throwing — a missing head commit degrades the
 * `source-commit` check to `skipped`, and must never fail a gate review.
 *
 * NOTE: the release-authority work (`github-app/workflow-source.ts` on the
 * port-vila branch) resolves the same field as part of a larger run-context
 * fetch. Whichever lands second should collapse these into one call.
 */
export async function fetchWorkflowRunHeadSha(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  runId: number | string,
): Promise<string | null> {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) return null;
  if (!/^\d{1,20}$/.test(String(runId))) return null;

  try {
    // This lookup is advisory. Keep it on a short single-attempt budget so an
    // unavailable GitHub API cannot delay the release review itself.
    const token = await getInstallationAccessToken(config, installationId, {
      attempts: 1,
      timeoutMs: 5_000,
    });
    const response = await reliableFetch(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/` +
        `${encodeURIComponent(repository.name)}/actions/runs/${String(runId)}`,
      {
        headers: githubInstallationHeaders(token),
        redirect: "manual",
        attempts: 1,
        timeoutMs: 5_000,
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { head_sha?: unknown };
    if (typeof data.head_sha !== "string") return null;
    const headSha = data.head_sha.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(headSha) ? headSha : null;
  } catch {
    return null;
  }
}
