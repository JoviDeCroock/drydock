/**
 * One-click workflow-gate setup against the GitHub API.
 *
 * Everything a maintainer would otherwise do by hand in GitHub settings:
 * create the release environment, make Drydock its custom deployment-protection
 * rule, and open a pull request carrying the gated publish workflow.
 *
 * The installed App may not hold the permissions any given step needs
 * (`actions: read` plus `administration: write` for environments,
 * `workflows: write` for a file under `.github/workflows/`). That is the normal
 * case, so every function here resolves to a typed `GateSetupStepResult`
 * instead of throwing: the wizard degrades each step independently to a manual
 * fallback. Only a broken installation (no token) still throws, and the route
 * maps it.
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

type GateSetupStep = "environment" | "protection_rule" | "pull_request";

type GateSetupStatus = "created" | "already_configured" | "failed";

type GateSetupFailureCode =
  | "permission_denied"
  | "workflow_scope_missing"
  | "repository_not_accessible"
  | "already_exists"
  | "invalid_request"
  | "github_unavailable";

interface GateSetupFailure {
  code: GateSetupFailureCode;
  /** User-facing explanation. Never carries a raw GitHub body or header. */
  message: string;
  /** What to do by hand instead. The UI renders this beside the copyable YAML. */
  manualFallback: string;
}

export interface GateSetupStepResult {
  step: GateSetupStep;
  status: GateSetupStatus;
  failure?: GateSetupFailure;
}

interface GateSetupPullRequestRef {
  number: number;
  url: string;
  branch: string;
}

export interface GateSetupPullRequestResult extends GateSetupStepResult {
  pullRequest?: GateSetupPullRequestRef;
}

/**
 * Guard the identifiers before anything reaches GitHub.
 *
 * Both asserts run on *every* gate-setup endpoint, not just the ones that
 * generate YAML: the environment and protection-rule steps mutate GitHub
 * irreversibly, so a name the later template step would reject has to fail
 * before the first mutation, not after two of them.
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

function failed(step: GateSetupStep, failure: GateSetupFailure): GateSetupStepResult {
  emitOperationalEvent("warn", "github_app.gate_setup_failed", {
    step,
    code: failure.code,
  });
  return { step, status: "failed", failure };
}

class GateSetupTransportError extends Error {
  constructor(readonly failure: GateSetupFailure) {
    super(failure.message);
  }
}

function githubUnavailable(manualFallback: string): GateSetupFailure {
  return {
    code: "github_unavailable",
    message: "Drydock could not reach GitHub for this step. Retry in a moment, or do it by hand.",
    manualFallback,
  };
}

async function gateSetupFetch(
  input: RequestInfo | URL,
  options: RequestInit,
  manualFallback: string,
  onTransportFailure?: () => Promise<void>,
): Promise<Response> {
  try {
    return await reliableFetch(input, options);
  } catch {
    await onTransportFailure?.();
    throw new GateSetupTransportError(githubUnavailable(manualFallback));
  }
}

async function gateSetupHeaders(
  config: GithubAppConfig,
  installationId: string,
  manualFallback: string,
): Promise<Record<string, string>> {
  try {
    const token = await getInstallationAccessToken(config, installationId);
    return githubInstallationHeaders(token);
  } catch (err) {
    if (err instanceof GithubAppValidationError) throw err;
    throw new GateSetupTransportError(githubUnavailable(manualFallback));
  }
}

function transportFailure(step: GateSetupStep, err: unknown): GateSetupStepResult {
  if (err instanceof GateSetupTransportError) return failed(step, err.failure);
  throw err;
}

/**
 * Map a GitHub status onto an actionable failure.
 *
 * `permissionHint` names the App permission the caller's step needs so the
 * message tells the maintainer which checkbox to flip, and `manualFallback`
 * always describes the by-hand path — the wizard renders it inline.
 */
