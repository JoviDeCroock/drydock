/**
 * Reads GitHub's actual gate configuration for the guided setup wizard.
 *
 * Drydock deliberately does not create the environment, register itself as the
 * protection rule, or commit the publish workflow. Those mutations would need
 * `administration: write` plus `contents`/`workflows`/`pull_requests: write` on
 * every gated repository — a standing grant to rewrite the very workflow the
 * gate protects, in exchange for saving a maintainer about a dozen one-time
 * clicks. Acting *as* a deployment-protection rule needs no repository
 * permission at all (GitHub only requires that an App review its own rules), so
 * the setup wizard links out to GitHub and verifies the result instead.
 *
 * Every read here is repository-read tier and already used elsewhere in the
 * App, so guided setup adds no permission to the installation.
 *
 * Nothing here logs a GitHub response body, header, or the installation token.
 */
import { getInstallationAccessToken } from "./api";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubInstallationHeaders } from "./http";
import {
  GATE_SETUP_ENVIRONMENT_NAME_RE,
  GATE_SETUP_PACKAGE_NAME_RE,
  parseRepositoryFullName,
} from "./validation";
import { emitOperationalEvent } from "../platform/observability";
import { reliableFetch } from "../platform/reliable-fetch";

/**
 * `unknown` is not a failure the maintainer has to act on — it means GitHub did
 * not answer clearly enough for Drydock to claim either state, and the wizard
 * must not render a green badge on it.
 */
type GateSetupCheck = "present" | "absent" | "unknown";

export interface GateSetupState {
  environment: GateSetupCheck;
  protectionRule: GateSetupCheck;
  /** Populated from the repository read; the new-file deep link needs it. */
  defaultBranch: string | null;
  /** Set when a read could not be completed. Never carries a GitHub body. */
  unavailableReason?: string;
}

/**
 * Guard the identifiers the wizard interpolates into generated workflow YAML.
 *
 * Only the preview path needs these: they end up inside double-quoted YAML
 * scalars in a file a maintainer will merge, so anything that could terminate
 * the scalar or look like an Actions expression is refused rather than escaped.
 * Verification deliberately does *not* apply them — an environment that already
 * exists on GitHub may be outside this allowlist and must still be checkable.
 */
export function assertGateSetupEnvironment(environmentName: string): void {
  if (!GATE_SETUP_ENVIRONMENT_NAME_RE.test(environmentName)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "environment must be 1-128 characters of letters, digits, spaces, or . _ -",
    );
  }
}

export function assertGateSetupPackageName(packageName: string): void {
  if (!GATE_SETUP_PACKAGE_NAME_RE.test(packageName)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "packageName must be 1-214 characters of letters, digits, or @ . _ / -",
    );
  }
}

function repositoryPath(fullName: string): string {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function unavailable(state: Partial<GateSetupState>, reason: string): GateSetupState {
  emitOperationalEvent("warn", "github_app.gate_setup_check_unavailable", { reason });
  return {
    environment: "unknown",
    protectionRule: "unknown",
    defaultBranch: null,
    ...state,
    unavailableReason: reason,
  };
}

function reasonForStatus(status: number): string {
  if (status === 403 || status === 401) {
    return "The Drydock App installation cannot read this repository's settings.";
  }
  if (status === 404) {
    return "The installation cannot see this repository.";
  }
  return `GitHub returned ${status} while reading this repository's gate configuration.`;
}

/**
 * Read whether the environment exists and whether Drydock is its protection rule.
 *
 * Both reads are best effort in the same direction: a read Drydock could not
 * complete resolves to `unknown`, never to a confident `absent`, so the wizard
 * can never report a gate as armed — or as broken — on a failed lookup.
 */
export async function readGateSetupState(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  environmentName: string,
): Promise<GateSetupState> {
  const appId = Number(config.appId);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new GithubAppValidationError(
      "invalid_input",
      "GITHUB_APP_ID must be the numeric GitHub App id to verify a protection rule",
    );
  }
  const path = repositoryPath(fullName);
  const environmentPath = encodeURIComponent(environmentName);

  let headers: Record<string, string>;
  try {
    headers = githubInstallationHeaders(await getInstallationAccessToken(config, installationId));
  } catch (err) {
    if (err instanceof GithubAppValidationError) throw err;
    return unavailable({}, "Drydock could not authenticate to GitHub for this installation.");
  }

  const defaultBranch = await readDefaultBranch(path, headers);

  let environmentResponse: Response;
  try {
    environmentResponse = await reliableFetch(
      `https://api.github.com/repos/${path}/environments/${environmentPath}`,
      { headers },
    );
  } catch {
    return unavailable({ defaultBranch }, "Drydock could not reach GitHub. Retry in a moment.");
  }
  if (environmentResponse.status === 404) {
    // A missing environment is a definite answer, and its protection rule
    // cannot exist either — reading the rules would 404 for the same reason.
    return { environment: "absent", protectionRule: "absent", defaultBranch };
  }
  if (!environmentResponse.ok) {
    return unavailable({ defaultBranch }, reasonForStatus(environmentResponse.status));
  }

  let rulesResponse: Response;
  try {
    rulesResponse = await reliableFetch(
      `https://api.github.com/repos/${path}/environments/${environmentPath}/deployment_protection_rules`,
      { headers },
    );
  } catch {
    return unavailable(
      { environment: "present", defaultBranch },
      "Drydock could not reach GitHub to read this environment's protection rules.",
    );
  }
  if (!rulesResponse.ok) {
    return unavailable(
      { environment: "present", defaultBranch },
      reasonForStatus(rulesResponse.status),
    );
  }

  const data = (await rulesResponse.json().catch(() => ({}))) as {
    custom_deployment_protection_rules?: { app?: { id?: number } | null }[];
  };
  const enabled = (data.custom_deployment_protection_rules ?? []).some(
    (rule) => rule.app?.id === appId,
  );
  return {
    environment: "present",
    protectionRule: enabled ? "present" : "absent",
    defaultBranch,
  };
}

/**
 * The default branch only feeds the "create this file on GitHub" deep link, so
 * a failed read degrades the link rather than the whole check.
 */
async function readDefaultBranch(
  path: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const response = await reliableFetch(`https://api.github.com/repos/${path}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as { default_branch?: string };
    return typeof data.default_branch === "string" && data.default_branch
      ? data.default_branch
      : null;
  } catch {
    return null;
  }
}
