/**
 * One-click workflow-gate setup against the GitHub API.
 *
 * Everything a maintainer would otherwise do by hand in GitHub settings:
 * create the release environment, make Drydock its custom deployment-protection
 * rule, and open a pull request carrying the gated publish workflow.
 *
 * The installed App may not hold the permissions any given step needs
 * (`administration: write` for environments, `workflows: write` for a file
 * under `.github/workflows/`). That is the normal case, not an exception, so
 * every function here resolves to a typed `GateSetupStepResult` instead of
 * throwing: the wizard degrades each step independently to a manual fallback.
 * Only a broken installation (no token) still throws, and the route maps it.
 *
 * Nothing here logs a GitHub response body, header, or the installation token.
 */
import { getInstallationAccessToken } from "./api";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubInstallationHeaders } from "./http";
import { parseRepositoryFullName } from "./validation";
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

// A conservative allowlist shared by every identity that reaches a generated
// YAML document. npm (`@scope/name`), PyPI (PEP 503) and VS Code
// (`publisher.name`) identifiers all fit; anything that could break out of a
// double-quoted YAML scalar (quotes, backslashes, newlines, `${{ }}`) does not.
const PACKAGE_NAME_RE = /^[@A-Za-z0-9][A-Za-z0-9@._/-]{0,213}$/;
const ENVIRONMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export function assertGateSetupIdentity(packageName: string, environmentName: string): void {
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "packageName may only contain letters, digits, and @ . _ / -",
    );
  }
  if (!ENVIRONMENT_NAME_RE.test(environmentName)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "environment may only contain letters, digits, spaces, and . _ -",
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
  const path = repositoryPath(fullName);
  const environmentPath = encodeURIComponent(environmentName);
  const token = await getInstallationAccessToken(config, installationId);
  const headers = githubInstallationHeaders(token);

  const existing = await reliableFetch(
    `https://api.github.com/repos/${path}/environments/${environmentPath}`,
    { headers },
  );
  if (existing.ok) return { step: "environment", status: "already_configured" };
  if (existing.status !== 404) {
    return failed(
      "environment",
      failureForStatus(existing.status, "repository administration access", ENVIRONMENT_FALLBACK),
    );
  }

  const created = await reliableFetch(
    `https://api.github.com/repos/${path}/environments/${environmentPath}`,
    { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
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
  const token = await getInstallationAccessToken(config, installationId);
  const headers = githubInstallationHeaders(token);

  const existing = await reliableFetch(rulesUrl, { headers });
  if (existing.ok) {
    const data = (await existing.json().catch(() => ({}))) as {
      custom_deployment_protection_rules?: { app?: { integration_id?: number } | null }[];
    };
    const enabled = (data.custom_deployment_protection_rules ?? []).some(
      (rule) => rule.app?.integration_id === appId,
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

  const created = await reliableFetch(rulesUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    // Deliberately not retried: these POSTs create state, and a retried 5xx that
    // actually succeeded server-side would double-create.
    body: JSON.stringify({ integration_id: appId }),
  });
  if (created.ok) return { step: "protection_rule", status: "created" };
  // GitHub answers a duplicate rule with 422. Re-read rather than trust the
  // message text, so "already enabled" stays a success in every locale/wording.
  if (created.status === 422) {
    const recheck = await reliableFetch(rulesUrl, { headers });
    if (recheck.ok) {
      const data = (await recheck.json().catch(() => ({}))) as {
        custom_deployment_protection_rules?: { app?: { integration_id?: number } | null }[];
      };
      const enabled = (data.custom_deployment_protection_rules ?? []).some(
        (rule) => rule.app?.integration_id === appId,
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
  const path = repositoryPath(input.repositoryFullName);
  const token = await getInstallationAccessToken(config, installationId);
  const headers = githubInstallationHeaders(token);
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const manualFallback = `Add ${input.workflowPath} to the repository yourself — copy the workflow below and commit it on a branch.`;

  const repoResponse = await reliableFetch(`https://api.github.com/repos/${path}`, { headers });
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

  const refResponse = await reliableFetch(
    `https://api.github.com/repos/${path}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers },
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
  const branchResponse = await reliableFetch(`https://api.github.com/repos/${path}/git/refs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!branchResponse.ok) {
    return failed(
      "pull_request",
      failureForStatus(branchResponse.status, "repository contents write access", manualFallback),
    );
  }

  const contentsUrl = `https://api.github.com/repos/${path}/contents/${encodePathSegments(input.workflowPath)}`;
  const contentsResponse = await reliableFetch(contentsUrl, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      message: `Add Drydock-gated ${input.ecosystemLabel} release workflow`,
      content: base64Utf8(input.yaml),
      branch,
    }),
  });
  if (!contentsResponse.ok) {
    // The `workflows` permission refusal is the expected failure here, and it is
    // the one worth naming precisely: 403/404 on a `.github/workflows/` write.
    if (contentsResponse.status === 403 || contentsResponse.status === 404) {
      return failed("pull_request", {
        code: "workflow_scope_missing",
        message:
          "The Drydock App installation cannot write files under .github/workflows/, so it cannot open this pull request.",
        manualFallback,
      });
    }
    if (contentsResponse.status === 422) {
      return failed("pull_request", {
        code: "already_exists",
        message: `${input.workflowPath} already exists in this repository, so Drydock did not overwrite it.`,
        manualFallback: `Compare the workflow below against the existing ${input.workflowPath} and merge the gated publish job in by hand.`,
      });
    }
    return failed(
      "pull_request",
      failureForStatus(contentsResponse.status, "workflow write access", manualFallback),
    );
  }

  const prResponse = await reliableFetch(`https://api.github.com/repos/${path}/pulls`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      title: `Gate ${input.packageName} releases behind Drydock review`,
      head: branch,
      base: baseBranch,
      body: pullRequestBody(input),
    }),
  });
  if (!prResponse.ok) {
    return failed(
      "pull_request",
      failureForStatus(prResponse.status, "pull request write access", manualFallback),
    );
  }
  const prData = (await prResponse.json().catch(() => ({}))) as {
    number?: number;
    html_url?: string;
  };
  if (typeof prData.number !== "number" || typeof prData.html_url !== "string") {
    return failed("pull_request", {
      code: "invalid_request",
      message: "GitHub accepted the pull request but did not return its number or URL.",
      manualFallback,
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
