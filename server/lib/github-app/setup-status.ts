import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDb } from "../../db/client";
import { githubWorkflowGates, scans } from "../../db/schema";
import type { GithubAppConfig, SupportedEcosystem } from "./config";
import { listReleaseTargetsForOrganization } from "./persistence";
import type { SetupGithubClient } from "./setup-api";
import { readEnvironmentProtection } from "./protection-health";
import { SETUP_ARTIFACT_NAMES, type PublisherSetupStatus } from "./setup-types";

export async function publisherSetupStatus(
  db: AppDb,
  config: GithubAppConfig,
  client: SetupGithubClient,
  organizationId: string,
  installationRowId: string,
  environment: string,
  ecosystem: SupportedEcosystem,
): Promise<PublisherSetupStatus> {
  const targets = await listReleaseTargetsForOrganization(db, organizationId);
  const selectedTarget = targets.find(
    (target) =>
      target.installationRowId === installationRowId &&
      target.repositoryId === client.repository.id &&
      target.environment === environment &&
      target.ecosystem === ecosystem &&
      target.artifactName === SETUP_ARTIFACT_NAMES[ecosystem],
  );
  const targetMapped = Boolean(selectedTarget);
  const { environmentExists, protectionEnabled, administratorsCanBypass } =
    await readEnvironmentProtection(client, environment, config.appId);
  const scope = and(
    eq(githubWorkflowGates.organizationId, organizationId),
    eq(githubWorkflowGates.installationRowId, installationRowId),
    eq(githubWorkflowGates.repositoryId, client.repository.id),
    eq(githubWorkflowGates.environment, environment),
    eq(githubWorkflowGates.releaseTargetId, selectedTarget?.id ?? ""),
  );
  const select = {
    gateId: githubWorkflowGates.id,
    scanId: scans.id,
    status: githubWorkflowGates.status,
    scanStatus: scans.status,
    requestedAt: githubWorkflowGates.requestedAt,
    completedAt: scans.completedAt,
  };
  const [completed] = await db
    .select(select)
    .from(githubWorkflowGates)
    .innerJoin(
      scans,
      and(
        eq(scans.id, githubWorkflowGates.scanId),
        eq(scans.organizationId, organizationId),
        eq(scans.gateId, githubWorkflowGates.id),
        eq(scans.source, "workflow_gate"),
      ),
    )
    .where(and(scope, eq(scans.status, "complete")))
    .orderBy(asc(scans.completedAt))
    .limit(1);
  const [latest] = completed
    ? []
    : await db
        .select(select)
        .from(githubWorkflowGates)
        .leftJoin(
          scans,
          and(
            eq(scans.id, githubWorkflowGates.scanId),
            eq(scans.organizationId, organizationId),
            eq(scans.gateId, githubWorkflowGates.id),
            eq(scans.source, "workflow_gate"),
          ),
        )
        .where(scope)
        .orderBy(desc(githubWorkflowGates.requestedAt))
        .limit(1);
  const review = completed ?? latest;
  const firstReview = review
    ? {
        ...review,
        requestedAt: review.requestedAt.toISOString(),
        completedAt: review.completedAt?.toISOString() ?? null,
      }
    : null;
  return {
    repositoryFullName: client.repository.fullName,
    environment,
    targetMapped,
    environmentExists,
    protectionEnabled,
    administratorsCanBypass,
    firstReview,
    checks: [
      {
        label: "Release target",
        status: targetMapped ? "passed" : "pending",
        detail: targetMapped
          ? "This repository and environment are mapped in this organization."
          : "Map the selected ecosystem and artifact as a release target. If this repository and environment already have another mapping, remove the existing mapping below before mapping the selected artifact.",
      },
      {
        label: "GitHub Environment",
        status: environmentExists ? "passed" : "pending",
        detail: environmentExists
          ? "The selected environment exists."
          : "Create the selected environment in GitHub repository settings.",
      },
      {
        label: "Drydock protection rule",
        status: protectionEnabled ? "passed" : "pending",
        detail: protectionEnabled
          ? "This Drydock App is enabled as a custom protection rule."
          : "Enable the installed Drydock App's custom protection rule on this environment.",
      },
      {
        label: "Administrator bypass",
        status:
          administratorsCanBypass === false
            ? "passed"
            : administratorsCanBypass === null
              ? "unknown"
              : "pending",
        detail:
          administratorsCanBypass === false
            ? "Administrator bypass is disabled."
            : administratorsCanBypass === null
              ? "GitHub did not report whether administrators can bypass protection."
              : "GitHub administrators can bypass this environment's protection rules.",
      },
      {
        label: "First release review",
        status: firstReview?.scanStatus === "complete" ? "passed" : "pending",
        detail:
          firstReview?.scanStatus === "complete"
            ? "A real workflow-gated release completed review in this organization."
            : firstReview
              ? "A workflow gate was observed; its release review has not completed."
              : "Run a real release through the configured protected job, then refresh these checks.",
      },
    ],
  };
}
