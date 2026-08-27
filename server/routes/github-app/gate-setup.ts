/**
 * The guided workflow-gate setup wizard's backend.
 *
 * Gate onboarding used to be ~10 manual steps split across Drydock, GitHub
 * settings, and static docs. These endpoints do the GitHub-side ones with the
 * installation token: create the environment, make Drydock its
 * deployment-protection rule, and open a pull request carrying the generated
 * publish workflow.
 *
 * Each step is its own endpoint and each response carries a
 * `GateSetupStepResult`, because the steps fail independently: an installation
 * may grant repository administration but not `workflows: write`, or the other
 * way round. A failed step is a 200 with `status: "failed"` and an actionable
 * failure — the wizard renders the manual fallback inline rather than dead-ending.
 *
 * The workflow YAML itself is never written here: it comes from the ecosystem's
 * gate adapter via the registry (`gateSetupTemplate`), so this file stays
 * ecosystem-generic.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { requireActiveOrganizationContext } from "../../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../../lib/auth/roles";
import { getEcosystem, supportedWorkflowGateEcosystems } from "../../lib/ecosystems";
import {
  assertGateSetupEnvironment,
  assertGateSetupPackageName,
  createRepositoryEnvironment,
  enableDrydockProtectionRule,
  openGateSetupPullRequest,
} from "../../lib/github-app/gate-setup";
import {
  type GithubAppConfig,
  GithubAppValidationError,
  readGithubAppConfig,
} from "../../lib/github-app/config";
import {
  normalizeGithubEnvironmentName,
  parseRepositoryFullName,
} from "../../lib/github-app/validation";
import { rateLimitResponse } from "../../lib/platform/http";
import { RateLimitError, enforceRateLimit } from "../../lib/platform/rate-limit";
import type { GateSetupTemplate } from "../../lib/workflow-gates/types";
import type { Bindings, Variables } from "../../types";
import {
  type RouteContext,
  ensureInstallationOwnedBy,
  configErrorResponse,
  validationErrorResponse,
} from "./shared";

export const gateSetupRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// The preview is pure computation, so it is limited only to keep a logged-in
// caller from using it as a scratch CPU. The two GitHub-mutating steps share the
// release-target budget; opening pull requests is tighter still because each one
// leaves a branch and a notification behind.
const PREVIEW_LIMIT = 120;
const PREVIEW_WINDOW_MS = 60 * 1000;
const MUTATION_LIMIT = 30;
const MUTATION_WINDOW_MS = 60 * 60 * 1000;
const PULL_REQUEST_LIMIT = 10;
const PULL_REQUEST_WINDOW_MS = 60 * 60 * 1000;

interface GateSetupDraft {
  installationRowId: string;
  repositoryFullName: string;
  environment: string;
  ecosystem: string;
  packageName: string;
}

/**
 * Read the wizard's draft off the request body.
 *
 * `ecosystem`/`packageName` only matter to the template steps, so they are
 * validated but may be blank for the environment/protection-rule steps.
 */
function readDraft(body: Record<string, unknown>): GateSetupDraft {
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    installationRowId: str(body.installationRowId),
    repositoryFullName: str(body.repositoryFullName),
    environment: normalizeGithubEnvironmentName(str(body.environment)),
    ecosystem: str(body.ecosystem),
    packageName: str(body.packageName),
  };
}

/**
 * Fail the whole draft before any step touches GitHub.
 *
 * The environment and protection-rule steps mutate GitHub irreversibly and do
 * not need a workflow template, so they used to skip the identity allowlist
 * entirely — a name only the template step rejects would create an environment
 * and a protection rule and *then* 400. The identity asserts therefore run here,
 * for every endpoint, not at template time.
 */
function validateDraft(draft: GateSetupDraft, requireTemplate: boolean): string | null {
  if (!draft.installationRowId) return "installationRowId is required";
  if (!draft.repositoryFullName) return "repositoryFullName is required";
  if (!parseRepositoryFullName(draft.repositoryFullName)) {
    return "repositoryFullName must be in owner/repo form";
  }
  if (!draft.environment) return "environment is required";
  if (requireTemplate) {
    if (!draft.ecosystem) return "ecosystem is required";
    if (!draft.packageName) return "packageName is required";
  }
  assertGateSetupEnvironment(draft.environment);
  if (draft.packageName) assertGateSetupPackageName(draft.packageName);
  return null;
}

/**
 * Resolve the ecosystem's generated workflow through the registry.
 *
 * An ecosystem without a `gateSetupTemplate` is a 400, not a crash: the wizard
 * falls back to the documented manual workflow shapes for it.
 */
