import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubHeaders, paginate } from "./client";
import { generateGithubAppJwt } from "./jwt";
import { parseRepositoryFullName } from "./validation";
import { emitOperationalEvent } from "../platform/observability";
import { reliableFetch } from "../platform/reliable-fetch";

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
      headers: githubHeaders(jwt),
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

/**
 * A refused or unusable installation-token mint. It keeps the long-standing
 * `installation_inactive` code for existing callers, and carries GitHub's
 * status so a caller that has to tell "GitHub stopped honoring this
 * installation" (403 suspended / 404 removed) apart from a mint that simply did
 * not complete (5xx, a rate limit, a body without a token) can do so without
 * parsing the message. `status` is null when GitHub answered 2xx without a
 * token.
 */
export class InstallationTokenError extends GithubAppValidationError {
  constructor(
    readonly status: number | null,
    readonly rateLimited: boolean,
    message: string,
  ) {
    super("installation_inactive", message);
    this.name = "InstallationTokenError";
  }
}

/**
 * GitHub signals a primary or secondary rate limit with 429, or with a 403
 * that carries `retry-after` or an exhausted `x-ratelimit-remaining`. A 403
 * without either is a real refusal.
 */
function isGithubRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

export async function getInstallationAccessToken(
  config: GithubAppConfig,
  installationId: string,
): Promise<string> {
  const jwt = await generateGithubAppJwt(config);
  const response = await reliableFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(jwt),
      retryMethods: ["POST"],
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new InstallationTokenError(
      response.status,
      isGithubRateLimited(response),
      `installation access token request failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new InstallationTokenError(
      null,
      false,
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
    headers: githubHeaders(token),
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
  // 50 pages × 100 = 5,000 repositories. An installation is one account, and a
  // picker listing more than that is unusable anyway; the cap exists so a
  // pathological account cannot pin a Worker invocation on pagination.
  const { complete } = await paginate(
    "https://api.github.com/installation/repositories?per_page=100",
    { headers: githubHeaders(token), maxPages: 50 },
    async (response) => {
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
    },
  );

  if (!complete) {
    // The picker shows a partial list rather than failing; the event makes a
    // silently-short list diagnosable.
    emitOperationalEvent("warn", "github_app.repository_listing_truncated", {
      installationId,
      repositories: repositories.length,
    });
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
  await paginate(
    `https://api.github.com/repos/${repositoryPath}/environments?per_page=100`,
    { headers: githubHeaders(token), maxPages: 10 },
    async (response) => {
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
    },
  );

  return environments;
}
