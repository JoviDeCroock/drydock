import {
  ENVIRONMENT_MAX,
  GithubAppValidationError,
  PUBLISHER_SOURCED_ECOSYSTEMS,
  REPO_FULL_NAME_MAX,
  SUPPORTED_ECOSYSTEMS,
} from "./config";
import type { CreateReleaseTargetInput } from "./persistence";

// A DID is the longest legitimate spelling and atproto bounds those well below
// this; the value is a name, not a document.
const PUBLISHER_REF_MAX = 512;

const REPO_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateReleaseTargetShape(input: CreateReleaseTargetInput) {
  // Null pins nothing: the runner auto-detects the ecosystem from the uploaded
  // artifacts. A non-null value must be a supported ecosystem.
  if (input.ecosystem !== null && !SUPPORTED_ECOSYSTEMS.includes(input.ecosystem)) {
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
  validatePublisherRef(input);
}

/**
 * A release target names a publishing account only for ecosystems whose gate
 * candidate is not a workflow upload. Requiring it up front turns "atpm gate
 * configured without a publisher" into a validation error at configuration
 * time rather than a gate that errors on its first real release.
 */
function validatePublisherRef(input: CreateReleaseTargetInput) {
  const publisherRef = input.publisherRef?.trim() ?? "";
  const needsPublisher =
    input.ecosystem !== null &&
    (PUBLISHER_SOURCED_ECOSYSTEMS as readonly string[]).includes(input.ecosystem);
  if (!needsPublisher) {
    if (publisherRef) {
      throw new GithubAppValidationError(
        "invalid_input",
        `${input.ecosystem ?? "auto"} release targets review uploaded artifacts and take no publisher`,
      );
    }
    return;
  }
  if (!publisherRef || publisherRef.length > PUBLISHER_REF_MAX) {
    throw new GithubAppValidationError(
      "invalid_input",
      `${input.ecosystem} release targets must name the publishing account`,
    );
  }
  if (hasControlCharacter(publisherRef)) {
    throw new GithubAppValidationError("invalid_input", "publisher has invalid characters");
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