function failureForStatus(
  status: number,
  permissionHint: string,
  manualFallback: string,
): GateSetupFailure {
  if (status === 403 || status === 401) {
    return {
      code: "permission_denied",
      message: `GitHub refused this step: the Drydock App installation does not grant ${permissionHint}.`,
      manualFallback,
    };
  }
  if (status === 404) {
    return {
      code: "repository_not_accessible",
      message: `GitHub returned 404: the installation cannot see this repository, or it does not grant ${permissionHint}.`,
      manualFallback,
    };
  }
  if (status === 422) {
    return {
      code: "invalid_request",
      message: "GitHub rejected this request as invalid for the repository's current state.",
      manualFallback,
    };
  }
  return {
    code: "github_unavailable",
    message: `GitHub returned ${status} for this step. Retry in a moment, or do it by hand.`,
    manualFallback,
  };
}

const ENVIRONMENT_FALLBACK =
  "Create the environment yourself under Settings → Environments → New environment in the repository.";
const PROTECTION_RULE_FALLBACK =
  "Add it yourself under Settings → Environments → the environment → Deployment protection rules → enable the Drydock app.";

async function actionsReadFailure(
  path: string,
  headers: Record<string, string>,
  step: GateSetupStep,
  manualFallback: string,
): Promise<GateSetupStepResult | null> {
  const probe = await gateSetupFetch(
    `https://api.github.com/repos/${path}/environments?per_page=1`,
    { headers },
    manualFallback,
  );
  if (probe.ok) return null;
  return failed(
    step,
    failureForStatus(
      probe.status,
      "Actions read access (needed to distinguish a missing environment from an unreadable one)",
      manualFallback,
    ),
  );
}

/**
 * Create the release environment, idempotently.
 *
 * `PUT /environments/{name}` also *updates* an existing environment (clearing
 * reviewers and wait timers), so an existing environment is detected with a GET
 * first and left exactly as the maintainer configured it.
 */
export async function createRepositoryEnvironment(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  environmentName: string,
): Promise<GateSetupStepResult> {
  try {
    return await createRepositoryEnvironmentWithGithub(
      config,
      installationId,
      fullName,
      environmentName,
    );
  } catch (err) {
    return transportFailure("environment", err);
  }
}

