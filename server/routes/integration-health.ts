import { Hono } from "hono";
import { createDb, getNpmConnection } from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import {
  listInstallationsForOrganization,
  listReleaseTargetsForOrganization,
} from "../lib/github-app";
import type { Bindings, Variables } from "../types";

export type IntegrationHealthKind = "npm_token" | "github_installation";

export interface IntegrationHealthIssue {
  kind: IntegrationHealthKind;
  severity: "critical" | "warn";
  title: string;
  detail: string;
  occurredAt: string | null;
}

export interface IntegrationHealthResponse {
  issues: IntegrationHealthIssue[];
}

export const integrationHealthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

integrationHealthRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);

  const [connection, installations, releaseTargets] = await Promise.all([
    getNpmConnection(db, organizationId),
    listInstallationsForOrganization(db, organizationId),
    listReleaseTargetsForOrganization(db, organizationId),
  ]);

  const issues: IntegrationHealthIssue[] = [];

  if (connection && connection.validationStatus === "invalid") {
    issues.push({
      kind: "npm_token",
      severity: "critical",
      title: "npm token stopped working",
      detail: connection.lastFailureReason ?? "The organization's npm token is no longer valid.",
      occurredAt: toIso(connection.invalidatedAt),
    });
  }

  const gatedInstallationRowIds = new Set(releaseTargets.map((target) => target.installationRowId));

  for (const installation of installations) {
    if (installation.lastFailureAt) {
      issues.push({
        kind: "github_installation",
        severity: "critical",
        title: `GitHub App for ${installation.accountLogin} stopped working`,
        detail: installation.lastFailureReason ?? "The GitHub App installation stopped working.",
        occurredAt: toIso(installation.lastFailureAt),
      });
      continue;
    }
    // A configured gate whose installation was disabled on GitHub: surface it so
    // the operator knows PyPI gating is paused. Unconfigured installs are quiet.
    if (installation.status !== "active" && gatedInstallationRowIds.has(installation.id)) {
      issues.push({
        kind: "github_installation",
        severity: installation.status === "uninstalled" ? "critical" : "warn",
        title: `GitHub App for ${installation.accountLogin} is ${installation.status}`,
        detail:
          installation.status === "uninstalled"
            ? "The installation was removed on GitHub — re-install to resume PyPI gating."
            : "Re-enable the installation on GitHub to resume PyPI gating.",
        occurredAt: null,
      });
    }
  }

  return c.json({ issues } satisfies IntegrationHealthResponse);
});

function toIso(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
