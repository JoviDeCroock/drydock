/**
 * Shared plumbing for the GitHub App routes.
 *
 * Ownership checks and error translation used by more than one resource
 * group. `ensureInstallationOwnedBy` is the org-scoping gate: an installation
 * row is only ever reachable by the organization that connected it.
 */
import type { Context } from "hono";
import {
  GithubAppConfigError,
  type GithubAppValidationCode,
  GithubAppValidationError,
} from "../../lib/github-app/config";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import type { Bindings, Variables } from "../../types";
import { createDb } from "../../db/client";
import { listInstallationsForOrganization } from "../../lib/github-app/persistence";

export type RouteContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export async function ensureInstallationOwnedBy(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  installationRowId: string,
) {
  const installations = await listInstallationsForOrganization(db, organizationId);
  const match = installations.find((row) => row.id === installationRowId);
  if (!match) {
    throw new GithubAppValidationError(
      "installation_missing",
      "no GitHub App installation matches this organization",
    );
  }
  if (match.status !== "active") {
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation ${match.installationId} is ${match.status}`,
    );
  }
  return match;
}

export function configErrorResponse(c: RouteContext, err: unknown) {
  if (err instanceof GithubAppConfigError) {
    return c.json({ error: err.message, code: "github_app_not_configured" }, 503);
  }
  throw err;
}

export function validationErrorResponse(c: RouteContext, err: unknown) {
  if (err instanceof GithubAppValidationError) {
    return c.json({ error: err.message, code: err.code }, statusForCode(err.code));
  }
  emitOperationalEvent("error", "github_app.route_error", {
    error: describeOperationalError(err),
  });
  return c.json({ error: "internal error" }, 500);
}

function statusForCode(code: GithubAppValidationCode): 400 | 403 | 404 | 409 {
  switch (code) {
    case "installation_missing":
      return 404;
    case "installation_not_authorized":
      return 403;
    case "installation_inactive":
      return 409;
    case "repository_not_accessible":
      return 403;
    case "environment_already_mapped":
      return 409;
    case "environment_unmapped":
    case "unsupported_ecosystem":
    case "invalid_input":
      return 400;
  }
}