async function createRepositoryEnvironmentWithGithub(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  environmentName: string,
): Promise<GateSetupStepResult> {
  const path = repositoryPath(fullName);
  const environmentPath = encodeURIComponent(environmentName);
  const headers = await gateSetupHeaders(config, installationId, ENVIRONMENT_FALLBACK);

  const existing = await gateSetupFetch(
    `https://api.github.com/repos/${path}/environments/${environmentPath}`,
    { headers },
    ENVIRONMENT_FALLBACK,
  );
  if (existing.ok) return { step: "environment", status: "already_configured" };
  if (existing.status !== 404) {
    return failed(
      "environment",
      failureForStatus(existing.status, "repository administration access", ENVIRONMENT_FALLBACK),
    );
  }

  const unreadable = await actionsReadFailure(path, headers, "environment", ENVIRONMENT_FALLBACK);
  if (unreadable) return unreadable;

  const created = await gateSetupFetch(
    `https://api.github.com/repos/${path}/environments/${environmentPath}`,
    { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
    ENVIRONMENT_FALLBACK,
  );
  if (!created.ok) {
    return failed(
      "environment",
      failureForStatus(
        created.status,
        "repository administration access (needed to create an environment)",
        ENVIRONMENT_FALLBACK,
      ),
    );
  }
  return { step: "environment", status: "created" };
}

/**
 * Make Drydock the environment's custom deployment-protection rule.
 *
 * The rule is keyed by the App's numeric id, so the existing rules are read
 * first and an installation that already has Drydock enabled reports
 * `already_configured` rather than re-POSTing (GitHub 422s a duplicate).
 */
export async function enableDrydockProtectionRule(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  environmentName: string,
): Promise<GateSetupStepResult> {
  try {
    return await enableDrydockProtectionRuleWithGithub(
      config,
      installationId,
      fullName,
      environmentName,
    );
  } catch (err) {
    return transportFailure("protection_rule", err);
  }
}

async function enableDrydockProtectionRuleWithGithub(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
  environmentName: string,
): Promise<GateSetupStepResult> {
  const appId = Number(config.appId);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new GithubAppValidationError(
      "invalid_input",
      "GITHUB_APP_ID must be the numeric GitHub App id to enable a protection rule",
    );
  }
  const path = repositoryPath(fullName);
  const environmentPath = encodeURIComponent(environmentName);
  const rulesUrl = `https://api.github.com/repos/${path}/environments/${environmentPath}/deployment_protection_rules`;
  const headers = await gateSetupHeaders(config, installationId, PROTECTION_RULE_FALLBACK);

  const existing = await gateSetupFetch(rulesUrl, { headers }, PROTECTION_RULE_FALLBACK);
  if (existing.ok) {
    const data = (await existing.json().catch(() => ({}))) as {
      custom_deployment_protection_rules?: { app?: { id?: number } | null }[];
    };
    const enabled = (data.custom_deployment_protection_rules ?? []).some(
      (rule) => rule.app?.id === appId,
    );
    if (enabled) return { step: "protection_rule", status: "already_configured" };
  } else if (existing.status !== 404) {
    return failed(
      "protection_rule",
      failureForStatus(
        existing.status,
        "repository administration access",
        PROTECTION_RULE_FALLBACK,
      ),
    );
  }

  if (existing.status === 404) {
    const unreadable = await actionsReadFailure(
      path,
      headers,
      "protection_rule",
      PROTECTION_RULE_FALLBACK,
    );
    if (unreadable) return unreadable;
  }

  const created = await gateSetupFetch(
    rulesUrl,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      // Deliberately not retried: these POSTs create state, and a retried 5xx that
      // actually succeeded server-side would double-create.
      body: JSON.stringify({ integration_id: appId }),
    },
    PROTECTION_RULE_FALLBACK,
  );
  if (created.ok) return { step: "protection_rule", status: "created" };
  // GitHub answers a duplicate rule with 422. Re-read rather than trust the
  // message text, so "already enabled" stays a success in every locale/wording.
  if (created.status === 422) {
    const recheck = await gateSetupFetch(rulesUrl, { headers }, PROTECTION_RULE_FALLBACK);
    if (recheck.ok) {
      const data = (await recheck.json().catch(() => ({}))) as {
        custom_deployment_protection_rules?: { app?: { id?: number } | null }[];
      };
      const enabled = (data.custom_deployment_protection_rules ?? []).some(
        (rule) => rule.app?.id === appId,
      );
      if (enabled) return { step: "protection_rule", status: "already_configured" };
    }
  }
  return failed(
    "protection_rule",
    failureForStatus(
      created.status,
      "repository administration access (needed to add a deployment-protection rule)",
      PROTECTION_RULE_FALLBACK,
    ),
  );
}

export interface GateSetupPullRequestInput {
  repositoryFullName: string;
  environmentName: string;
  packageName: string;
  ecosystemLabel: string;
  workflowPath: string;
  yaml: string;
  notes: string[];
}

/**
 * Open a pull request that adds the generated gate workflow.
 *
 * Writing under `.github/workflows/` needs the App's `workflows: write`
 * permission, which most installations do not grant. That refusal arrives as a
 * 403 on the contents write (after the branch already exists), so it is mapped
 * to `workflow_scope_missing` and the wizard shows the copyable YAML instead.
 */
export async function openGateSetupPullRequest(
  config: GithubAppConfig,
  installationId: string,
  input: GateSetupPullRequestInput,
): Promise<GateSetupPullRequestResult> {
  try {
    return await openGateSetupPullRequestWithGithub(config, installationId, input);
  } catch (err) {
    return transportFailure("pull_request", err);
  }
}

