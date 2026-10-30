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
/** GitHub renders no mentions, links or closing keywords inside a code span. */
export function markdownCodeSpan(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Pass `markdownCodeSpan` as `quote` when the steps are rendered as Markdown, as in the PR body. */
export function setupManualSteps(
  proposal: Pick<PublisherSetupProposal, "repositoryFullName" | "environment" | "ecosystem">,
  quote: (value: string) => string = (value) => value,
): string[] {
  const environment = quote(proposal.environment);
  return [
    "Review every workflow and script change in GitHub before merging; generated code requires maintainer review.",
    `Create the ${environment} GitHub Environment and enable the installed Drydock custom deployment-protection rule. Disable administrator bypass if your policy requires it.`,
    `Map ${quote(proposal.repositoryFullName)} / ${environment} as a Drydock release target using the ${SETUP_ARTIFACT_NAMES[proposal.ecosystem]} artifact.`,
    "If your policy requires actions pinned to commit SHAs, pin the artifact upload and download actions before merging.",
    "The setup commit includes [skip ci], so CI does not run for it. Only after reviewing every file in this pull request, push a commit or re-run checks so CI runs.",
    `Bind the registry's trusted publisher (OIDC) to the ${environment} environment. If it currently names another environment, update it on the registry before releasing, or publishing fails. Ensure the publish job never rebuilds the reviewed artifact.`,
    "Run your next release, complete its review in Drydock, then refresh setup checks. Other workflows and manual publishing paths remain independent.",
  ];
}
