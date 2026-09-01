/**
 * The guided workflow-gate setup wizard's backend.
 *
 * Two endpoints, both read-only. `preview` renders the ecosystem's publish
 * workflow for a draft; `verify` reads back what GitHub actually has. The
 * wizard sends the maintainer to GitHub for every mutation, so Drydock needs no
 * write permission on the repository it is protecting — see
 * `server/lib/github-app/gate-setup.ts` for why that is a deliberate posture
 * rather than a missing feature.
 *
 * Verification is what makes the wizard's "gate armed" claim true: it is a read
 * of GitHub's live state, not a record of what Drydock believes it did, so it
 * also catches a rule that was turned off later.
 *
 * The workflow YAML is never written here: it comes from the ecosystem's gate
 * adapter via the registry (`gateSetupTemplate`), so this file stays
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
  readGateSetupState,
} from "../../lib/github-app/gate-setup";
import {
  type GithubAppConfig,
  GithubAppValidationError,
  readGithubAppConfig,
} from "../../lib/github-app/config";
import { parseRepositoryFullName } from "../../lib/github-app/validation";
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
// caller from using it as a scratch CPU. Verification fans out to GitHub reads,
// so it shares the budget the other GitHub proxy reads use.
const PREVIEW_LIMIT = 120;
const PREVIEW_WINDOW_MS = 60 * 1000;
const VERIFY_LIMIT = 60;
const VERIFY_WINDOW_MS = 60 * 1000;

interface GateSetupDraft {
  installationRowId: string;
  repositoryFullName: string;
  environment: string;
  ecosystem: string;
  packageName: string;
}

function readDraft(body: Record<string, unknown>): GateSetupDraft {
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    installationRowId: str(body.installationRowId),
    repositoryFullName: str(body.repositoryFullName),
    // GitHub lowercases environment names; normalizing here keeps the verify
    // read pointed at the name that actually exists.
    environment: str(body.environment).toLowerCase(),
    ecosystem: str(body.ecosystem),
    packageName: str(body.packageName),
  };
}

/**
 * `requireTemplate` separates the two endpoints' contracts.
 *
 * Only the preview interpolates identities into YAML, so only the preview
 * applies the `GATE_SETUP_*_RE` allowlists. Verification accepts any
 * environment name GitHub accepted, because an environment created before
 * Drydock — or by hand, with a slash in it — still has to be checkable.
 */
function validateDraft(draft: GateSetupDraft, requireTemplate: boolean): string | null {
  if (!draft.installationRowId) return "installationRowId is required";
  if (!draft.repositoryFullName) return "repositoryFullName is required";
  if (!parseRepositoryFullName(draft.repositoryFullName)) {
    return "repositoryFullName must be in owner/repo form";
  }
  if (!draft.environment) return "environment is required";
  if (draft.environment.length > 255) return "environment is too long";
  if (requireTemplate) {
    if (!draft.ecosystem) return "ecosystem is required";
    if (!draft.packageName) return "packageName is required";
    assertGateSetupEnvironment(draft.environment);
    assertGateSetupPackageName(draft.packageName);
  }
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

/**
 * Everything both endpoints need before they touch GitHub: an owner/admin of
 * the active organization, a validated draft, a configured App, an installation
 * this organization owns, and rate-limit headroom.
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
      ecosystemLabel: getEcosystem(draft.ecosystem)?.label ?? draft.ecosystem,
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

gateSetupRoutes.post("/gate-setup/verify", async (c) => {
  try {
    const prepared = await prepare(c, {
      requireTemplate: false,
      limit: VERIFY_LIMIT,
      windowMs: VERIFY_WINDOW_MS,
      scope: "verify",
    });
    if ("response" in prepared) return prepared.response;
    const { config, draft, installation } = prepared;
    const state = await readGateSetupState(
      config,
      installation.installationId,
      draft.repositoryFullName,
      draft.environment,
    );
    return c.json({ state });
  } catch (err) {
    return validationErrorResponse(c, err);
  }
});