async function openGateSetupPullRequestWithGithub(
  config: GithubAppConfig,
  installationId: string,
  input: GateSetupPullRequestInput,
): Promise<GateSetupPullRequestResult> {
  const path = repositoryPath(input.repositoryFullName);
  const manualFallback = `Add ${input.workflowPath} to the repository yourself — copy the workflow below and commit it on a branch.`;
  const headers = await gateSetupHeaders(config, installationId, manualFallback);
  const jsonHeaders = { ...headers, "content-type": "application/json" };

  const repoResponse = await gateSetupFetch(
    `https://api.github.com/repos/${path}`,
    { headers },
    manualFallback,
  );
  if (!repoResponse.ok) {
    return failed(
      "pull_request",
      failureForStatus(repoResponse.status, "repository contents access", manualFallback),
    );
  }
  const repoData = (await repoResponse.json().catch(() => ({}))) as { default_branch?: string };
  const baseBranch = typeof repoData.default_branch === "string" ? repoData.default_branch : "";
  if (!baseBranch) {
    return failed("pull_request", {
      code: "invalid_request",
      message: "GitHub did not report a default branch for this repository.",
      manualFallback,
    });
  }

  const refResponse = await gateSetupFetch(
    `https://api.github.com/repos/${path}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers },
    manualFallback,
  );
  if (!refResponse.ok) {
    return failed(
      "pull_request",
      failureForStatus(refResponse.status, "repository contents access", manualFallback),
    );
  }
  const refData = (await refResponse.json().catch(() => ({}))) as { object?: { sha?: string } };
  const baseSha = typeof refData.object?.sha === "string" ? refData.object.sha : "";
  if (!baseSha) {
    return failed("pull_request", {
      code: "invalid_request",
      message: `GitHub did not report a head commit for ${baseBranch}. An empty repository has nothing to branch from.`,
      manualFallback,
    });
  }

  // Random suffix so a retry after a partial failure never collides with the
  // branch the previous attempt left behind.
  const branch = `drydock/workflow-gate-${crypto.randomUUID().slice(0, 8)}`;
  const uncertainBranchFallback = `${manualFallback} If GitHub may have received the branch request, also check for ${branch}.`;
  const branchResponse = await gateSetupFetch(
    `https://api.github.com/repos/${path}/git/refs`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    },
    uncertainBranchFallback,
    () => deleteBranchQuietly(path, branch, headers),
  );
  if (!branchResponse.ok) {
    return failed(
      "pull_request",
      failureForStatus(branchResponse.status, "repository contents write access", manualFallback),
    );
  }

  /**
   * Every failure from here on abandons a branch that already exists on the
   * maintainer's repository. The `workflows: write` refusal below is the
   * *expected* outcome for most installations, so leaving a `drydock/*` ref
   * behind on each attempt would litter the repo exactly where the product is
   * asking for trust. Cleanup is best effort: a failed delete must not change
   * the failure the caller sees.
   */
  const abandon = async (failure: GateSetupFailure): Promise<GateSetupStepResult> => {
    await deleteBranchQuietly(path, branch, headers);
    return failed("pull_request", failure);
  };

  const contentsUrl = `https://api.github.com/repos/${path}/contents/${encodePathSegments(input.workflowPath)}`;
  const contentsResponse = await gateSetupFetch(
    contentsUrl,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        message: `Add Drydock-gated ${input.ecosystemLabel} release workflow`,
        content: base64Utf8(input.yaml),
        branch,
      }),
    },
    manualFallback,
    () => deleteBranchQuietly(path, branch, headers),
  );
  if (!contentsResponse.ok) {
    // The `workflows` permission refusal is the expected failure here, and it is
    // the one worth naming precisely: 403/404 on a `.github/workflows/` write.
    if (contentsResponse.status === 403 || contentsResponse.status === 404) {
      return abandon({
        code: "workflow_scope_missing",
        message:
          "The Drydock App installation cannot write files under .github/workflows/, so it cannot open this pull request.",
        manualFallback,
      });
    }
    if (contentsResponse.status === 422) {
      return abandon({
        code: "already_exists",
        message: `${input.workflowPath} already exists in this repository, so Drydock did not overwrite it.`,
        manualFallback: `Compare the workflow below against the existing ${input.workflowPath} and merge the gated publish job in by hand.`,
      });
    }
    return abandon(
      failureForStatus(contentsResponse.status, "workflow write access", manualFallback),
    );
  }

  const uncertainPullRequestFallback = `Check the repository's open pull requests for branch ${branch}, or add ${input.workflowPath} by hand from the workflow below.`;
  const prResponse = await gateSetupFetch(
    `https://api.github.com/repos/${path}/pulls`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        title: `Gate ${input.packageName} releases behind Drydock review`,
        head: branch,
        base: baseBranch,
        body: pullRequestBody(input),
      }),
    },
    uncertainPullRequestFallback,
  );
  if (!prResponse.ok) {
    return abandon(
      failureForStatus(prResponse.status, "pull request write access", manualFallback),
    );
  }
  const prData = (await prResponse.json().catch(() => ({}))) as {
    number?: number;
    html_url?: string;
  };
  // The pull request exists but Drydock cannot name it, so the branch is *not*
  // abandoned here: deleting it would close a PR the maintainer can still find.
  if (typeof prData.number !== "number" || typeof prData.html_url !== "string") {
    return failed("pull_request", {
      code: "invalid_request",
      message: "GitHub accepted the pull request but did not return its number or URL.",
      manualFallback: uncertainPullRequestFallback,
    });
  }
  return {
    step: "pull_request",
    status: "created",
    pullRequest: { number: prData.number, url: prData.html_url, branch },
  };
}

