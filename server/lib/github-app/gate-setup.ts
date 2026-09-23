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
import { InstallationTokenError, getInstallationAccessToken } from "./api";
import { githubHeaders } from "./client";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
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

/**
 * Whether a repository admin can push a held deployment past every protection
 * rule, Drydock's included. GitHub allows it by default. It does not make the
 * gate unarmed — the rule still holds every run nobody overrides — but it is a
 * standing way around the review, so the wizard surfaces it.
 */
type GateSetupAdminBypass = "allowed" | "blocked" | "unknown";

export interface GateSetupState {
  environment: GateSetupCheck;
  protectionRule: GateSetupCheck;
  adminBypass: GateSetupAdminBypass;
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
    adminBypass: "unknown",
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
  // `.` and `..` survive encodeURIComponent and are then collapsed by URL
  // normalization, which would silently retarget the environment read at the
  // *list* endpoint and report a non-existent environment as present. Neither
  // is a name GitHub can hold, so they are rejected rather than checked.
  const trimmedEnvironment = environmentName.trim();
  if (!trimmedEnvironment || trimmedEnvironment === "." || trimmedEnvironment === "..") {
    throw new GithubAppValidationError(
      "invalid_input",
      "environment name is not a GitHub environment",
    );
  }
  const environmentPath = encodeURIComponent(environmentName);

  let headers: Record<string, string>;
  try {
    headers = githubHeaders(await getInstallationAccessToken(config, installationId));
  } catch (err) {
    // GitHub refuses a token for an installation it has suspended (403) or that
    // no longer exists (404): a definite state the maintainer has to act on,
    // and the same `installation_inactive` answer Drydock gives when its own
    // row says so. Everything else — a 5xx, a rate limit, a 2xx without a
    // token, a JWT Drydock could not sign — is a mint that did not complete,
    // which this function's contract makes `unknown`. Neither path forwards
    // GitHub's response body.
    if (
      err instanceof InstallationTokenError &&
      !err.rateLimited &&
      (err.status === 403 || err.status === 404)
    ) {
      throw new GithubAppValidationError(
        "installation_inactive",
        "GitHub no longer accepts this installation. Unsuspend or reinstall the Drydock GitHub App, then check again.",
      );
    }
    return unavailable({}, "Drydock could not authenticate to GitHub for this installation.");
  }

  const repository = await readRepository(path, headers);
  const defaultBranch = repository.status === "visible" ? repository.defaultBranch : null;

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
    // GitHub answers 404 both for an environment that does not exist and for a
    // repository this installation cannot see, and the two want opposite
    // answers. Only a repository read that actually succeeded makes the missing
    // environment a definite answer; otherwise the 404 is unattributable and
    // stays `unknown`, per this function's contract.
    if (repository.status !== "visible") {
      return unavailable({ defaultBranch }, repository.reason);
    }
    // A missing environment is a definite answer, and its protection rule
    // cannot exist either — reading the rules would 404 for the same reason.
    return {
      environment: "absent",
      protectionRule: "absent",
      adminBypass: "unknown",
      defaultBranch,
    };
  }
  if (!environmentResponse.ok) {
    return unavailable({ defaultBranch }, reasonForStatus(environmentResponse.status));
  }
  const adminBypass = readAdminBypass(await environmentResponse.json().catch(() => null));

  let rulesResponse: Response;
  try {
    rulesResponse = await reliableFetch(
      `https://api.github.com/repos/${path}/environments/${environmentPath}/deployment_protection_rules`,
      { headers },
    );
  } catch {
    return unavailable(
      { environment: "present", adminBypass, defaultBranch },
      "Drydock could not reach GitHub to read this environment's protection rules.",
    );
  }
  if (!rulesResponse.ok) {
    return unavailable(
      { environment: "present", adminBypass, defaultBranch },
      reasonForStatus(rulesResponse.status),
    );
  }

  let data: {
    custom_deployment_protection_rules?: { app?: { id?: number } | null; enabled?: boolean }[];
  };
  try {
    data = (await rulesResponse.json()) as typeof data;
  } catch {
    // A 200 whose body will not parse is a read that did not complete. Folding
    // it into an empty rule list would report a live gate as absent.
    return unavailable(
      { environment: "present", adminBypass, defaultBranch },
      "Drydock could not read this environment's protection rules.",
    );
  }
  const rules = data.custom_deployment_protection_rules;
  if (!Array.isArray(rules)) {
    return unavailable(
      { environment: "present", adminBypass, defaultBranch },
      "Drydock could not read this environment's protection rules.",
    );
  }
  // `enabled` is a required field on every rule GitHub returns. A rule that is
  // present but switched off holds nothing, so reading only the app id would
  // badge a gate as armed over a gate that never runs. The test is strict in
  // the safe direction: anything but an explicit `true` reads as not armed,
  // because a green badge over a dead gate is the one answer this wizard must
  // never give.
  const armed = rules.some((rule) => rule.app?.id === appId && rule.enabled === true);
  return {
    environment: "present",
    protectionRule: armed ? "present" : "absent",
    adminBypass,
    defaultBranch,
  };
}

/**
 * GitHub reports the environment's "Allow administrators to bypass configured
 * protection rules" checkbox as `can_admins_bypass`. It is missing from GitHub's
 * published OpenAPI description, so anything but an explicit boolean — an
 * unparsable body included — is `unknown` rather than a guess in either
 * direction.
 */
function readAdminBypass(body: unknown): GateSetupAdminBypass {
  const value =
    body && typeof body === "object"
      ? (body as { can_admins_bypass?: unknown }).can_admins_bypass
      : undefined;
  if (value === true) return "allowed";
  if (value === false) return "blocked";
  return "unknown";
}

type RepositoryRead =
  | { status: "visible"; defaultBranch: string | null }
  | { status: "unreadable"; reason: string };

/**
 * Read the repository itself. The default branch only feeds the "create this
 * file on GitHub" deep link, so a failed read degrades the link — but whether
 * the read succeeded is also the only way to tell a missing environment from a
 * repository this installation cannot see, so the failure is reported rather
 * than swallowed.
 */
async function readRepository(
  path: string,
  headers: Record<string, string>,
): Promise<RepositoryRead> {
  let response: Response;
  try {
    response = await reliableFetch(`https://api.github.com/repos/${path}`, { headers });
  } catch {
    return { status: "unreadable", reason: "Drydock could not reach GitHub. Retry in a moment." };
  }
  if (!response.ok) {
    return { status: "unreadable", reason: reasonForStatus(response.status) };
  }
  const data = (await response.json().catch(() => ({}))) as { default_branch?: string };
  return {
    status: "visible",
    defaultBranch:
      typeof data.default_branch === "string" && data.default_branch ? data.default_branch : null,
  };
}
