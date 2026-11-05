import type { PublisherSetupStatus } from "../../../server/lib/github-app/setup-types";

/**
 * Plain-text copy of the setup checks for a maintainer to paste into a coding
 * agent. The setup-agent prompts on /agents ask for exactly this, because
 * Drydock has no agent-callable setup API: the session-bound checks reach the
 * agent only through the maintainer.
 */
export function setupStatusAgentSummary(status: PublisherSetupStatus): string {
  const passed = status.checks.filter((check) => check.status === "passed").length;
  const lines = [
    `Drydock setup checks for ${status.repositoryFullName}, environment ${status.environment}`,
    `${passed} of ${status.checks.length} passed.`,
    "",
    ...status.checks.map((check) => `- ${check.label}: ${check.status}. ${check.detail}`),
  ];
  lines.push(
    "",
    status.checks.every((check) => check.status === "passed")
      ? "Setup is complete: a real release was reviewed before publication."
      : "Setup is not complete. Report it as ready, pending first release, until every check passes.",
  );
  return lines.join("\n");
}
