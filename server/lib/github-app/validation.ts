import {
  ENVIRONMENT_MAX,
  GithubAppValidationError,
  PACKAGE_NAME_MAX,
  REPO_FULL_NAME_MAX,
  SUPPORTED_ECOSYSTEMS,
  WORKFLOW_FILENAME_MAX,
} from "./config";
import type { CreateReleaseTargetInput } from "./persistence";

const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
const REPO_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const WORKFLOW_FILENAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export function validateReleaseTargetShape(input: CreateReleaseTargetInput) {
  if (!SUPPORTED_ECOSYSTEMS.includes(input.ecosystem)) {
    throw new GithubAppValidationError(
      "unsupported_ecosystem",
      `unsupported ecosystem: ${input.ecosystem}`,
    );
  }
  if (!input.packageName || input.packageName.length > PACKAGE_NAME_MAX) {
    throw new GithubAppValidationError("invalid_input", "packageName is required");
  }
  if (!PACKAGE_NAME_RE.test(input.packageName)) {
    throw new GithubAppValidationError("invalid_input", "packageName has invalid characters");
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
  const pypiTrustedPublisherEnvironment = normalizeGithubEnvironmentName(
    input.pypiTrustedPublisherEnvironment,
  );
  if (!environment || environment.length > ENVIRONMENT_MAX) {
    throw new GithubAppValidationError(
      "environment_unmapped",
      "environment is required and must not exceed 255 characters",
    );
  }
  if (hasControlCharacter(environment)) {
    throw new GithubAppValidationError("invalid_input", "environment has invalid characters");
  }
  if (
    !pypiTrustedPublisherEnvironment ||
    pypiTrustedPublisherEnvironment.length > ENVIRONMENT_MAX
  ) {
    throw new GithubAppValidationError(
      "environment_unmapped",
      "pypiTrustedPublisherEnvironment is required and must not exceed 255 characters",
    );
  }
  if (hasControlCharacter(pypiTrustedPublisherEnvironment)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "pypiTrustedPublisherEnvironment has invalid characters",
    );
  }
  if (environment !== pypiTrustedPublisherEnvironment) {
    throw new GithubAppValidationError(
      "environment_mismatch",
      "environment must match the PyPI Trusted Publisher environment so the gate runs against the same job",
    );
  }
  if (input.workflowFilename) {
    if (input.workflowFilename.length > WORKFLOW_FILENAME_MAX) {
      throw new GithubAppValidationError("invalid_input", "workflowFilename is too long");
    }
    if (!WORKFLOW_FILENAME_RE.test(input.workflowFilename)) {
      throw new GithubAppValidationError(
        "invalid_input",
        "workflowFilename must look like 'release.yml'",
      );
    }
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
