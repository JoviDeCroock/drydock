import {
  ENVIRONMENT_MAX,
  GithubAppValidationError,
  REPO_FULL_NAME_MAX,
  SUPPORTED_ECOSYSTEMS,
} from "./config";
import type { CreateReleaseTargetInput } from "./persistence";

const REPO_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateReleaseTargetShape(input: CreateReleaseTargetInput) {
  if (!SUPPORTED_ECOSYSTEMS.includes(input.ecosystem)) {
    throw new GithubAppValidationError(
      "unsupported_ecosystem",
      `unsupported ecosystem: ${input.ecosystem}`,
    );
  }
  if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw new GithubAppValidationError("invalid_input", "repositoryId must be a positive integer");
  }
  if (
    !input.repositoryFullName ||
    input.repositoryFullName.length > REPO_FULL_NAME_MAX ||
    !parseRepositoryFullName(input.repositoryFullName)
  ) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const environment = normalizeGithubEnvironmentName(input.environment);
  if (!environment || environment.length > ENVIRONMENT_MAX) {
    throw new GithubAppValidationError(
      "environment_unmapped",
      "environment is required and must not exceed 255 characters",
    );
  }
  if (hasControlCharacter(environment)) {
    throw new GithubAppValidationError("invalid_input", "environment has invalid characters");
  }
}

export function parseRepositoryFullName(fullName: string): { owner: string; name: string } | null {
  if (!fullName || fullName.length > REPO_FULL_NAME_MAX) return null;
  const parts = fullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    return null;
  }
  if (!REPO_OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) return null;
  return { owner, name };
}

export function normalizeGithubEnvironmentName(environment: string): string {
  return environment.trim().toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
