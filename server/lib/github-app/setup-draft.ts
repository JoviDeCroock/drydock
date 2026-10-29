import { z } from "zod";
import { validSetupSha, validSetupWorkflowPath, validSetupEnvironment } from "./setup-api";
import { normalizeGithubEnvironmentName, parseRepositoryFullName } from "./validation";
import { SETUP_ARTIFACT_NAMES, type PublisherSetupProposal } from "./setup-types";

const text = z.string().min(1);
export const setupDraftRequestSchema = z
  .object({
    installationRowId: text.max(100),
    repositoryFullName: text.max(140).refine((value) => Boolean(parseRepositoryFullName(value))),
    workflowPath: text.refine(validSetupWorkflowPath),
    baseSha: text.refine(validSetupSha),
    environment: text
      .max(255)
      .transform(normalizeGithubEnvironmentName)
      .refine(validSetupEnvironment),
    ecosystem: z.enum(["npm", "pypi", "vscode"]),
  })
  .strict();
export function setupManualSteps(
  proposal: Pick<PublisherSetupProposal, "repositoryFullName" | "environment" | "ecosystem">,
): string[] {
  return [
    "Review every workflow and script change in GitHub before merging; generated code requires maintainer review.",
    `Create the ${proposal.environment} GitHub Environment and enable the installed Drydock custom deployment-protection rule. Disable administrator bypass if your policy requires it.`,
    `Map ${proposal.repositoryFullName} / ${proposal.environment} as a Drydock release target using the ${SETUP_ARTIFACT_NAMES[proposal.ecosystem]} artifact.`,
    "If your policy requires actions pinned to commit SHAs, pin the artifact upload and download actions before merging.",
    "The setup commit includes [skip ci], so push and pull_request workflows do not run for it. If this repository requires status checks, push another commit or re-run checks before merging.",
    "Keep registry trusted-publishing/OIDC bound to the protected environment and ensure the publish job never rebuilds the reviewed artifact.",
    "Run your next release, complete its review in Drydock, then refresh setup checks. Other workflows and manual publishing paths remain independent.",
  ];
}