function resolveTemplate(draft: GateSetupDraft): GateSetupTemplate {
  const template = getEcosystem(draft.ecosystem)?.gate?.gateSetupTemplate;
  if (!template) {
    throw new GithubAppValidationError(
      "unsupported_ecosystem",
      `no gate setup template for ecosystem ${draft.ecosystem}; supported: ${supportedWorkflowGateEcosystems().join(", ")}`,
    );
  }
  // Identity is already allowlisted by `validateDraft`, so adapters may
  // interpolate both values straight into the emitted YAML.
  return template({ environmentName: draft.environment, packageName: draft.packageName });
}

function ecosystemLabel(ecosystem: string): string {
  return getEcosystem(ecosystem)?.label ?? ecosystem;
}

/**
 * Everything every gate-setup endpoint needs before it touches GitHub: an
 * owner/admin of the active organization, a validated draft, a configured App,
 * an installation this organization owns, and rate-limit headroom.
 */
async function prepare(
  c: RouteContext,
  options: { requireTemplate: boolean; limit: number; windowMs: number; scope: string },
) {
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    return { response: configErrorResponse(c, err) } as const;
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const draft = readDraft(body);
  // Throws `GithubAppValidationError` for a disallowed identity; the caller's
  // try/catch maps it to a 400 with an `invalid_input` code.
  const invalid = validateDraft(draft, options.requireTemplate);
  if (invalid) return { response: c.json({ error: invalid }, 400) } as const;

  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) {
    return { response: c.json({ error: "forbidden" }, 403) } as const;
  }

  try {
    await enforceRateLimit(c.env, {
      key: `github-app:gate-setup:${options.scope}:${organizationId}`,
      limit: options.limit,
      windowMs: options.windowMs,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        response: rateLimitResponse(c, "gate setup rate limit exceeded", err),
      } as const;
    }
    throw err;
  }

  const installation = await ensureInstallationOwnedBy(db, organizationId, draft.installationRowId);
  return { config, draft, installation } as const;
}

gateSetupRoutes.post("/gate-setup/preview", async (c) => {
  try {
    const prepared = await prepare(c, {
      requireTemplate: true,
      limit: PREVIEW_LIMIT,
      windowMs: PREVIEW_WINDOW_MS,
      scope: "preview",
    });
    if ("response" in prepared) return prepared.response;
    const { draft } = prepared;
    const template = resolveTemplate(draft);
    return c.json({
      ecosystem: draft.ecosystem,
      ecosystemLabel: ecosystemLabel(draft.ecosystem),
      environment: draft.environment,
      packageName: draft.packageName,
      workflowPath: template.workflowPath,
      yaml: template.yaml,
      notes: template.notes,
    });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

gateSetupRoutes.post("/gate-setup/environment", async (c) => {
  try {
    const prepared = await prepare(c, {
      requireTemplate: false,
      limit: MUTATION_LIMIT,
      windowMs: MUTATION_WINDOW_MS,
      scope: "environment",
    });
    if ("response" in prepared) return prepared.response;
    const { config, draft, installation } = prepared;
    const step = await createRepositoryEnvironment(
      config,
      installation.installationId,
      draft.repositoryFullName,
      draft.environment,
    );
    return c.json({ step });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

gateSetupRoutes.post("/gate-setup/protection-rule", async (c) => {
  try {
    const prepared = await prepare(c, {
      requireTemplate: false,
      limit: MUTATION_LIMIT,
      windowMs: MUTATION_WINDOW_MS,
      scope: "protection-rule",
    });
    if ("response" in prepared) return prepared.response;
    const { config, draft, installation } = prepared;
    const step = await enableDrydockProtectionRule(
      config,
      installation.installationId,
      draft.repositoryFullName,
      draft.environment,
    );
    return c.json({ step });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});

gateSetupRoutes.post("/gate-setup/pull-request", async (c) => {
  try {
    const prepared = await prepare(c, {
      requireTemplate: true,
      limit: PULL_REQUEST_LIMIT,
      windowMs: PULL_REQUEST_WINDOW_MS,
      scope: "pull-request",
    });
    if ("response" in prepared) return prepared.response;
    const { config, draft, installation } = prepared;
    const template = resolveTemplate(draft);
    const result = await openGateSetupPullRequest(config, installation.installationId, {
      repositoryFullName: draft.repositoryFullName,
      environmentName: draft.environment,
      packageName: draft.packageName,
      ecosystemLabel: ecosystemLabel(draft.ecosystem),
      workflowPath: template.workflowPath,
      yaml: template.yaml,
      notes: template.notes,
    });
    const { pullRequest, ...step } = result;
    // The YAML rides along with every response: when the PR step fails the
    // wizard needs exactly these bytes for the copy-it-yourself fallback.
    return c.json({
      step,
      pullRequest: pullRequest ?? null,
      workflowPath: template.workflowPath,
      yaml: template.yaml,
      notes: template.notes,
    });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});