/**
 * The PR body: what the workflow does, plus the trusted-publishing hardening
 * checklist condensed from `docs/npm-trusted-publishing.md`. A reviewer reading
 * only this PR should be able to finish the lockdown without leaving GitHub.
 */
function pullRequestBody(input: GateSetupPullRequestInput): string {
  const notes = input.notes.map((note) => `- ${note}`).join("\n");
  return [
    `This adds \`${input.workflowPath}\`, a ${input.ecosystemLabel} release workflow whose publish job runs in the \`${input.environmentName}\` GitHub Environment.`,
    "",
    "Drydock is that environment's deployment-protection rule, so the publish job stays queued until the uploaded artifacts have been reviewed. The build job records `SHA256SUMS`; the publish job re-checks it with `sha256sum --check --strict` and fails closed if the bytes drifted from what was reviewed.",
    "",
    "### Finish the lockdown",
    "",
    "The gate is a checkpoint on one path. These make it the *only* credentialed publish path:",
    "",
    notes,
    "- Uncheck **Allow administrators to bypass configured protection rules** on the environment (it is on by default).",
    "- Restrict the environment's deployment branches/tags to your release branch or tag pattern.",
    "- Require `CODEOWNERS` review on `.github/workflows/` — the trusted publisher pins the workflow *path*, not its contents.",
    "",
    "### Review this PR like a release",
    "",
    "Drydock generated this file; it has not reviewed it. Read the workflow before merging.",
    "",
    "🤖 Opened by [Drydock](https://drydock.dev)",
  ].join("\n");
}

/**
 * Delete a branch the wizard created and could not use.
 *
 * Best effort by construction: a repository where the App can create a ref but
 * not delete one is possible, and the caller's failure — the one the maintainer
 * needs to read — must survive regardless.
 */
async function deleteBranchQuietly(
  path: string,
  branch: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const response = await reliableFetch(
      `https://api.github.com/repos/${path}/git/refs/heads/${encodePathSegments(branch)}`,
      { method: "DELETE", headers },
    );
    if (!response.ok && response.status !== 404) {
      emitOperationalEvent("warn", "github_app.gate_setup_branch_orphaned", {
        status: response.status,
      });
    }
  } catch {
    emitOperationalEvent("warn", "github_app.gate_setup_branch_orphaned", { status: 0 });
  }
}

/** Encode each path segment but keep `/` separators intact for the contents API. */
function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
